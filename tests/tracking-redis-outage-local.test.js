const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const net = require("node:net");
const { once } = require("node:events");

test("live location fails during a real Redis outage and resumes after reconnect", {
  skip: process.env.RUN_LOCAL_LIFECYCLE !== "1", timeout: 45000,
}, async (t) => {
  const name = `transit-redis-outage-${randomUUID()}`;
  const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 15000 }).trim();
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port}:6379`, "redis:7-alpine");
  t.after(() => { try { docker("rm", "-f", name); } catch {} });
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  const { default: redis, connectRedis } = require("../dist/redis/client");
  const { setLiveBusLocation, getLiveBusLocation } = require("../dist/redis/cache");
  t.after(async () => { if (redis.isOpen) await redis.disconnect(); });
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for Redis state");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await connectRedis();
  const busId = name;
  const first = { busId, sessionId: randomUUID(), timestamp: Date.now(), updatedAt: Date.now() };
  await setLiveBusLocation(busId, first, 60);
  assert.equal((await getLiveBusLocation(busId)).sessionId, first.sessionId);

  docker("stop", name);
  await waitUntil(() => !redis.isReady);
  await assert.rejects(setLiveBusLocation(busId, { ...first, timestamp: first.timestamp + 1000 }, 60));

  docker("start", name);
  await waitUntil(() => redis.isReady);
  const resumed = { ...first, timestamp: Date.now() + 1000, updatedAt: Date.now() };
  await setLiveBusLocation(busId, resumed, 60);
  assert.equal((await getLiveBusLocation(busId)).timestamp, resumed.timestamp);
});
