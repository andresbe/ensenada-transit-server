const { test } = require("node:test");
const assert = require("node:assert/strict");

function setup(t) {
  const previousAllowlist = process.env.PUBLIC_TEST_VEHICLE_IDS;
  process.env.PUBLIC_TEST_VEHICLE_IDS = "";
  const db = require("../dist/db"), originalQuery = db.query;
  t.after(() => {
    db.query = originalQuery;
    if (previousAllowlist === undefined) delete process.env.PUBLIC_TEST_VEHICLE_IDS;
    else process.env.PUBLIC_TEST_VEHICLE_IDS = previousAllowlist;
  });
  const device = (id, isTest, visible) => ({
    id: `device-${id}`, tracking_id: id, vehicle_id: `vehicle-${id}`, revision: 1,
    provider: "TELTONIKA", status: "active", public_visible: visible, is_test_vehicle: isTest,
    archived_at: null, operational_status: "available", line_active: true,
    route_id: "route", route_variant_id: "variant", direction: "ida", route_active: true,
    route_line_id: null, transport_line_id: null, assigned_route_id: "route", android_active: false,
    economic_number: id,
  });
  const pilot = device("TEST-FTC927-001", true, false);
  const other = device("TEST-FTC927-002", true, true);
  const privateDevice = device("PRIVATE-001", false, false);
  const publicDevice = device("PUBLIC-001", false, true);
  const devices = [pilot, other, privateDevice, publicDevice];
  const visibleRoutes = new Set(["route"]);
  db.query = async (sql, params) => {
    if (sql.startsWith("SELECT id FROM routes")) return { rows: [...visibleRoutes].map(id => ({ id })) };
    if (sql.includes("SELECT tracking_id FROM fleet_vehicles")) return { rows: devices.filter(d => d.is_test_vehicle && params[0].includes(d.tracking_id)) };
    if (sql.includes("FROM driver_sessions s LEFT JOIN")) return { rows: [] };
    if (sql.includes("FROM tracking_devices d")) return { rows: devices.filter(d => params[0].includes(d.id)) };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const sample = d => ({
    busId: d.tracking_id, provider: "TELTONIKA", sourceType: "driver", sourceId: d.id,
    deviceId: d.id, deviceRevision: d.revision, routeId: "route", routeVariantId: "variant",
    routeVariantDirection: "ida", latitude: 31.866, longitude: -116.616, timestamp: Date.now(),
    speed: 10, heading: 45, routeProgressMeters: 120, directionConfidence: "high",
  });
  return { publicBuses: require("../dist/tracking/publicBuses").publicBuses,
    pilot, other, privateDevice, publicDevice, devices, visibleRoutes, sample };
}

test("public test allowlist is disabled by default and matches exact case-sensitive IDs only", async t => {
  const { publicBuses, devices, sample } = setup(t);
  for (const value of [undefined, "", " , ", "*", "TEST-FTC927-*", "TEST-FTC927", "test-ftc927-001", "TEST-FTC927-001-extra"]) {
    if (value === undefined) delete process.env.PUBLIC_TEST_VEHICLE_IDS;
    else process.env.PUBLIC_TEST_VEHICLE_IDS = value;
    assert.deepEqual((await publicBuses(devices.map(sample))).map(b => b.busId), ["PUBLIC-001"], String(value));
  }
});

test("only explicitly allowlisted Teltonika test vehicles bypass private visibility", async t => {
  const { publicBuses, pilot, other, devices, sample } = setup(t);
  const samples = devices.map(sample), before = structuredClone(samples);
  process.env.PUBLIC_TEST_VEHICLE_IDS = ` , ${pilot.tracking_id},PRIVATE-001,${pilot.tracking_id}, `;
  const buses = await publicBuses(samples);
  assert.deepEqual(buses.map(b => b.busId), [pilot.tracking_id, "PUBLIC-001"]);
  const { sourceId, deviceId, deviceRevision, ...expected } = samples[0];
  assert.deepEqual(buses[0], { ...expected, economicNumber: pilot.economic_number });
  assert.deepEqual(samples, before);
  assert.equal(pilot.is_test_vehicle, true); assert.equal(pilot.public_visible, false);
  process.env.PUBLIC_TEST_VEHICLE_IDS = `${pilot.tracking_id},${other.tracking_id}`;
  assert.deepEqual((await publicBuses(samples)).map(b => b.busId), [pilot.tracking_id, other.tracking_id, "PUBLIC-001"]);
  delete process.env.PUBLIC_TEST_VEHICLE_IDS;
  assert.deepEqual((await publicBuses(samples)).map(b => b.busId), ["PUBLIC-001"]);
});

test("allowlisting does not bypass device, fleet, route, assignment or Android-priority checks", async t => {
  const { publicBuses, pilot, visibleRoutes, sample } = setup(t);
  process.env.PUBLIC_TEST_VEHICLE_IDS = pilot.tracking_id;
  const bus = sample(pilot);
  for (const change of [
    { status: "inactive" }, { status: "retired" }, { provider: "OTHER" }, { vehicle_id: null },
    { archived_at: new Date() }, { operational_status: "maintenance" }, { line_active: false },
    { route_id: null }, { route_variant_id: null }, { route_active: false },
    { route_line_id: "other-line" }, { assigned_route_id: "other-route" }, { direction: "unknown" },
    { android_active: true }, { revision: 2 }, { route_variant_id: "other-variant" },
    { tracking_id: "another-vehicle" },
  ]) {
    const original = { ...pilot };
    Object.assign(pilot, change);
    try { assert.deepEqual(await publicBuses([bus]), [], JSON.stringify(change)); }
    finally { Object.assign(pilot, original); }
  }
  for (const change of [{ sourceId: "other-device" }, { deviceId: "unknown" }, { deviceId: undefined }, { deviceRevision: 0 }, { routeVariantId: "other-variant" }, { provider: "ANDROID" }, { provider: undefined }]) {
    assert.deepEqual(await publicBuses([{ ...bus, ...change }]), [], JSON.stringify(change));
  }
  visibleRoutes.clear();
  assert.deepEqual(await publicBuses([bus]), [], "allowlisting cannot publish a hidden route");
});
