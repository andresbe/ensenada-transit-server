const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "accounts-tests-only";
const db = require("../dist/db");
const cache = require("../dist/redis/cache");
const { platformRouter } = require("../dist/tenancy/platform.routes");
const { adminUsersRouter } = require("../dist/admin/users.routes");
const { errorHandler } = require("../dist/shared/errors");

test("account directories require a current superadmin and expose only public fields", async t => {
  const originalQuery = db.query;
  const originalLimit = cache.incrementRateLimit;
  t.after(() => { db.query = originalQuery; cache.incrementRateLimit = originalLimit; });
  cache.incrementRateLimit = async () => 1;
  let superadmin = true;
  let active = true;
  let listQueries = 0;
  db.query = async (sql, params) => {
    if (sql.includes("FROM admins") && sql.includes("WHERE")) {
      return { rows: active ? [{ id: "admin", status: "active", token_version: 1, is_superadmin: superadmin }] : [] };
    }
    listQueries++;
    assert.doesNotMatch(sql, /password|token_version|SELECT\s+\*/i);
    assert.match(sql, /LIMIT 200/);
    if (sql.includes("FROM admins")) return { rows: [{ id: "admin", email: "admin@example.com", display_name: "Admin", status: "active", is_superadmin: true }] };
    assert.match(sql, /FROM users/);
    assert.deepEqual(params, ["user"]);
    return { rows: [{ id: "passenger", email: "user@example.com", status: "active" }] };
  };
  const app = express();
  app.use(express.json());
  app.use("/admin/platform", platformRouter);
  app.use("/admin/users", adminUsersRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ sub: "86d9624a-14ae-411e-8060-4a535b168fda", role: "admin", identityType: "admin", tokenVersion: 1 }, process.env.JWT_SECRET);
  const request = (path, bearer = token, method = "GET") => fetch(base + path, { method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  for (const path of ["/admin/platform/admins", "/admin/users?role=user"]) {
    assert.equal((await request(path, null)).status, 401);
    superadmin = false;
    assert.equal((await request(path)).status, 403);
    superadmin = true;
    const response = await request(path);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal((body.admins ?? body.users).length, 1);
    assert.doesNotMatch(JSON.stringify(body), /password|token_version/);
    active = false;
    assert.equal((await request(path)).status, 401);
    active = true;
    const passenger = jwt.sign({ sub: "passenger", role: "user" }, process.env.JWT_SECRET);
    assert.equal((await request(path, passenger)).status, 403);
  }
  superadmin = false;
  for (const [path, method] of [["/admin/platform/admins", "POST"], ["/admin/users", "POST"], ["/admin/users/user", "PATCH"], ["/admin/users/user/tester", "PATCH"]]) {
    assert.equal((await request(path, token, method)).status, 403);
  }
  assert.equal(listQueries, 2, "Unauthorized requests must never query account directories");
});
