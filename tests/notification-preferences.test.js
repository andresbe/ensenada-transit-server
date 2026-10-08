const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.JWT_SECRET = "notification-preferences-test-only";

test("profile returns persisted push preferences for the authenticated user", async t => {
  const db = require("../dist/db");
  const original = db.query;
  const owner = "10000000-0000-4000-8000-000000000001";
  db.query = async (sql, params) => {
    assert.equal(params[0], owner);
    if (sql.includes("FROM user_preferences")) return { rows: [{ user_id: owner, push_notifications_enabled: true, favorite_route_alerts: true, language: "es" }], rowCount: 1 };
    return { rows: [{ id: owner, status: "active", role: "user" }], rowCount: 1 };
  };
  const cache = require("../dist/redis/cache");
  const originalRateLimit = cache.incrementRateLimit;
  cache.incrementRateLimit = async () => 0;
  const express = require("express");
  const app = express();
  app.use("/users", require("../dist/users/users.routes").usersRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    db.query = original;
    cache.incrementRateLimit = originalRateLimit;
    await new Promise(resolve => server.close(resolve));
  });
  const token = require("jsonwebtoken").sign({ sub: owner, role: "user" }, process.env.JWT_SECRET);
  const url = `http://127.0.0.1:${server.address().port}/users/me`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const profile = await response.json();
  assert.equal(profile.preferences.push_notifications_enabled, true);
  assert.equal(profile.preferences.user_id, owner);
});
