const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

test("real Redis keeps newest cross-provider sample and does not renew duplicate TTL", {
  skip: !process.env.TELTONIKA_TEST_REDIS_URL, timeout: 15000,
}, async () => {
  const url = new URL(process.env.TELTONIKA_TEST_REDIS_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "test Redis must be local");
  process.env.REDIS_URL = url.href;
  const { default: redis, connectRedis } = require("../dist/redis/client");
  const cache = require("../dist/redis/cache");
  const busId = `teltonika-test-${randomUUID()}`, timestamp = Date.now();
  await connectRedis();
  const point = (provider, stamp, sessionId) => ({ busId, provider, timestamp: stamp, updatedAt: Date.now(), sessionId });
  try {
    await cache.setLiveBusLocation(busId, point("ANDROID", timestamp, "android-session"), 60);
    await cache.setLiveBusLocation(busId, point("TELTONIKA", timestamp - 1), 60);
    assert.equal((await cache.getLiveBusLocation(busId)).provider, "ANDROID");
    await cache.setLiveBusLocation(busId, point("TELTONIKA", timestamp + 1), 60);
    await cache.setLiveBusLocation(busId, point("ANDROID", timestamp, "new-session"), 60);
    assert.equal((await cache.getLiveBusLocation(busId)).provider, "TELTONIKA");
    await redis.pExpire(cache.busLocationKey(busId), 5000);
    const ttl = await redis.pTTL(cache.busLocationKey(busId));
    await cache.setLiveBusLocation(busId, point("TELTONIKA", timestamp + 1), 60);
    assert.ok(await redis.pTTL(cache.busLocationKey(busId)) <= ttl);
    await Promise.all(Array.from({ length: 50 }, (_, i) => cache.setLiveBusLocation(busId,
      point(i % 2 ? "TELTONIKA" : "ANDROID", timestamp + 2 + (i * 17) % 50), 60)));
    assert.equal((await cache.getLiveBusLocation(busId)).timestamp, timestamp + 51);
  } finally {
    await redis.del(cache.busLocationKey(busId)); await redis.sRem(cache.liveBusesIndexKey(), busId); await redis.quit();
  }
});
