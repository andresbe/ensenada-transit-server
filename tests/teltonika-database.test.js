const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { encodePacket } = require("../scripts/teltonika-simulator");
const { decodeCodec8Extended } = require("../dist/teltonika/codec");
process.env.JWT_SECRET = "isolated-teltonika-test-secret";

test("additive migration, registry API, telemetry/outbox, privacy and Android compatibility", { timeout: 90000 }, async t => {
  const previousAllowlist = process.env.PUBLIC_TEST_VEHICLE_IDS;
  process.env.PUBLIC_TEST_VEHICLE_IDS = "";
  t.after(() => {
    if (previousAllowlist === undefined) delete process.env.PUBLIC_TEST_VEHICLE_IDS;
    else process.env.PUBLIC_TEST_VEHICLE_IDS = previousAllowlist;
  });
  const pg = new PGlite({ extensions: { pgcrypto } }); t.after(() => pg.close());
  const execute = async (sql, params) => params ? pg.query(sql, params) : ((await pg.exec(sql)).at(-1) ?? { rows: [] });
  const client = { query: execute, release() {} };
  const folder = path.join(__dirname, "../src/db/migrations");
  const { migrate } = require("../scripts/migration-runner");
  await migrate(client, folder, () => {});
  await migrate(client, folder, () => {});
  const db = require("../dist/db"); const cache = require("../dist/redis/cache");
  const originals = { query: db.query, client: db.getClient, set: cache.setLiveBusLocation, get: cache.getLiveBusLocations, rate: cache.incrementRateLimit };
  t.after(() => { db.query = originals.query; db.getClient = originals.client; cache.setLiveBusLocation = originals.set; cache.getLiveBusLocations = originals.get; cache.incrementRateLimit = originals.rate; });
  db.query = execute; db.getClient = async () => client; cache.incrementRateLimit = async () => 1;
  const live = new Map(); let failRedis = false;
  cache.getLiveBusLocations = async () => [...live.values()];
  cache.setLiveBusLocation = async (id, value) => {
    if (failRedis) throw new Error("Redis down");
    if (!live.has(id) || live.get(id).timestamp < value.timestamp) live.set(id, value);
  };
  const hash = await require("bcrypt").hash("isolated-test-password", 4);
  const admin = (await pg.query("INSERT INTO admins(email,password_hash,is_superadmin) VALUES('gps@test.local',$1,true) RETURNING *", [hash])).rows[0];
  const driver = (await pg.query("INSERT INTO users(email,role) VALUES('driver@test.local','driver') RETURNING *")).rows[0];
  const operator = (await pg.query("INSERT INTO admins(email,password_hash,is_superadmin) VALUES('operator@test.local',$1,false) RETURNING *", [hash])).rows[0];
  const route = (await pg.query("INSERT INTO routes(name,short_name,active,visible_in_app) VALUES('GPS Test','GPS',true,true) RETURNING *")).rows[0];
  const variant = (await pg.query("INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'GPS ida','ida',$2) RETURNING *", [route.id, JSON.stringify([[-116.616,31.866],[-116.615,31.867],[-116.614,31.868]])])).rows[0];
  const express = require("express"), jwt = require("jsonwebtoken");
  const app = express(); app.use(express.json()); app.use("/admin/tracking-devices", require("../dist/teltonika/devices.routes").trackingDevicesRouter);
  app.use(require("../dist/tracking/locations.routes").trackingRouter);
  app.use("/routes", require("../dist/modules/routes/routes.routes").routesRouter);
  app.use("/admin/platform", require("../dist/tenancy/platform.routes").platformRouter);
  app.use(require("../dist/shared/errors").errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/admin/tracking-devices`;
  const token = account => jwt.sign({ sub: account.id, role: account === driver ? "driver" : "admin", identityType: account === driver ? undefined : "admin", tokenVersion: 1 }, process.env.JWT_SECRET);
  const headers = { Authorization: `Bearer ${token(admin)}`, "Content-Type": "application/json" };
  for (const auth of [null, driver, operator]) {
    const response = await fetch(url, { headers: auth ? { Authorization: `Bearer ${token(auth)}` } : {} });
    assert.equal(response.status, auth ? 403 : 401);
  }
  const create = await fetch(url, { method: "POST", headers, body: JSON.stringify({ imei: "356307042441013", test_vehicle: true, route_variant_id: variant.id, firmware_version: "3.0.7" }) });
  assert.equal(create.status, 201); let device = (await create.json()).device;
  assert.equal(device.imei, undefined); assert.equal(device.imei_suffix, "1013"); assert.equal(device.public_visible, false);
  const vehicle = (await pg.query("SELECT * FROM fleet_vehicles WHERE id=$1", [device.vehicle_id])).rows[0];
  assert.equal(vehicle.tracking_id, "TEST-FTC927-001");
  const patch = body => fetch(`${url}/${device.id}`, { method: "PATCH", headers, body: JSON.stringify({ revision: device.revision, ...body }) });
  assert.equal((await patch({ public_visible: true })).status, 400);
  assert.equal((await patch({ revision: 999, status: "inactive" })).status, 409);
  const store = require("../dist/teltonika/store");
  assert.equal(await store.authorizeDevice("111111111111111"), null);
  assert.equal(await store.authorizeDevice("356307042441013"), device.id);
  const now = Date.now() - 10000;
  await pg.query("UPDATE vehicle_device_assignments SET assigned_at=$2 WHERE device_id=$1", [device.id, new Date(now - 20000)]);
  device = (await (await fetch(url, { headers })).json()).devices[0];
  const records = changes => decodeCodec8Extended(encodePacket(changes.map(change => ({ timestamp: now, latitude: 31.866, longitude: -116.616, ...change }))));
  const history = records([{ timestamp: now - 86400000 }, { timestamp: now - 5000, satellites: 0 }, {}]);
  assert.deepEqual(await store.acceptRecords(device.id, history), { accepted: 3, inserted: 3 });
  assert.deepEqual(await store.acceptRecords(device.id, history), { accepted: 3, inserted: 0 });
  assert.equal((await pg.query("SELECT count(*)::int n FROM vehicle_gps_locations")).rows[0].n, 3);
  assert.deepEqual(await store.publishPending(), { published: 1, skipped: 1, failures: 0 });
  assert.equal(live.get(vehicle.tracking_id).timestamp, now); assert.equal(live.get(vehicle.tracking_id).speed, 10);
  assert.ok(live.get(vehicle.tracking_id).routeProgressMeters !== null);
  const internal = await fetch(origin + "/admin/platform/buses/live", { headers });
  assert.equal(internal.status, 200); assert.equal((await internal.json()).buses.length, 1, "private tracker visible to authorized dashboard");
  for (const endpoint of ["/buses/live", `/routes/${variant.id}/live`, `/routes/${variant.id}/eta?userLat=31.867&userLng=-116.615`]) {
    const response = await fetch(origin + endpoint); assert.equal(response.status, 200); assert.equal((await response.json()).buses.length, 0);
  }
  await t.test("temporary allowlist exposes the pilot consistently without changing stored flags or cached telemetry", async () => {
    const cached = structuredClone(live.get(vehicle.tracking_id));
    const endpoints = ["/buses/live", `/routes/${route.id}/live`, `/routes/${variant.id}/live`,
      `/routes/${variant.id}/eta?userLat=31.867&userLng=-116.615`];
    const locations = require("../dist/modules/locations/locations.service").locationsService;
    const etaBefore = await locations.getEtaForRouteVariant(variant.id, { latitude: 31.867, longitude: -116.615 }, undefined, false);
    process.env.PUBLIC_TEST_VEHICLE_IDS = ` , ${vehicle.tracking_id}, `;
    try {
      for (const endpoint of endpoints) {
        const response = await fetch(origin + endpoint); assert.equal(response.status, 200);
        const buses = (await response.json()).buses;
        assert.equal(buses.length, 1, endpoint);
        const bus = buses[0];
        for (const field of ["busId", "routeId", "routeVariantId", "routeVariantDirection", "latitude", "longitude", "timestamp", "speed", "directionConfidence", "routeProgressMeters"]) {
          assert.equal(bus[field], cached[field], `${endpoint}: ${field}`);
        }
        for (const field of ["sourceId", "deviceId", "deviceRevision", "sessionId"]) assert.equal(bus[field], undefined);
        if (endpoint.includes("/eta?")) {
          const expected = (await require("../dist/tracking/publicBuses").publicBuses(etaBefore.buses))[0];
          assert.deepEqual(bus, JSON.parse(JSON.stringify(expected)));
        }
      }
      assert.equal((await pg.query("SELECT is_test_vehicle FROM fleet_vehicles WHERE id=$1", [vehicle.id])).rows[0].is_test_vehicle, true);
      assert.equal((await pg.query("SELECT public_visible FROM tracking_devices WHERE id=$1", [device.id])).rows[0].public_visible, false);
      assert.deepEqual(live.get(vehicle.tracking_id), cached);
    } finally { delete process.env.PUBLIC_TEST_VEHICLE_IDS; }
    for (const endpoint of endpoints) {
      assert.equal((await (await fetch(origin + endpoint)).json()).buses.length, 0, `unset hides the cached pilot: ${endpoint}`);
    }
    assert.equal((await (await fetch(origin + "/admin/platform/buses/live", { headers })).json()).buses.length, 1);
  });
  const telemetry = await (await fetch(`${url}/${device.id}/telemetry`, { headers })).json();
  assert.equal(telemetry.telemetry.length, 3); assert.ok(telemetry.telemetry.some(row => row.delivery_reason === "no_gnss_fix"));
  assert.ok(telemetry.telemetry.some(row => row.delivery_reason === "historical"));
  await store.acceptRecords(device.id, records([{ timestamp: now - 1000 }])); await store.publishPending();
  assert.equal(live.get(vehicle.tracking_id).timestamp, now);
  assert.equal((await pg.query("SELECT delivery_reason FROM vehicle_gps_locations WHERE recorded_at=$1", [new Date(now - 1000)])).rows[0].delivery_reason, "out_of_order");

  failRedis = true; await store.acceptRecords(device.id, records([{ timestamp: now + 1000 }]));
  assert.equal((await store.publishPending()).failures, 1);
  assert.equal((await pg.query("SELECT count(*)::int n FROM vehicle_gps_locations WHERE delivery_status='pending'")).rows[0].n, 1);
  failRedis = false; await store.publishPending(); assert.equal(live.get(vehicle.tracking_id).timestamp, now + 1000);
  // Reassigning cannot publish already queued data under the new configuration.
  await store.acceptRecords(device.id, records([{ timestamp: now + 2000 }]));
  device = (await (await patch({ firmware_version: "3.0.8" })).json()).device;
  await store.publishPending(); assert.equal(live.get(vehicle.tracking_id).timestamp, now + 1000);
  device = (await (await patch({ status: "inactive" })).json()).device;
  assert.equal(await store.authorizeDevice("356307042441013"), null);
  await assert.rejects(store.acceptRecords(device.id, records([{ timestamp: now + 3000 }])));
  device = (await (await patch({ status: "retired" })).json()).device;
  assert.equal(await store.authorizeDevice("356307042441013"), null);
  device = (await (await patch({ status: "active" })).json()).device;

  // A separate existing fleet vehicle can explicitly become public; no duplicate registry.
  const publicVehicle = (await pg.query("INSERT INTO fleet_vehicles(economic_number,tracking_id) VALUES('GPS-002','GPS-002') RETURNING *")).rows[0];
  device = (await (await patch({ vehicle_id: publicVehicle.id, public_visible: true })).json()).device;
  await store.acceptRecords(device.id, records([{ timestamp: Date.now() + 1 }])); await store.publishPending();
  const visible = (await (await fetch(origin + "/buses/live")).json()).buses;
  assert.equal(visible.length, 1); assert.equal(visible[0].economicNumber, "GPS-002");
  for (const field of ["sourceId", "deviceId", "deviceRevision", "sessionId"]) assert.equal(visible[0][field], undefined);
  const { startSession, endSession } = require("../dist/driver-sessions/driverSessions.service");
  const conductor = (await pg.query("INSERT INTO conductores(correo,password,nombre_usuario) VALUES('gps-driver@test.local',$1,'GPS driver') RETURNING *", [hash])).rows[0];
  await pg.query("UPDATE fleet_vehicles SET assigned_driver_id=$2 WHERE id=$1", [publicVehicle.id, conductor.id]);
  const driverToken = jwt.sign({ sub: conductor.correo, role: "driver", tokenVersion: conductor.token_version }, process.env.JWT_SECRET);
  const session = await startSession(conductor.correo, { bus_id: publicVehicle.tracking_id, route_id: route.id, variant_id: variant.id });
  await store.acceptRecords(device.id, records([{ timestamp: now + 5000 }])); await store.publishPending();
  assert.equal((await (await fetch(origin + "/buses/live")).json()).buses.length, 0, "Android session excludes tracker visibility");
  const androidTimestamp = Date.now() + 10;
  const android = await fetch(origin + "/locations/update", { method: "POST", headers: { ...headers, Authorization: `Bearer ${driverToken}` }, body: JSON.stringify({
    sessionId: session.id, sourceType: "driver", sourceId: conductor.correo, busId: publicVehicle.tracking_id,
    routeId: route.id, routeVariantId: variant.id, routeVariantDirection: "ida", latitude: 31.866, longitude: -116.616,
    timestamp: androidTimestamp, provider: "TELTONIKA", deviceId: device.id,
  }) });
  assert.equal(android.status, 201); assert.equal((await android.json()).busId, publicVehicle.tracking_id);
  assert.equal(live.get(publicVehicle.tracking_id).provider, "ANDROID", "HTTP cannot spoof device provider");
  assert.equal((await (await fetch(origin + "/buses/live")).json()).buses.length, 1, "Android public contract preserved");
  await pg.query("UPDATE fleet_vehicles SET is_test_vehicle=true WHERE id=$1", [publicVehicle.id]);
  process.env.PUBLIC_TEST_VEHICLE_IDS = publicVehicle.tracking_id;
  for (const endpoint of ["/buses/live", `/routes/${variant.id}/live`, `/routes/${variant.id}/eta?userLat=31.867&userLng=-116.615`]) {
    const response = await fetch(origin + endpoint); assert.equal(response.status, 200);
    assert.equal((await response.json()).buses.length, 0, "Android test vehicle hidden from Redis-backed public endpoints");
  }
  await pg.query("UPDATE driver_sessions SET vehicle_id=NULL WHERE id=$1", [session.id]);
  assert.equal((await (await fetch(origin + "/buses/live")).json()).buses.length, 0, "legacy session cannot bypass test flag");
  delete process.env.PUBLIC_TEST_VEHICLE_IDS;
  await pg.query("UPDATE driver_sessions SET vehicle_id=$2 WHERE id=$1", [session.id, publicVehicle.id]);
  await pg.query("UPDATE fleet_vehicles SET is_test_vehicle=false WHERE id=$1", [publicVehicle.id]);
  await endSession(conductor.correo, session.id);
  await store.acceptRecords(device.id, records([{ timestamp: androidTimestamp - 1 }])); await store.publishPending();
  assert.equal(live.get(publicVehicle.tracking_id).timestamp, androidTimestamp, "tracker cannot rewind newer Android fix");
  // Unmapped devices still retain diagnostics and safely ACK.
  device = (await (await patch({ vehicle_id: null, route_variant_id: null, public_visible: false })).json()).device;
  const unassignedTimestamp = Date.now() + 20;
  await store.acceptRecords(device.id, records([{ timestamp: unassignedTimestamp }])); await store.publishPending();
  assert.equal((await pg.query("SELECT delivery_reason FROM vehicle_gps_locations WHERE recorded_at=$1", [new Date(unassignedTimestamp)])).rows[0].delivery_reason, "unassigned_vehicle");
  assert.equal((await pg.query("SELECT count(*)::int n FROM users WHERE id=$1", [driver.id])).rows[0].n, 1);

  // Exercise the shipped CLI over a real TCP socket all the way through durable storage and publication.
  device = (await (await patch({ vehicle_id: vehicle.id, route_variant_id: variant.id })).json()).device;
  const { createReceiver } = require("../dist/teltonika/receiver");
  const { receiverConfig } = require("../dist/teltonika/config");
  const receiver = createReceiver(receiverConfig({}), { authorize: store.authorizeDevice, accept: store.acceptRecords, log() {} });
  receiver.server.listen(0, "127.0.0.1"); await new Promise(r => receiver.server.once("listening", r));
  try {
    const run = require("node:util").promisify(require("node:child_process").execFile);
    const result = await run(process.execPath, [path.join(__dirname, "../scripts/teltonika-simulator.js"), "--imei", "356307042441013", "--port", String(receiver.server.address().port), "--fragment"]);
    assert.match(result.stdout, /simulator_accepted/); assert.equal(receiver.metrics.receivedRecords, 2);
    assert.equal((await store.publishPending()).failures, 0);
    assert.equal(live.get(vehicle.tracking_id).provider, "TELTONIKA");
  } finally { await receiver.close(); }

  // Real PostgreSQL RLS, not application-only filtering: operators see only their mapping columns.
  const line = (await pg.query("INSERT INTO transport_lines(name,short_code) VALUES('GPS Line','GPS') RETURNING id")).rows[0];
  const otherLine = (await pg.query("INSERT INTO transport_lines(name,short_code) VALUES('Other GPS','GPS2') RETURNING id")).rows[0];
  await pg.query("INSERT INTO admin_line_memberships(admin_id,line_id,role) VALUES($1,$2,'operator')", [operator.id, line.id]);
  await pg.query("UPDATE routes SET transport_line_id=$2 WHERE id=$1", [route.id, line.id]);
  await pg.query("UPDATE fleet_vehicles SET transport_line_id=$2 WHERE id=$1", [vehicle.id, line.id]);
  const otherVehicle = (await pg.query("INSERT INTO fleet_vehicles(economic_number,transport_line_id) VALUES('OTHER-GPS',$1) RETURNING id", [otherLine.id])).rows[0];
  const otherDevice = (await pg.query("INSERT INTO tracking_devices(imei) VALUES('111111111111111') RETURNING id")).rows[0];
  await pg.query("INSERT INTO vehicle_device_assignments(device_id,vehicle_id) VALUES($1,$2)", [otherDevice.id, otherVehicle.id]);
  const scoped = async fn => {
    await client.query("BEGIN");
    try {
      await require("../dist/tenancy/database").applyLineContext(client, { lineId: line.id, adminId: operator.id, tokenVersion: 1, role: "operator" });
      return await fn();
    } finally { await client.query("ROLLBACK"); }
  };
  const authorizedDevices = await scoped(() => pg.query("SELECT d.id,a.vehicle_id FROM tracking_devices d JOIN vehicle_device_assignments a ON a.device_id=d.id AND a.unassigned_at IS NULL"));
  assert.deepEqual(authorizedDevices.rows.map(row => row.id), [device.id]);
  await assert.rejects(scoped(() => pg.query("SELECT imei FROM tracking_devices")), { code: "42501" });
  await assert.rejects(scoped(() => pg.query("SELECT * FROM vehicle_gps_locations")), { code: "42501" });
  await assert.rejects(scoped(() => pg.query("SELECT * FROM public_vehicle_gps_locations")), { code: "42501" });
  await assert.rejects(scoped(() => pg.query("SELECT * FROM tracking_device_rejections")), { code: "42501" });

  const assignments = (await (await fetch(`${url}/${device.id}/assignments`, { headers })).json()).assignments;
  assert.equal(assignments.length, 3); assert.equal(assignments.filter(a => !a.unassigned_at).length, 1);
  assert.ok(assignments.every(a => a.assigned_by === admin.id));
  const beforeMove = records([{ timestamp: now + 2500 }]);
  await store.acceptRecords(device.id, beforeMove); await store.publishPending();
  const oldFix = (await pg.query("SELECT vehicle_id,assignment_id,delivery_reason FROM vehicle_gps_locations WHERE event_key=$1", [beforeMove[0].fingerprint])).rows[0];
  assert.equal(oldFix.vehicle_id, vehicle.id); assert.notEqual(oldFix.assignment_id, device.assignment_id);
  assert.equal(oldFix.delivery_reason, "assignment_changed");

  const sharedTimestamp = Date.now() + 1;
  const sameTime = records([{ timestamp: sharedTimestamp, eventId: 239 }, { timestamp: sharedTimestamp, eventId: 240 }]);
  assert.deepEqual(await store.acceptRecords(device.id, sameTime), { accepted: 2, inserted: 2 });
  assert.deepEqual(await store.acceptRecords(device.id, sameTime), { accepted: 2, inserted: 0 });
  assert.equal((await pg.query("SELECT count(*)::int n FROM vehicle_gps_locations WHERE recorded_at=$1", [new Date(sameTime[0].timestamp)])).rows[0].n, 2);
  await store.publishPending();

  const malformed = records([{ latitude: 91 }, { longitude: -181 }, { speedKmh: 360 }, { heading: 360 }, { satellites: 100 }, { timestamp: 8640000000000000 }]);
  assert.deepEqual(await store.acceptRecords(device.id, malformed), { accepted: 6, inserted: 6 });
  assert.deepEqual(await store.acceptRecords(device.id, malformed), { accepted: 6, inserted: 0 });
  const rejected = (await (await fetch(`${url}/${device.id}/rejections`, { headers })).json()).rejections;
  assert.equal(rejected.length, 6); assert.ok(rejected.some(r => r.telemetry.latitude === 91));
  assert.equal((await store.publishPending()).published, 0);
  const remembered = live.get(vehicle.tracking_id);
  await pg.query("UPDATE vehicle_device_assignments SET unassigned_at=now() WHERE device_id=$1 AND unassigned_at IS NULL", [device.id]);
  assert.equal((await (await fetch(origin + "/admin/platform/buses/live", { headers })).json()).buses.length, 0, "SQL-side closure hides cached mapping");
  assert.equal(live.get(vehicle.tracking_id), remembered, "cache is unchanged; DB authorization hides it");
});
