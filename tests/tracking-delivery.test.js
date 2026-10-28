const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = "tracking-delivery-test-secret";

test("Redis write failure is propagated to the location publisher", async (t) => {
  const redis = require("../dist/redis/client").default;
  const cache = require("../dist/redis/cache");
  const original = redis.eval;
  redis.eval = async () => { throw new Error("Redis disconnected"); };
  t.after(() => { redis.eval = original; });
  await assert.rejects(
    cache.setLiveBusLocation("test-bus", { busId: "test-bus", timestamp: Date.now() }, 60),
    /Redis disconnected/,
  );
});

test("failed older delivery cannot erase a newer bus position", async (t) => {
  const cache = require("../dist/redis/cache");
  const original = cache.getLiveBusLocations;
  cache.getLiveBusLocations = async () => [];
  t.after(() => { cache.getLiveBusLocations = original; });
  const { locationsService } = require("../dist/modules/locations/locations.service");
  const now = Date.now();
  const base = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    sourceId: "driver", sourceType: "driver", busId: `delivery-${now}`,
    routeId: "route", routeVariantId: "variant", routeVariantDirection: "ida",
    latitude: 31.8, longitude: -116.6, accuracy: 10,
  };
  const older = locationsService.updateLocation({ ...base, timestamp: now - 1000 });
  const newer = locationsService.updateLocation({ ...base, timestamp: now, longitude: -116.6001 });
  locationsService.discardUnconfirmedLocation(older);
  assert.equal((await locationsService.getLiveBuses()).find(bus => bus.busId === base.busId)?.timestamp, newer.timestamp);
  locationsService.discardUnconfirmedLocation(newer);
  assert.equal((await locationsService.getLiveBuses()).some(bus => bus.busId === base.busId), false);
});

test("driver location is acknowledged only after Redis accepts it, then recovers on retry", async (t) => {
  const express = require("express");
  const auth = require("../dist/auth/auth.middleware");
  const limiter = require("../dist/middleware/rateLimiter");
  const identity = require("../dist/passengers/identity");
  const locationAuth = require("../dist/tracking/locationAuth");
  const checkpoints = require("../dist/driver-sessions/checkpoints.service");
  const geometry = require("../dist/modules/routes/routeGeometry.service");
  const locations = require("../dist/modules/locations/locations.service");
  const cache = require("../dist/redis/cache");
  const originals = {
    auth: auth.optionalAuthMiddleware,
    limiter: limiter.apiRateLimiter,
    ids: identity.canonicalTrackingIds,
    locationAuth: locationAuth.validateLocationUpdateAuth,
    checkin: checkpoints.registerGpsCheckin,
    geometry: geometry.routeGeometryService.ensureRouteGeometry,
    update: locations.locationsService.updateLocation,
    discard: locations.locationsService.discardUnconfirmedLocation,
    set: cache.setLiveBusLocation,
  };
  t.after(() => {
    auth.optionalAuthMiddleware = originals.auth;
    limiter.apiRateLimiter = originals.limiter;
    identity.canonicalTrackingIds = originals.ids;
    locationAuth.validateLocationUpdateAuth = originals.locationAuth;
    checkpoints.registerGpsCheckin = originals.checkin;
    geometry.routeGeometryService.ensureRouteGeometry = originals.geometry;
    locations.locationsService.updateLocation = originals.update;
    locations.locationsService.discardUnconfirmedLocation = originals.discard;
    cache.setLiveBusLocation = originals.set;
  });
  auth.optionalAuthMiddleware = (req, _res, next) => { req.user = { sub: "driver", role: "driver" }; next(); };
  limiter.apiRateLimiter = (_req, _res, next) => next();
  identity.canonicalTrackingIds = async () => ({});
  locationAuth.validateLocationUpdateAuth = async () => {};
  checkpoints.registerGpsCheckin = async () => undefined;
  geometry.routeGeometryService.ensureRouteGeometry = async () => {};
  const discarded = [];
  locations.locationsService.updateLocation = (payload) => ({ ...payload, updatedAt: Date.now() });
  locations.locationsService.discardUnconfirmedLocation = (location) => discarded.push(location);
  let fail = true;
  cache.setLiveBusLocation = async () => { if (fail) throw new Error("Redis disconnected"); };

  const app = express();
  app.use(express.json());
  app.use(require("../dist/tracking/locations.routes").trackingRouter);
  app.use(require("../dist/shared/errors").errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/locations/update`;
  const body = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    sourceId: "driver", sourceType: "driver", busId: "bus", routeId: "route",
    routeVariantId: "variant", routeVariantDirection: "ida",
    latitude: 31.8, longitude: -116.6, accuracy: 10, timestamp: Date.now(),
  };
  const send = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const failed = await send();
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error.message, /reintentando/i);
  assert.equal(discarded.length, 1);
  fail = false;
  const recovered = await send();
  assert.equal(recovered.status, 201);
  assert.equal((await recovered.json()).timestamp, body.timestamp);
  assert.equal(discarded.length, 1);
});
