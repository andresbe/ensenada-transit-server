const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const express = require("express");
process.env.JWT_SECRET = "admin-auth-tests-only";
const db = require("../dist/db");
const cache = require("../dist/redis/cache");
const { adminInput } = require("../scripts/create-admin");

test("admin bootstrap normalizes email, preserves passwords and rejects invalid credentials", () => {
  const input = adminInput({ ADMIN_EMAIL: " Admin@Example.com ", ADMIN_PASSWORD: " password ", ADMIN_DISPLAY_NAME: " Admin " });
  assert.deepEqual(input, { email: "admin@example.com", password: " password ", displayName: "Admin" });
  for (const env of [{}, { ADMIN_EMAIL: "bad", ADMIN_PASSWORD: "password" },
    { ADMIN_EMAIL: "a@b.com", ADMIN_PASSWORD: "short" },
    { ADMIN_EMAIL: "a@b.com", ADMIN_PASSWORD: "é".repeat(37) }]) {
    assert.throws(() => adminInput(env));
  }
});

test("independent admin authentication and authorization over HTTP", async (t) => {
  const originalQuery = db.query;
  const originalLimit = cache.incrementRateLimit;
  t.after(() => { db.query = originalQuery; cache.incrementRateLimit = originalLimit; });
  let limit = 1;
  cache.incrementRateLimit = async () => limit;
  const admin = {
    id: "86d9624a-14ae-411e-8060-4a535b168fda", email: "admin@example.com",
    password_hash: await bcrypt.hash("admin-password", 12), display_name: "Admin",
    is_superadmin: true, status: "active", token_version: 1, created_at: new Date(), updated_at: new Date(),
  };
  const queries = [];
  db.query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("FROM admins")) {
      const matches = sql.includes("email = $1") ? params[0] === admin.email
        : params[0] === admin.id && params[1] === admin.token_version;
      return { rows: matches && admin.status === "active" ? [admin] : [], rowCount: matches && admin.status === "active" ? 1 : 0 };
    }
    if (sql.includes("FROM fleet_vehicles") || sql.includes("FROM routes") || sql.includes("FROM route_legacy_aliases")) return {rows:[],rowCount:0};
    // Generic login must never authenticate an independent admin.
    if (sql.includes("FROM users")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected query");
  };
  const { authRouter } = require("../dist/auth/auth.routes");
  const { authMiddleware, adminMiddleware } = require("../dist/auth/auth.middleware");
  const { usersRouter } = require("../dist/users/users.routes");
  const { favoritesRouter } = require("../dist/favorites/favorites.routes");
  const { reportsRouter } = require("../dist/reports/reports.routes");
  const { driverSessionsRouter } = require("../dist/driver-sessions/driverSessions.routes");
  const { errorHandler } = require("../dist/shared/errors");
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  app.use("/users", usersRouter);
  app.use("/favorites", favoritesRouter);
  app.use("/reports", reportsRouter);
  app.use("/driver-sessions", driverSessionsRouter);
  app.get("/protected-admin", authMiddleware, adminMiddleware, (_req, res) => res.json({ ok: true }));
  const { validateLocationUpdateAuth } = require("../dist/tracking/locationAuth");
  const { asyncHandler } = require("../dist/middleware/errorHandler");
  app.post("/driver-location", authMiddleware, asyncHandler(async (req, res) => {
    await validateLocationUpdateAuth(req, { sourceType: "driver", sourceId: "bus-driver" });
    res.json({ ok: true });
  }));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const credentials = { email: " ADMIN@EXAMPLE.COM ", password: "admin-password" };
  let token;

  await t.test("login returns a safe user and a signed admin identity", async () => {
    const response = await request("/auth/admin-login", credentials);
    assert.equal(response.status, 200);
    assert.equal(response.body.user.role, "admin");
    assert.equal(response.body.user.id, admin.id);
    assert.equal(response.body.user.password_hash, undefined);
    assert.equal(response.body.user.token_version, undefined);
    token = response.body.token;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    assert.equal(payload.identityType, "admin");
    assert.equal(payload.tokenVersion, 1);
    assert.equal(queries[0].params[0], "admin@example.com");
  });
  await t.test("unknown accounts and wrong passwords receive the same 401", async () => {
    const wrong = await request("/auth/admin-login", { ...credentials, password: "wrong-password" });
    const missing = await request("/auth/admin-login", { ...credentials, email: "user@example.com" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong, missing);
    assert.equal((await request("/auth/login", credentials)).status, 401);
    assert.equal((await request("/auth/admin-login", {})).status, 400);
    assert.equal((await request("/auth/admin-login", { ...credentials, password: "é".repeat(37) })).status, 400);
  });
  await t.test("rate limiter rejects excessive login attempts", async () => {
    limit = 6;
    assert.equal((await request("/auth/admin-login", credentials)).status, 429);
    limit = 1;
  });
  await t.test("admin profile, protected routes, tracking and refresh accept an active admin", async () => {
    assert.equal((await request("/auth/admin/me", undefined, token)).body.user.id, admin.id);
    assert.equal((await request("/protected-admin", undefined, token)).status, 200);
    assert.equal((await request("/driver-location", {}, token)).status, 200);
    const refreshed = await request("/auth/refresh", { token });
    assert.equal(refreshed.status, 200);
    assert.equal(jwt.verify(refreshed.body.token, process.env.JWT_SECRET).identityType, "admin");
  });
  await t.test("legacy admin roles, user/driver tokens, missing and expired tokens are rejected", async () => {
    for (const role of ["user", "driver", "admin"]) {
      const legacy = jwt.sign({ sub: admin.id, role }, process.env.JWT_SECRET);
      const before = queries.length;
      assert.equal((await request("/protected-admin", undefined, legacy)).status, 403);
      assert.equal((await request("/auth/admin/me", undefined, legacy)).status, 403);
      assert.equal(queries.length, before);
    }
    assert.equal((await request("/protected-admin")).status, 401);
    assert.equal((await request("/protected-admin", undefined, token + "invalid")).status, 401);
    const expired = jwt.sign({ sub: admin.id, role: "admin", identityType: "admin", tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: -1 });
    assert.equal((await request("/auth/refresh", { token: expired })).status, 401);
  });
  await t.test("admin identity cannot access user-owned records even with the same UUID", async () => {
    const before = queries.length;
    for (const path of ["/users/me", "/reports/my", "/favorites/routes"]) {
      assert.equal((await request(path, undefined, token)).status, 403);
    }
    assert.equal((await request("/driver-sessions/start", { bus_id: "bus" }, token)).status, 403);
    assert.equal(queries.length, before);
  });
  await t.test("suspension and credential rotation revoke access and refresh", async () => {
    admin.status = "suspended";
    assert.equal((await request("/auth/admin-login", credentials)).status, 401);
    assert.equal((await request("/protected-admin", undefined, token)).status, 401);
    assert.equal((await request("/auth/refresh", { token })).status, 401);
    assert.equal((await request("/driver-location", {}, token)).status, 401);
    admin.status = "active";
    admin.token_version = 2;
    assert.equal((await request("/protected-admin", undefined, token)).status, 401);
    assert.equal((await request("/auth/refresh", { token })).status, 401);
    assert.equal((await request("/auth/admin-login", credentials)).status, 200);
  });
});
