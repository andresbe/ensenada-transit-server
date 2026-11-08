const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { decodeEnvelope, decodeRecords } = require("../dist/ruptela/protocol/decoder");
const { recordsFrame } = require("./ruptela-fixtures");

process.env.JWT_SECRET = "isolated-ruptela-test-secret";

test("Ruptela registry, durable dedup, Redis publication and shared visibility", { timeout: 90000 }, async t => {
  const previousAllowlist = process.env.PUBLIC_TEST_VEHICLE_IDS;
  process.env.PUBLIC_TEST_VEHICLE_IDS = "";
  t.after(() => {
    if (previousAllowlist === undefined) delete process.env.PUBLIC_TEST_VEHICLE_IDS;
    else process.env.PUBLIC_TEST_VEHICLE_IDS = previousAllowlist;
  });

  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  const execute = async (sql, params) => params
    ? pg.query(sql, params)
    : ((await pg.exec(sql)).at(-1) ?? { rows: [] });
  const client = { query: execute, release() {} };
  await require("../scripts/migration-runner").migrate(
    client,
    path.join(__dirname, "../src/db/migrations"),
    () => {},
  );

  const db = require("../dist/db");
  const cache = require("../dist/redis/cache");
  const originals = {
    query: db.query,
    client: db.getClient,
    set: cache.setLiveBusLocation,
    get: cache.getLiveBusLocations,
    rate: cache.incrementRateLimit,
  };
  t.after(() => {
    db.query = originals.query;
    db.getClient = originals.client;
    cache.setLiveBusLocation = originals.set;
    cache.getLiveBusLocations = originals.get;
    cache.incrementRateLimit = originals.rate;
  });
  db.query = execute;
  db.getClient = async () => client;
  cache.incrementRateLimit = async () => 1;
  const live = new Map();
  cache.getLiveBusLocations = async () => [...live.values()];
  cache.setLiveBusLocation = async (id, value) => {
    if (!live.has(id) || live.get(id).timestamp < value.timestamp) live.set(id, value);
  };

  const bcrypt = require("bcrypt");
  const passwordHash = await bcrypt.hash("isolated-test-password", 4);
  const admin = (await pg.query(
    "INSERT INTO admins(email,password_hash,is_superadmin) VALUES('ruptela@test.local',$1,true) RETURNING *",
    [passwordHash],
  )).rows[0];
  const route = (await pg.query(
    "INSERT INTO routes(name,short_name,active,visible_in_app) VALUES('Ruptela Test','RUP',true,true) RETURNING *",
  )).rows[0];
  const variant = (await pg.query(
    "INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'Ruptela ida','ida',$2) RETURNING *",
    [route.id, JSON.stringify([[-116.617, 31.865], [-116.616, 31.866], [-116.615, 31.867]])],
  )).rows[0];
  const vehicle = (await pg.query(
    `INSERT INTO fleet_vehicles(economic_number,tracking_id,assigned_route_id,is_test_vehicle)
     VALUES('TEST-ECO5-001','TEST-ECO5-001',$1,true) RETURNING *`,
    [route.id],
  )).rows[0];

  const express = require("express");
  const jwt = require("jsonwebtoken");
  const app = express();
  app.use(express.json());
  app.use("/admin/tracking-devices", require("../dist/teltonika/devices.routes").trackingDevicesRouter);
  app.use(require("../dist/tracking/locations.routes").trackingRouter);
  app.use("/routes", require("../dist/modules/routes/routes.routes").routesRouter);
  app.use("/admin/platform", require("../dist/tenancy/platform.routes").platformRouter);
  app.use(require("../dist/shared/errors").errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({
    sub: admin.id,
    role: "admin",
    identityType: "admin",
    tokenVersion: 1,
  }, process.env.JWT_SECRET);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const response = await fetch(`${origin}/admin/tracking-devices`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "RUPTELA",
      imei: "863071016796572",
      firmware_version: "00.06.82.24",
      vehicle_id: vehicle.id,
      route_variant_id: variant.id,
    }),
  });
  assert.equal(response.status, 201);
  const device = (await response.json()).device;
  assert.equal(device.provider, "RUPTELA");
  assert.equal(device.model, "Eco5 Lite+");
  assert.equal(device.imei, undefined);
  assert.equal(device.imei_suffix, "6572");
  assert.equal(device.public_visible, false);

  const store = require("../dist/ruptela/store");
  assert.equal(await store.authorizeDevice("111111111111111"), null);
  assert.equal(await store.authorizeDevice("863071016796572"), device.id);
  const currentSeconds = Math.floor(Date.now() / 1000) - 5;
  await pg.query("UPDATE vehicle_device_assignments SET assigned_at=$2 WHERE device_id=$1", [
    device.id,
    new Date((currentSeconds - 30) * 1000),
  ]);
  const records = (imei, values, options = {}) => {
    const envelope = decodeEnvelope(recordsFrame(imei, values, options));
    return decodeRecords(envelope.command, envelope.payload).records;
  };
  const initial = records("863071016796572", [
    { timestampSeconds: currentSeconds - 86400, longitude: -116.617 },
    { timestampSeconds: currentSeconds, io: [
      { id: 27, length: 1, value: 21 },
      { id: 29, length: 2, value: 12700 },
      { id: 150, length: 4, value: 334020 },
      { id: 763, length: 1, value: 5 },
    ] },
  ], { extended: true });
  assert.deepEqual(await store.acceptRecords(device.id, initial), { accepted: 2, inserted: 2 });
  assert.deepEqual(await store.acceptRecords(device.id, initial), { accepted: 2, inserted: 0 });
  assert.deepEqual(await store.publishPending(), { published: 1, skipped: 1, failures: 0 });
  assert.equal(live.get(vehicle.tracking_id).provider, "RUPTELA");
  assert.equal(live.get(vehicle.tracking_id).timestamp, currentSeconds * 1000);
  assert.ok(live.get(vehicle.tracking_id).routeProgressMeters !== null);
  const telemetry = (await pg.query(
    "SELECT telemetry,delivery_status,delivery_reason FROM vehicle_gps_locations WHERE device_id=$1 ORDER BY recorded_at DESC",
    [device.id],
  )).rows;
  assert.equal(telemetry[0].telemetry.externalPowerVolts, 12.7);
  assert.equal(telemetry[0].telemetry.gsmSignalLevel, 21);
  assert.equal(telemetry[0].telemetry.networkOperator, 334020);
  assert.equal(telemetry[0].telemetry.networkRegistrationStatus, 5);
  assert.equal(telemetry[1].delivery_reason, "historical");

  const secondVehicle = (await pg.query(
    `INSERT INTO fleet_vehicles(economic_number,tracking_id,assigned_route_id,is_test_vehicle)
     VALUES('TEST-ECO5-002','TEST-ECO5-002',$1,true) RETURNING *`,
    [route.id],
  )).rows[0];
  const secondDevice = (await pg.query(
    "INSERT INTO tracking_devices(imei,provider,model) VALUES('863071016796573','RUPTELA','Eco5 Lite+') RETURNING *",
  )).rows[0];
  await pg.query(
    `INSERT INTO vehicle_device_assignments(device_id,vehicle_id,route_variant_id,assigned_at)
     VALUES($1,$2,$3,$4)`,
    [secondDevice.id, secondVehicle.id, variant.id, new Date((currentSeconds - 30) * 1000)],
  );
  await store.acceptRecords(secondDevice.id, records("863071016796573", [
    { timestampSeconds: currentSeconds + 1, latitude: 31.8661 },
  ]));
  await store.publishPending();
  assert.equal(live.size, 2);

  const internal = await fetch(`${origin}/admin/platform/buses/live`, { headers });
  assert.equal(internal.status, 200);
  assert.equal((await internal.json()).buses.length, 2, "authorized dashboard includes both private trackers");
  for (const endpoint of ["/buses/live", `/routes/${route.id}/live`, `/routes/${variant.id}/live`]) {
    const hidden = await fetch(origin + endpoint);
    assert.equal(hidden.status, 200);
    assert.equal((await hidden.json()).buses.length, 0);
  }
  process.env.PUBLIC_TEST_VEHICLE_IDS = vehicle.tracking_id;
  for (const endpoint of ["/buses/live", `/routes/${route.id}/live`, `/routes/${variant.id}/live`]) {
    const visible = await fetch(origin + endpoint);
    assert.equal(visible.status, 200);
    const buses = (await visible.json()).buses;
    assert.equal(buses.length, 1, endpoint);
    assert.equal(buses[0].busId, vehicle.tracking_id);
    assert.equal(buses[0].provider, "RUPTELA");
    for (const field of ["sourceId", "deviceId", "deviceRevision", "sessionId"]) {
      assert.equal(buses[0][field], undefined);
    }
  }
  delete process.env.PUBLIC_TEST_VEHICLE_IDS;

  const late = records("863071016796572", [{ timestampSeconds: currentSeconds - 1, longitude: -116.6155 }]);
  await store.acceptRecords(device.id, late);
  await store.publishPending();
  assert.equal(live.get(vehicle.tracking_id).timestamp, currentSeconds * 1000);
  assert.equal((await pg.query(
    "SELECT delivery_reason FROM vehicle_gps_locations WHERE device_id=$1 AND event_key=$2",
    [device.id, late[0].fingerprint],
  )).rows[0].delivery_reason, "out_of_order");

  const unassigned = (await pg.query(
    "INSERT INTO tracking_devices(imei,provider) VALUES('863071016796574','RUPTELA') RETURNING *",
  )).rows[0];
  await store.acceptRecords(unassigned.id, records("863071016796574", [
    { timestampSeconds: currentSeconds + 2 },
  ]));
  await store.publishPending();
  assert.equal((await pg.query(
    "SELECT delivery_reason FROM vehicle_gps_locations WHERE device_id=$1",
    [unassigned.id],
  )).rows[0].delivery_reason, "unassigned_vehicle");

  const raw = recordsFrame("863071016796572", [{}]);
  await store.capturePacketDiagnostic({
    deviceId: device.id,
    command: 1,
    packetHash: decodeEnvelope(raw).packetHash,
    byteLength: raw.length,
    reason: "hardware_verification",
    rawPacket: raw,
  }, 1);
  const diagnostic = await fetch(`${origin}/admin/tracking-devices/${device.id}/packet-diagnostics`, { headers });
  assert.equal(diagnostic.status, 200);
  const diagnostics = (await diagnostic.json()).diagnostics;
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].raw_packet_captured, true);
  assert.equal(diagnostics[0].raw_packet, undefined);

  await pg.query("UPDATE tracking_devices SET status='inactive' WHERE id=$1", [device.id]);
  assert.equal(await store.authorizeDevice("863071016796572"), null);
  await assert.rejects(store.acceptRecords(device.id, records("863071016796572", [
    { timestampSeconds: currentSeconds + 3 },
  ])), /device_disabled/);
});
