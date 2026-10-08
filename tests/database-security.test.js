const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { migrate } = require("../scripts/migration-runner");
const { databaseOptions } = require("../scripts/database-options");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "security-tests-only-do-not-use-in-production";

test("production PostgreSQL verifies certificates and rejects URL overrides", () => {
  const env = { NODE_ENV: "production", DATABASE_URL: "postgres://user:pass@db.test/db" };
  assert.equal(databaseOptions(env).ssl.rejectUnauthorized, true);
  assert.equal(databaseOptions({ ...env, DATABASE_SSL_CA: "a\\nb" }).ssl.ca, "a\nb");
  assert.equal(databaseOptions({ ...env, DATABASE_SSL_MODE: "disable" }).ssl, false);
  assert.throws(() => databaseOptions({ ...env, DATABASE_URL: env.DATABASE_URL + "?sslmode=no-verify" }));
  assert.throws(() => databaseOptions({ ...env, DATABASE_SSL_MODE: "prefer" }));
});

test("JWT rejects default secrets, unexpected algorithms and invalid claims", () => {
  const { jwtSecret } = require("../dist/auth/tokenConfig");
  const saved = process.env.JWT_SECRET;
  try {
    delete process.env.JWT_SECRET;
    assert.throws(jwtSecret);
    process.env.JWT_SECRET = "change_me_in_production";
    assert.throws(jwtSecret);
    process.env.JWT_SECRET = "short";
    process.env.NODE_ENV = "production";
    assert.throws(jwtSecret);
  } finally {
    process.env.JWT_SECRET = saved;
    process.env.NODE_ENV = "test";
  }
  const jwt = require("jsonwebtoken");
  const { validateToken } = require("../dist/auth/auth.service");
  assert.throws(() => validateToken(jwt.sign({ sub: "x", role: "user" }, saved, { algorithm: "HS384" })));
  assert.throws(() => validateToken(jwt.sign({ sub: "x", role: "root" }, saved)));
  assert.equal(validateToken(jwt.sign({ sub: "x", role: "user" }, saved)).role, "user");
});

test("driver login never accepts a stored plaintext password", async () => {
  const db = require("../dist/db");
  const original = db.query;
  db.query = async () => ({ rows: [{ correo: "driver@example.test", password: "plaintext", nombre_usuario: "Test" }] });
  try {
    await assert.rejects(require("../dist/auth/auth.service").loginConductor("driver@example.test", "plaintext"), (error) => error.statusCode === 401);
  } finally { db.query = original; }
});

test("database rejects cross-route references and invalid domain values without HTTP validation", async (t) => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  t.after(() => pg.close());
  const client = { query: async (sql, params) => params ? pg.query(sql, params) : (await pg.exec(sql)).at(-1) };
  await migrate(client, path.join(__dirname, "../src/db/migrations"), () => {});
  const user = (await pg.query("INSERT INTO users(auth_provider) VALUES('guest') RETURNING id")).rows[0].id;
  const routes = (await pg.query("INSERT INTO routes(name,short_name) VALUES('A','A'),('B','B') RETURNING id")).rows;
  const variant = (await pg.query("INSERT INTO route_variants(route_id,name,direction) VALUES($1,'A outbound','ida') RETURNING id", [routes[0].id])).rows[0].id;
  for (const table of ["saved_journeys", "passenger_trips"]) {
    await assert.rejects(pg.query(`INSERT INTO ${table}(user_id,route_id,variant_id,client_id) VALUES($1,$2,$3,'bad')`, [user, routes[1].id, variant]), (e) => e.code === "23503");
  }
  await assert.rejects(pg.query("INSERT INTO stops(route_id,variant_id,name,latitude,longitude) VALUES($1,$2,'Bad',31,-116)", [routes[1].id, variant]), (e) => e.code === "23503");
  await assert.rejects(pg.query("INSERT INTO user_reports(user_id,type,route_id,variant_id) VALUES($1,'delay',$2,$3)", [user, routes[1].id, variant]), (e) => e.code === "23503");
  for (const sql of [
    "UPDATE users SET role='root'",
    "UPDATE route_variants SET direction='sideways'",
    "UPDATE routes SET service_days=ARRAY[8]",
    "UPDATE routes SET estimated_cycle_minutes=0",
    "UPDATE route_variants SET total_distance_meters='NaN'",
  ]) await assert.rejects(pg.exec(sql), (e) => e.code === "23514");
  await assert.rejects(pg.query("INSERT INTO stops(route_id,variant_id,name,latitude,longitude) VALUES($1,$2,'Bad',91,-116)", [routes[0].id, variant]), (e) => e.code === "23514");
  await assert.rejects(pg.query("INSERT INTO passenger_trips(user_id,route_id,client_id,status) VALUES($1,$2,'bad','completed')", [user, routes[0].id]), (e) => e.code === "23514");
  // Correct relationships remain valid; deleting a variant preserves historical reports.
  await pg.query("INSERT INTO user_reports(user_id,type,route_id,variant_id) VALUES($1,'delay',$2,$3)", [user, routes[0].id, variant]);
  await pg.query("DELETE FROM route_variants WHERE id=$1", [variant]);
  assert.equal((await pg.query("SELECT variant_id FROM user_reports")).rows[0].variant_id, null);
});
