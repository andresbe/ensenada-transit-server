process.env.HARDWARE_AUTO_DIRECTION_MODE = "enabled";
process.env.LOCATION_TTL_SECONDS = "600";
process.env.JWT_SECRET = "hardware-direction-pipeline-test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

test("enabled Teltonika and Ruptela outboxes publish confirmed effective variants through live and ETA", { timeout: 90000 }, async t => {
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
    getClient: db.getClient,
    setLive: cache.setLiveBusLocation,
    getLive: cache.getLiveBusLocations,
  };
  t.after(() => {
    db.query = originals.query;
    db.getClient = originals.getClient;
    cache.setLiveBusLocation = originals.setLive;
    cache.getLiveBusLocations = originals.getLive;
  });
  db.query = execute;
  db.getClient = async () => client;
  const live = new Map();
  cache.setLiveBusLocation = async (busId, location) => {
    const current = live.get(busId);
    if (!current || current.timestamp < location.timestamp) live.set(busId, location);
  };
  cache.getLiveBusLocations = async () => [...live.values()];

  const route = (await pg.query(
    "INSERT INTO routes(name,short_name,active,visible_in_app) VALUES('Direction Pipeline','DP',true,true) RETURNING *",
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

  const installations = [];
  for (const [provider, suffix] of [["TELTONIKA", "013"], ["RUPTELA", "572"]]) {
    const vehicle = (await pg.query(
      `INSERT INTO fleet_vehicles(economic_number,tracking_id,assigned_route_id)
       VALUES($1,$1,$2) RETURNING *`,
      [`AUTO-${provider}`, route.id],
    )).rows[0];
    const device = (await pg.query(
      "INSERT INTO tracking_devices(imei,provider,public_visible) VALUES($1,$2,true) RETURNING *",
      [`356307042441${suffix}`, provider],
    )).rows[0];
    const assignment = (await pg.query(
      `INSERT INTO vehicle_device_assignments(device_id,vehicle_id,route_variant_id,assigned_at)
       VALUES($1,$2,$3,now()-interval '10 minutes') RETURNING *`,
      [device.id, vehicle.id, ida.id],
    )).rows[0];
    const currentDevice = (await pg.query("SELECT * FROM tracking_devices WHERE id=$1", [device.id])).rows[0];
    installations.push({ provider, vehicle, device: currentDevice, assignment });
  }

  const start = Date.now() - 190000;
  for (const installation of installations) {
    for (let offset = 0; offset < 4; offset++) {
      const index = 16 - offset * 2;
      const timestamp = new Date(start + offset * 60000);
      const telemetry = {
        provider: installation.provider,
        deviceId: installation.device.id,
        vehicleId: installation.vehicle.id,
        latitude: 31.86,
        longitude: coordinates[index][0],
        altitude: 10,
        speedMps: 4,
        heading: 270,
        satellites: 9,
        recordedAt: timestamp.toISOString(),
        receivedAt: timestamp.toISOString(),
        isValid: true,
        invalidReason: null,
        priority: 0,
        eventId: 0,
        io: [],
      };
      const eventKey = createHash("sha256")
        .update(`${installation.device.id}:${timestamp.toISOString()}`)
        .digest("hex");
      await pg.query(
        `INSERT INTO vehicle_gps_locations
         (source,device_id,vehicle_id,assignment_id,device_revision,event_key,latitude,longitude,
          speed_mps,heading,satellites,recorded_at,received_at,is_valid,telemetry,delivery_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,4,270,9,$9,$9,true,$10,'pending')`,
        [
          installation.provider,
          installation.device.id,
          installation.vehicle.id,
          installation.assignment.id,
          installation.device.revision,
          eventKey,
          31.86,
          coordinates[index][0],
          timestamp,
          JSON.stringify(telemetry),
        ],
      );
    }
  }

  const { publishHardwarePending } = require("../dist/tracking/hardwareStore");
  assert.deepEqual(await publishHardwarePending("TELTONIKA"), { published: 4, skipped: 0, failures: 0 });
  assert.deepEqual(await publishHardwarePending("RUPTELA"), { published: 4, skipped: 0, failures: 0 });
  for (const installation of installations) {
    const location = live.get(installation.vehicle.tracking_id);
    assert.equal(location.routeVariantId, vuelta.id);
    assert.equal(location.assignedRouteVariantId, ida.id);
    assert.equal(location.routeVariantDirection, "vuelta");
    assert.ok(location.routeProgressMeters > 0);
    const persisted = (await pg.query(
      "SELECT * FROM device_direction_state WHERE device_id=$1",
      [installation.device.id],
    )).rows[0];
    assert.equal(persisted.detected_route_variant_id, vuelta.id);
  }

  const { locationsService } = require("../dist/modules/locations/locations.service");
  const byVariant = await locationsService.getLiveBusesByRouteVariant(vuelta.id);
  assert.equal(byVariant.length, 2);
  assert.ok(byVariant.every(bus => bus.assignedRouteVariantId === ida.id));
  const eta = await locationsService.getEtaForRouteVariant(
    vuelta.id,
    { latitude: 31.86, longitude: coordinates[8][0] },
    undefined,
  );
  assert.equal(eta.buses.length, 2);
  assert.ok(eta.buses.every(bus => bus.routeVariantId === vuelta.id));

  const { publicBuses } = require("../dist/tracking/publicBuses");
  const publicLive = await publicBuses(await locationsService.getLiveBuses());
  assert.deepEqual(
    publicLive.map(bus => bus.busId).sort(),
    ["AUTO-RUPTELA", "AUTO-TELTONIKA"],
  );
  assert.ok(publicLive.every(bus => bus.routeVariantId === vuelta.id));
  assert.ok(publicLive.every(bus => bus.assignedRouteVariantId === ida.id));
  for (const bus of publicLive) {
    assert.equal(bus.sourceId, undefined);
    assert.equal(bus.deviceId, undefined);
    assert.equal(bus.deviceRevision, undefined);
  }
  const { planDirectRoutes } = require("../dist/passengers/journeyPlanner");
  const journeyPlans = planDirectRoutes(
    {
      origin: { latitude: 31.86, longitude: coordinates[8][0] },
      destination: { latitude: 31.86, longitude: coordinates[2][0] },
      maxWalkingMeters: 800,
    },
    [{
      id: vuelta.id,
      route_id: route.id,
      name: "Vuelta",
      direction: "vuelta",
      route_name: route.name,
      short_name: route.short_name,
      color: route.color,
      coordinates: [...coordinates].reverse(),
      stops: [
        { id: "journey-board", name: "Board", latitude: 31.86, longitude: coordinates[8][0], sequence: 1 },
        { id: "journey-exit", name: "Exit", latitude: 31.86, longitude: coordinates[2][0], sequence: 2 },
      ],
    }],
    publicLive,
    Date.now(),
  );
  assert.equal(journeyPlans[0].variantId, vuelta.id);
  assert.equal(journeyPlans[0].activeBuses, 2);
  assert.ok(journeyPlans[0].arrival, "effective vuelta buses must participate in passenger arrivals");

  const { env } = require("../dist/config/env");
  env.hardwareAutoDirectionMode = "shadow";
  const teltonika = installations.find(installation => installation.provider === "TELTONIKA");
  const shadowTimestamp = new Date(Date.now() - 1000);
  const shadowTelemetry = {
    provider: teltonika.provider,
    deviceId: teltonika.device.id,
    vehicleId: teltonika.vehicle.id,
    latitude: 31.86,
    longitude: coordinates[8][0],
    altitude: 10,
    speedMps: 4,
    heading: 270,
    satellites: 9,
    recordedAt: shadowTimestamp.toISOString(),
    receivedAt: shadowTimestamp.toISOString(),
    isValid: true,
    invalidReason: null,
    priority: 0,
    eventId: 0,
    io: [],
  };
  await pg.query(
    `INSERT INTO vehicle_gps_locations
     (source,device_id,vehicle_id,assignment_id,device_revision,event_key,latitude,longitude,
      speed_mps,heading,satellites,recorded_at,received_at,is_valid,telemetry,delivery_status)
     VALUES('TELTONIKA',$1,$2,$3,$4,$5,31.86,$6,4,270,9,$7,$7,true,$8,'pending')`,
    [
      teltonika.device.id,
      teltonika.vehicle.id,
      teltonika.assignment.id,
      teltonika.device.revision,
      createHash("sha256").update(`shadow:${shadowTimestamp.toISOString()}`).digest("hex"),
      coordinates[8][0],
      shadowTimestamp,
      JSON.stringify(shadowTelemetry),
    ],
  );
  assert.deepEqual(await publishHardwarePending("TELTONIKA"), { published: 1, skipped: 0, failures: 0 });
  const shadowLocation = live.get(teltonika.vehicle.tracking_id);
  assert.equal(shadowLocation.routeVariantId, ida.id);
  assert.equal(shadowLocation.routeVariantDirection, "ida");
  assert.equal(shadowLocation.assignedRouteVariantId, undefined);
  assert.equal((await pg.query(
    "SELECT detected_route_variant_id FROM device_direction_state WHERE device_id=$1",
    [teltonika.device.id],
  )).rows[0].detected_route_variant_id, vuelta.id);
  const assignedEta = await locationsService.getEtaForRouteVariant(
    ida.id,
    { latitude: 31.86, longitude: coordinates[9][0] },
    undefined,
  );
  assert.ok(assignedEta.buses.some(bus => bus.busId === teltonika.vehicle.tracking_id));

  const insertTeltonikaPending = async (label, timestamp, longitude) => {
    const telemetry = {
      provider: teltonika.provider,
      deviceId: teltonika.device.id,
      vehicleId: teltonika.vehicle.id,
      latitude: 31.86,
      longitude,
      altitude: 10,
      speedMps: 4,
      heading: 270,
      satellites: 9,
      recordedAt: timestamp.toISOString(),
      receivedAt: timestamp.toISOString(),
      isValid: true,
      invalidReason: null,
      priority: 0,
      eventId: 0,
      io: [],
    };
    await pg.query(
      `INSERT INTO vehicle_gps_locations
       (source,device_id,vehicle_id,assignment_id,device_revision,event_key,latitude,longitude,
        speed_mps,heading,satellites,recorded_at,received_at,is_valid,telemetry,delivery_status)
       VALUES('TELTONIKA',$1,$2,$3,$4,$5,31.86,$6,4,270,9,$7,$7,true,$8,'pending')`,
      [
        teltonika.device.id,
        teltonika.vehicle.id,
        teltonika.assignment.id,
        teltonika.device.revision,
        createHash("sha256").update(`${label}:${timestamp.toISOString()}`).digest("hex"),
        longitude,
        timestamp,
        JSON.stringify(telemetry),
      ],
    );
  };

  const directionStore = require("../dist/tracking/hardwareDirectionStore");
  const originalCreateDirectionSession = directionStore.createHardwareDirectionSession;
  t.after(() => {
    directionStore.createHardwareDirectionSession = originalCreateDirectionSession;
    client.query = execute;
  });
  directionStore.createHardwareDirectionSession = async (...args) => {
    const session = await originalCreateDirectionSession(...args);
    return {
      ...session,
      persist: async () => {
        throw Object.assign(new Error("simulated shadow persistence failure"), { code: "XX000" });
      },
    };
  };
  const failedShadowTimestamp = new Date(shadowTimestamp.getTime() + 500);
  await insertTeltonikaPending("shadow-persist-failure", failedShadowTimestamp, coordinates[7][0]);
  assert.deepEqual(
    await publishHardwarePending("TELTONIKA"),
    { published: 1, skipped: 0, failures: 0 },
    "shadow persistence failure must not roll back normal delivery",
  );
  directionStore.createHardwareDirectionSession = originalCreateDirectionSession;
  const shadowFailureRow = (await pg.query(
    "SELECT delivery_status,delivery_reason FROM vehicle_gps_locations WHERE recorded_at=$1",
    [failedShadowTimestamp],
  )).rows[0];
  assert.deepEqual(shadowFailureRow, { delivery_status: "published", delivery_reason: null });
  assert.equal(live.get(teltonika.vehicle.tracking_id).routeVariantId, ida.id);
  assert.equal(directionStore.isHardwareDirectionShadowAvailable(), false);

  env.hardwareAutoDirectionMode = "off";
  await pg.exec("DROP TABLE device_direction_state");
  const offTimestamp = new Date(failedShadowTimestamp.getTime() + 500);
  await insertTeltonikaPending("off-without-033", offTimestamp, coordinates[6][0]);
  const originalClientQuery = client.query;
  const detectorQueries = [];
  client.query = async (sql, params) => {
    if (/device_direction_state|direction IN \('ida','vuelta'\)/i.test(sql)) {
      detectorQueries.push(sql);
    }
    return originalClientQuery(sql, params);
  };
  assert.deepEqual(
    await publishHardwarePending("TELTONIKA"),
    { published: 1, skipped: 0, failures: 0 },
    "off mode must work without migration 033",
  );
  client.query = originalClientQuery;
  assert.deepEqual(detectorQueries, [], "off mode must execute no detector SQL");
  const offLocation = live.get(teltonika.vehicle.tracking_id);
  assert.equal(offLocation.routeVariantId, ida.id);
  assert.equal(offLocation.routeVariantDirection, "ida");
  assert.equal(offLocation.assignedRouteVariantId, undefined);
});
