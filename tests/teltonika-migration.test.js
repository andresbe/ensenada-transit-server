const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { migrate } = require("../scripts/migration-runner");
const folder = path.join(__dirname, "../src/db/migrations");

test("031/032 upgrade populated production 029/030 without rewriting history or checksums", async t => {
  const checksums = {
    "029_tracking_devices.sql": "8b0fc80d89206320c53cde1875d56fd3dc6e5f76f1f2865edb95f35355c540d4",
    "030_vehicle_gps_locations.sql": "a6be04d37ea4830d55bb3b93fdc31c922bd4641937e2bec9700f0b5b6a3f0444",
  };
  const names = fs.readdirSync(folder).filter(f => f.endsWith(".sql")).sort();
  assert.equal(new Set(names.map(f => f.split("_")[0])).size, names.length, "no migration number collision");
  for (const [name, checksum] of Object.entries(checksums)) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(folder, name))).digest("hex"), checksum);
  }
  const oldFolder = fs.mkdtempSync(path.join(os.tmpdir(), "teltonika-upgrade-"));
  t.after(() => fs.rmSync(oldFolder, { recursive: true, force: true }));
  for (const name of names.filter(f => f < "031")) fs.copyFileSync(path.join(folder, name), path.join(oldFolder, name));
  const pg = new PGlite({ extensions: { pgcrypto } }); t.after(() => pg.close());
  const client = { query: async (s, p) => p ? pg.query(s, p) : (await pg.exec(s)).at(-1) ?? { rows: [] } };
  await migrate(client, oldFolder, () => {});
  const device = (await pg.query("INSERT INTO tracking_devices(imei,status,model) VALUES('356307042441013','inactive','FTC927') RETURNING *")).rows[0];
  const vehicle = (await pg.query("INSERT INTO fleet_vehicles(economic_number,is_test_vehicle) VALUES('EXISTING-TEST',true) RETURNING *")).rows[0];
  const assignment = (await pg.query("INSERT INTO vehicle_device_assignments(device_id,vehicle_id) VALUES($1,$2) RETURNING *", [device.id, vehicle.id])).rows[0];
  await pg.query(`INSERT INTO vehicle_gps_locations(source,device_id,vehicle_id,latitude,longitude,recorded_at,event_key)
    VALUES('TELTONIKA',$1,$2,31.866,-116.616,now(),'existing-event')`, [device.id, vehicle.id]);
  await pg.query(`INSERT INTO vehicle_gps_locations(source,vehicle_id,latitude,longitude,recorded_at)
    VALUES('ANDROID',$1,31.866,-116.616,now())`, [vehicle.id]);
  const history = (await pg.query("SELECT * FROM vehicle_gps_locations ORDER BY id")).rows;
  const journal = (await pg.query("SELECT * FROM schema_migrations ORDER BY name")).rows;
  const logs = [];
  await migrate(client, folder, m => logs.push(m));
  assert.deepEqual(logs.filter(m => m.includes("Applying")), [
    "[migrate] Applying 031_teltonika_ingestion.sql",
    "[migrate] Applying 032_ruptela_ingestion.sql",
  ]);
  const upgraded = (await pg.query("SELECT * FROM vehicle_gps_locations ORDER BY id")).rows;
  for (let i = 0; i < history.length; i++) {
    for (const key of Object.keys(history[i])) assert.deepEqual(upgraded[i][key], history[i][key]);
    assert.equal(upgraded[i].delivery_status, "skipped", "never publish preexisting rows during upgrade");
    assert.equal(upgraded[i].telemetry, null);
  }
  const mapped = (await pg.query("SELECT * FROM vehicle_device_assignments")).rows[0];
  for (const key of Object.keys(assignment)) assert.deepEqual(mapped[key], assignment[key]);
  assert.equal(mapped.route_variant_id, null);
  const current = (await pg.query("SELECT * FROM tracking_devices")).rows[0];
  assert.equal(current.status, "inactive"); assert.equal(current.public_visible, false); assert.equal(current.revision, 1);
  assert.equal((await pg.query("SELECT to_regclass('tracking_telemetry') AS duplicate")).rows[0].duplicate, null);
  assert.equal((await pg.query("SELECT to_regclass('tracking_device_packet_diagnostics') AS diagnostics")).rows[0].diagnostics, "tracking_device_packet_diagnostics");
  const ruptela = (await pg.query("INSERT INTO tracking_devices(imei,provider) VALUES('863071016796572','RUPTELA') RETURNING id")).rows[0];
  await pg.query(`INSERT INTO vehicle_gps_locations(source,device_id,latitude,longitude,recorded_at,event_key)
    VALUES('RUPTELA',$1,31.866,-116.616,now(),'ruptela-event')`, [ruptela.id]);
  assert.equal((await pg.query("SELECT source FROM vehicle_gps_locations WHERE device_id=$1", [ruptela.id])).rows[0].source, "RUPTELA");
  assert.deepEqual((await pg.query("SELECT * FROM schema_migrations WHERE name<'031' ORDER BY name")).rows, journal);
  const repeat = []; await migrate(client, folder, m => repeat.push(m));
  assert.equal(repeat.filter(m => m.includes("Applying")).length, 0);
});
