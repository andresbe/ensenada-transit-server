const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

test("migration 033 persists shadow state, recovers it, and enables only confirmed variants", { timeout: 90000 }, async t => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  const execute = async (sql, params) => params
    ? pg.query(sql, params)
    : ((await pg.exec(sql)).at(-1) ?? { rows: [] });
  await require("../scripts/migration-runner").migrate(
    { query: execute },
    path.join(__dirname, "../src/db/migrations"),
    () => {},
  );
  const tableSecurity = (await pg.query(
    "SELECT relrowsecurity FROM pg_class WHERE oid='device_direction_state'::regclass",
  )).rows[0];
  assert.equal(tableSecurity.relrowsecurity, true);
  const foreignKeys = (await pg.query(
    `SELECT conname FROM pg_constraint
     WHERE conrelid='device_direction_state'::regclass AND contype='f'
     ORDER BY conname`,
  )).rows.map(row => row.conname);
  assert.deepEqual(foreignKeys, [
    "device_direction_assigned_variant_fk",
    "device_direction_candidate_variant_fk",
    "device_direction_detected_variant_fk",
    "device_direction_state_assignment_id_fkey",
    "device_direction_state_device_id_fkey",
    "device_direction_state_route_id_fkey",
  ]);
  const indexes = (await pg.query(
    "SELECT indexname FROM pg_indexes WHERE tablename='device_direction_state' ORDER BY indexname",
  )).rows.map(row => row.indexname);
  assert.deepEqual(indexes, [
    "device_direction_state_assignment_idx",
    "device_direction_state_observation_idx",
    "device_direction_state_pkey",
    "device_direction_state_route_idx",
  ]);
  const route = (await pg.query(
    "INSERT INTO routes(name,short_name) VALUES('Direction','DIR') RETURNING *",
  )).rows[0];
  const coordinates = Array.from({ length: 21 }, (_, index) => [-116.62 + index * 0.0005, 31.86]);
  const ida = (await pg.query(
    "INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'Ida','ida',$2) RETURNING *",
    [route.id, JSON.stringify(coordinates)],
  )).rows[0];
  const vuelta = (await pg.query(
    "INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'Vuelta','vuelta',$2) RETURNING *",
    [route.id, JSON.stringify([...coordinates].reverse())],
  )).rows[0];
  const vehicle = (await pg.query(
    "INSERT INTO fleet_vehicles(economic_number,tracking_id,assigned_route_id) VALUES('DIR-1','DIR-1',$1) RETURNING *",
    [route.id],
  )).rows[0];
  const device = (await pg.query(
    "INSERT INTO tracking_devices(imei,provider) VALUES('356307042441013','TELTONIKA') RETURNING *",
  )).rows[0];
  const assignment = (await pg.query(
    "INSERT INTO vehicle_device_assignments(device_id,vehicle_id,route_variant_id) VALUES($1,$2,$3) RETURNING *",
    [device.id, vehicle.id, ida.id],
  )).rows[0];
  const client = { query: execute };
  const { createHardwareDirectionSession } = require("../dist/tracking/hardwareDirectionStore");
  const mapping = {
    deviceId: device.id,
    assignmentId: assignment.id,
    routeId: route.id,
    assignedRouteVariantId: ida.id,
    assignedDirection: "ida",
  };
  const time = Date.parse("2026-11-20T14:00:00Z");
  const sample = (index, timestamp) => ({
    latitude: 31.86,
    longitude: coordinates[index][0],
    timestamp,
    speedMps: 4,
    heading: 270,
    satellites: 9,
  });

  await pg.exec("BEGIN");
  const shadow = await createHardwareDirectionSession(client, mapping, "shadow");
  let decision;
  for (let offset = 0; offset < 4; offset++) {
    decision = shadow.observe(sample(16 - offset * 2, time + offset * 60000));
  }
  assert.equal(decision.detectedRouteVariantId, vuelta.id);
  assert.equal(decision.effectiveRouteVariantId, ida.id, "shadow retains assigned API behavior");
  await shadow.persist();
  await pg.exec("COMMIT");
  const stored = (await pg.query("SELECT * FROM device_direction_state WHERE device_id=$1", [device.id])).rows[0];
  assert.equal(stored.assignment_id, assignment.id);
  assert.equal(stored.assigned_route_variant_id, ida.id);
  assert.equal(stored.detected_route_variant_id, vuelta.id);
  assert.equal(stored.detection_confidence, "high");

  await pg.exec("BEGIN");
  const enabled = await createHardwareDirectionSession(client, mapping, "enabled");
  const resumed = enabled.observe(sample(8, time + 4 * 60000));
  assert.equal(resumed.effectiveRouteVariantId, vuelta.id);
  assert.equal(resumed.effectiveDirection, "vuelta");
  await enabled.persist();
  await pg.exec("COMMIT");

  const { hardwareLocationMatchesMapping } = require("../dist/tracking/hardwareStore");
  const deviceMapping = {
    id: device.id,
    provider: "TELTONIKA",
    revision: 2,
    tracking_id: vehicle.tracking_id,
    route_id: route.id,
    route_variant_id: ida.id,
    direction: "ida",
  };
  const effectiveBus = {
    provider: "TELTONIKA",
    deviceId: device.id,
    deviceRevision: 2,
    sourceId: device.id,
    busId: vehicle.tracking_id,
    routeId: route.id,
    routeVariantId: vuelta.id,
    assignedRouteVariantId: ida.id,
    routeVariantDirection: "vuelta",
  };
  assert.equal(hardwareLocationMatchesMapping(
    deviceMapping,
    effectiveBus,
    { id: vuelta.id, route_id: route.id, direction: "vuelta" },
  ), true);
  assert.equal(hardwareLocationMatchesMapping(
    deviceMapping,
    { ...effectiveBus, assignedRouteVariantId: undefined },
    { id: vuelta.id, route_id: route.id, direction: "vuelta" },
  ), false);
  assert.equal(hardwareLocationMatchesMapping(
    deviceMapping,
    effectiveBus,
    { id: vuelta.id, route_id: "other-route", direction: "vuelta" },
  ), false);
});
