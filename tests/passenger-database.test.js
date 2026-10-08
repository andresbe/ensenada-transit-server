const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { migrate } = require("../scripts/migration-runner");
process.env.JWT_SECRET = "database-tests-only";

test("migrations and passenger APIs on isolated PostgreSQL WASM", async (t) => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const execute = async (sql, params) =>
    params ? pg.query(sql, params) : ((await pg.exec(sql)).at(-1) ?? { rows: [] });
  const client = { query: execute, release() {} };
  const directory = path.join(__dirname, "../src/db/migrations");
  await migrate(client, directory, () => {});
  await migrate(client, directory, () => {});
  const journal = await pg.query("SELECT count(*)::int AS count FROM schema_migrations");
  assert.equal(
    journal.rows[0].count,
    require("node:fs")
      .readdirSync(directory)
      .filter((f) => f.endsWith(".sql")).length,
  );
  const db = require("../dist/db"),
    cache = require("../dist/redis/cache");
  const originalQuery = db.query,
    originalClient = db.getClient;
  db.query = execute;
  db.getClient = async () => client;
  cache.incrementRateLimit = async () => 0;
  cache.invalidateRoutesCache = async () => {};
  cache.invalidateRouteCache = async () => {};
  cache.invalidateVariantCache = async () => {};
  const express = require("express"),
    jwt = require("jsonwebtoken");
  const app = express();
  app.use(express.json());
  app.use(require("../dist/passengers/catalog.routes").catalogRouter);
  app.use(require("../dist/passengers/passengers.routes").passengerRouter);
  app.use(require("../dist/passengers/notifications.routes").notificationsRouter);
  app.use("/reports", require("../dist/reports/reports.routes").reportsRouter);
  app.use(require("../dist/shared/errors").errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.getClient = originalClient;
    await pg.close();
  });
  const owner = (await pg.query("INSERT INTO users(auth_provider) VALUES('guest') RETURNING id"))
    .rows[0].id;
  const other = (await pg.query("INSERT INTO users(auth_provider) VALUES('guest') RETURNING id"))
    .rows[0].id;
  const route = (
    await pg.query("INSERT INTO routes(name,short_name) VALUES('Local Test','T') RETURNING id")
  ).rows[0].id;
  const variant = (
    await pg.query(
      "INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'Test outbound','ida',$2::jsonb) RETURNING id",
      [
        route,
        JSON.stringify([
          [-116.6, 31.8],
          [-116.61, 31.81],
        ]),
      ],
    )
  ).rows[0].id;
  const call = (url, method = "GET", body, who = owner) =>
    fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt.sign({ sub: who, role: "user" }, process.env.JWT_SECRET)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  await t.test("favorite route quota preserves retries and frees a slot after deletion", async () => {
    const ids=[];
    for(let i=0;i<3;i++) {
      const response=await call("/saved-journeys","POST",{route_id:route,client_id:"quota-"+i});
      assert.equal(response.status,201);
      ids.push((await response.json()).favorite.id);
    }
    const denied=await call("/saved-journeys","POST",{route_id:route,client_id:"quota-four"});
    assert.equal(denied.status,409);
    assert.equal((await denied.json()).error.details.limit,3);
    const retry=await call("/saved-journeys","POST",{route_id:route,client_id:"quota-0"});
    assert.equal((await retry.json()).favorite.id,ids[0]);
    await call("/saved-journeys/"+ids.shift(),"DELETE");
    const replacement=await call("/saved-journeys","POST",{route_id:route,client_id:"quota-four"});
    assert.equal(replacement.status,201);
    ids.push((await replacement.json()).favorite.id);
    for(const id of ids)await call("/saved-journeys/"+id,"DELETE");
  });
  await t.test("catalog is one valid numeric snapshot", async () => {
    const response = await call("/catalog");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.routes[0].id, route);
    assert.equal(data.variants[0].coordinates[0][0], -116.6);
    assert.equal(data.schema_version, 1);
  });
  await t.test("favorite is idempotent and isolated by account", async () => {
    const body = {
      route_id: route,
      variant_id: variant,
      client_id: "one",
      destination_title: "Test",
      destination_latitude: 31.81,
      destination_longitude: -116.61,
    };
    const first = await call("/saved-journeys", "POST", body);
    assert.equal(first.status, 201);
    const id = (await first.json()).favorite.id;
    assert.equal((await (await call("/saved-journeys", "POST", body)).json()).favorite.id, id);
    await call("/saved-journeys/" + id, "DELETE", undefined, other);
    assert.equal((await (await call("/saved-journeys")).json()).favorites.length, 1);
    assert.equal(
      (await (await call("/saved-journeys", "GET", undefined, other)).json()).favorites.length,
      0,
    );
    await call("/saved-journeys/" + id, "DELETE");
    assert.equal((await (await call("/saved-journeys")).json()).favorites.length, 0);
    await assert.rejects(
      pg.query(
        "INSERT INTO saved_journeys(user_id,route_id,destination_latitude,client_id) VALUES($1,$2,12,$3)",
        [owner, route, "invalid"],
      ),
      /check constraint/,
    );
  });
  await t.test("trip retry and completion are atomic and owner scoped", async () => {
    const response = await call("/trips", "POST", {
      route_id: route,
      variant_id: variant,
      client_id: "trip-one",
    });
    assert.equal(response.status, 201);
    const id = (await response.json()).trip.id;
    assert.equal(
      (
        await call(
          `/trips/${id}/events`,
          "POST",
          { type: "boarding", client_id: "boarding" },
          other,
        )
      ).status,
      404,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await call(`/trips/${id}/events`, "POST", { type: "completed", client_id: "done" }))
          .status,
        201,
      );
    assert.equal(
      (await call(`/trips/${id}/events`, "POST", { type: "boarding", client_id: "late" })).status,
      409,
    );
    assert.equal(
      (
        await pg.query(
          "SELECT count(*)::int AS count FROM passenger_trip_events WHERE trip_id=$1",
          [id],
        )
      ).rows[0].count,
      1,
    );
    assert.equal((await (await call("/trips?status=active")).json()).trips.length, 0);
  });
  await t.test("unpublished and expired alerts never appear", async () => {
    await pg.exec(
      "INSERT INTO alerts(category,severity,title_es,description_es,published,starts_at,expires_at) VALUES('service','info','live','live',true,NOW(),NOW()+INTERVAL '1 day'),('news','info','draft','draft',false,NOW(),NOW()+INTERVAL '1 day'),('routes','warning','expired','expired',true,NOW()-INTERVAL '2 days',NOW()-INTERVAL '1 day')",
    );
    const alerts = (await (await call("/alerts?language=en")).json()).alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].title, "live");
  });
  await t.test("support and report retries persist once", async () => {
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (await call("/support/tickets", "POST", { message: "Help", client_id: "ticket" })).status,
        201,
      );
      assert.equal(
        (
          await call("/reports", "POST", {
            type: "delay",
            severity: "low",
            message: "Delayed",
            route_id: route,
            client_id: "report",
          })
        ).status,
        201,
      );
    }
    assert.equal(
      (await pg.query("SELECT count(*)::int AS count FROM support_tickets")).rows[0].count,
      1,
    );
    assert.equal((await (await call("/reports/my")).json()).reports.length, 1);
  });
  await t.test("rerunning migrations does not restore a removed legacy favorite", async () => {
    await pg.query("INSERT INTO favorite_routes(user_id,route_id) VALUES($1,$2)", [owner, route]);
    await migrate(client, directory, () => {});
    assert.equal(
      (await pg.query("SELECT count(*)::int AS count FROM saved_journeys")).rows[0].count,
      0,
    );
  });
  await t.test("push worker submits only opted-in alerts and retires invalid devices", async () => {
    await pg.query(
      "INSERT INTO user_preferences(user_id,push_notifications_enabled,favorite_route_alerts) VALUES($1,true,true)",
      [owner],
    );
    assert.equal(
      (await call("/notification-subscriptions", "POST", { route_id: route })).status,
      201,
    );
    const deviceResponse = await call("/devices", "POST", {
      token: "ExpoPushToken[unit-test]",
      platform: "android",
    });
    assert.equal(deviceResponse.status, 201);
    await pg.query(
      "INSERT INTO alerts(route_id,category,severity,title_es,description_es,published,expires_at) VALUES($1,'routes','info','Test push','A test only',true,NOW()+INTERVAL '1 day')",
      [route],
    );
    let requests = 0;
    const push = require("../dist/passengers/push.service");
    await push.deliverPublishedAlerts(async (url, options) => {
      requests++;
      assert.match(url, /\/send$/);
      assert.equal(JSON.parse(options.body).title, "Test push");
      return new Response(JSON.stringify({ data: { status: "ok", id: "ticket-one" } }));
    });
    assert.equal(requests, 1);
    await pg.exec(
      "UPDATE notification_deliveries SET next_attempt_at=NOW() WHERE status='submitted'",
    );
    await push.deliverPublishedAlerts(async (url) => {
      assert.match(url, /getReceipts$/);
      return new Response(
        JSON.stringify({
          data: { "ticket-one": { status: "error", details: { error: "DeviceNotRegistered" } } },
        }),
      );
    });
    assert.equal(
      (await pg.query("SELECT active FROM passenger_devices WHERE user_id=$1", [owner])).rows[0]
        .active,
      false,
    );
    assert.equal((await call("/notification-subscriptions/" + route, "DELETE")).status, 204);
    assert.equal(
      (await (await call("/notification-subscriptions")).json()).subscriptions.length,
      0,
    );
  });
  await t.test(
    "guest transfer is atomic, authenticated and repeatable only for its target",
    async () => {
      const target = (
        await pg.query(
          "INSERT INTO users(email,auth_provider) VALUES('target@example.test','email') RETURNING id",
        )
      ).rows[0].id;
      const second = (
        await pg.query(
          "INSERT INTO users(email,auth_provider) VALUES('other@example.test','email') RETURNING id",
        )
      ).rows[0].id;
      await pg.query(
        "INSERT INTO saved_places(user_id,name,kind,latitude,longitude,client_id) VALUES($1,'Home','home',31.8,-116.6,'home')",
        [owner],
      );
      const body = { guest_token: jwt.sign({ sub: owner, role: "user" }, process.env.JWT_SECRET) };
      for (let i = 0; i < 2; i++)
        assert.equal((await call("/users/me/guest-data", "POST", body, target)).status, 200);
      assert.equal((await call("/users/me/guest-data", "POST", body, second)).status, 409);
      assert.equal((await pg.query("SELECT user_id FROM saved_places")).rows[0].user_id, target);
      assert.equal((await pg.query("SELECT user_id FROM user_reports")).rows[0].user_id, target);
      assert.equal(
        (await pg.query("SELECT status FROM users WHERE id=$1", [owner])).rows[0].status,
        "deleted",
      );
    },
  );
});
