const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'route-import-tests';
const db = require('../dist/db');
const cache = require('../dist/redis/cache');
const redis = require('../dist/redis/client');
const { parseRouteGeoJson } = require('../dist/routes/geojson');
const { importRoute } = require('../dist/routes/importRoute.service');
const line = { type: 'LineString', coordinates: [[-116.6, 31.8], [-116.6, 31.81]] };
const input = () => ({ name: 'Test route', short_name: 'T', variants: [{ direction: 'ida', geojson: line }] });

test('GeoJSON validates coordinates, distance, wrappers and connected segments', () => {
  const result = parseRouteGeoJson(line);
  assert.ok(result.distance > 1111 && result.distance < 1113);
  assert.deepEqual(parseRouteGeoJson({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: line }] }), result);
  const connected = parseRouteGeoJson({ type: 'MultiLineString', coordinates: [line.coordinates, [[-116.6, 31.81], [-116.6, 31.82]]] });
  assert.equal(connected.coordinates.length, 3);
  assert.ok(connected.distance > 2223);
  for (const geometry of [
    { type: 'FeatureCollection', features: [] },
    { type: 'Point', coordinates: [-116, 31] },
    { type: 'LineString', coordinates: [[-116, 91], [-116, 31]] },
    { type: 'LineString', coordinates: [[-116, 31], [-116, 31]] },
    { type: 'LineString', coordinates: [[NaN, 31], [-116, 31]] },
    { type: 'MultiLineString', coordinates: [line.coordinates, [[-115, 32], [-114, 32]]] },
  ]) assert.throws(() => parseRouteGeoJson(geometry), { statusCode: 400 });
});

test('import HTTP authorization, atomic writes, reloading geometry and ETA', async (t) => {
  const originals = { getClient: db.getClient, query: db.query, invalidate: cache.invalidateRoutesCache, limit: cache.incrementRateLimit, live: cache.getLiveBusLocations, set: cache.setLiveBusLocation, connect: redis.connectRedis };
  t.after(() => {
    db.getClient = originals.getClient; db.query = originals.query;
    cache.invalidateRoutesCache = originals.invalidate; cache.incrementRateLimit = originals.limit;
    cache.getLiveBusLocations = originals.live; cache.setLiveBusLocation = originals.set;
    redis.connectRedis = originals.connect;
  });
  const routeId = '10000000-0000-4000-8000-000000000001';
  const variantId = '20000000-0000-4000-8000-000000000001';
  let statements = [], released = 0, invalidated = 0, failVariant = false, rows = [];
  db.getClient = async () => ({
    release() { released++; },
    async query(sql, values) {
      statements.push(sql);
      if (sql.startsWith('INSERT INTO routes ')) return { rows: [{ id: routeId, name: values[0] }] };
      if (sql.includes('INSERT INTO route_variants')) {
        if (failVariant && values[2] === 'vuelta') throw new Error('simulated insert failure');
        rows = [{ id: variantId, route_id: values[0], name: values[1], direction: values[2], coordinates: JSON.parse(values[3]), total_distance_meters: values[4] }];
        return { rows };
      }
      return { rows: [] };
    },
  });
  db.query = async (sql) => {
    if (sql.includes('FROM admins')) return { rows: [{ id: 'admin', is_superadmin: true, status: 'active', token_version: 1 }], rowCount: 1 };
    if (sql.includes('SELECT id FROM routes')) return {rows:[{id:routeId}],rowCount:1};
    if (sql.includes('FROM route_variants')) return { rows, rowCount: rows.length };
    throw new Error(`Unexpected SQL ${sql}`);
  };
  cache.invalidateRoutesCache = async () => { invalidated++; };
  cache.incrementRateLimit = async () => 1;
  cache.getLiveBusLocations = async () => [];
  cache.setLiveBusLocation = async () => {};
  redis.connectRedis = async () => {};
  const { app } = require('../dist/app');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ sub: '30000000-0000-4000-8000-000000000001', role: 'admin', identityType: 'admin', tokenVersion: 1 }, process.env.JWT_SECRET);
  const post = (body, auth = token) => fetch(base + '/db-routes/import', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post(input(), null)).status, 401);
  assert.equal((await post(input(), jwt.sign({ sub: 'u', role: 'user' }, process.env.JWT_SECRET))).status, 403);
  assert.equal(statements.length, 0);
  const invalid = input(); invalid.variants.push({ direction: 'vuelta', geojson: { type: 'Point' } });
  assert.equal((await post(invalid)).status, 400);
  assert.equal(statements.length, 0);
  const duplicate = input(); duplicate.variants.push(duplicate.variants[0]);
  await assert.rejects(importRoute(duplicate), { statusCode: 400 });
  // Pass the ordinary 100 KB parser limit through the real app middleware.
  const response = await post({ ...input(), description: 'x'.repeat(120000) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.route.variants[0].id, variantId);
  assert.ok(body.route.variants[0].total_distance_meters > 1111);
  assert.equal(statements[0], 'BEGIN'); assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(released, 1); assert.equal(invalidated, 1);

  // No registration in the importing process: geometry is recovered from DB.
  const { routeGeometryService } = require('../dist/modules/routes/routeGeometry.service');
  assert.equal(routeGeometryService.getRouteGeometry(variantId), undefined);
  const location = await fetch(base + '/locations/update', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt.sign({ sub: 'test', role: 'user' }, process.env.JWT_SECRET)}` },
    body: JSON.stringify({ sourceId: 'test', sourceType: 'user', busId: 'test-import-bus', routeId, routeVariantId: variantId,
      routeVariantDirection: 'ida', latitude: 31.802, longitude: -116.6, timestamp: Date.now(), speed: 5 }),
  });
  assert.equal(location.status, 201);
  const locationBody = await location.json();
  assert.ok(locationBody.routeProgressMeters > 200);
  const eta = await fetch(base + `/routes/${variantId}/eta?userLat=31.808&userLng=-116.6`);
  assert.equal(eta.status, 200);
  const etaBody = await eta.json();
  assert.ok(etaBody.user.progressMeters > 800);
  assert.equal(etaBody.buses[0].busId, 'test-import-bus');
  assert.ok(etaBody.buses[0].etaToUserSeconds > 0);
  assert.ok(routeGeometryService.getRouteGeometry('ruta_violeta_ida'));

  statements = []; failVariant = true;
  const both = input();
  both.variants.push({ direction: 'vuelta', geojson: { type: 'LineString', coordinates: [...line.coordinates].reverse() } });
  await assert.rejects(importRoute(both), /simulated insert failure/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.filter(sql => sql.includes('INSERT INTO route_variants')).length, 2);
  assert.ok(!statements.includes('COMMIT'));
  assert.equal(released, 2); assert.equal(invalidated, 1);
  failVariant = false;
  const two = await importRoute(both);
  assert.deepEqual(two.variants.map(v => v.direction), ['ida', 'vuelta']);
  assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(released, 3); assert.equal(invalidated, 2);
  const malformed = await fetch(base + '/db-routes/import', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await post({ ...input(), description: 'x'.repeat(10 * 1024 * 1024) })).status, 413);
});

test('stops and publication are validated and committed atomically', async (t) => {
  const oldClient = db.getClient, oldInvalidate = cache.invalidateRoutesCache;
  t.after(() => { db.getClient = oldClient; cache.invalidateRoutesCache = oldInvalidate; });
  let statements = [], failStop = false;
  db.getClient = async () => ({ release() {}, async query(sql, values) {
    statements.push({ sql, values });
    if (sql.startsWith('INSERT INTO routes')) return { rows: [{ id: 'route' }] };
    if (sql.includes('INSERT INTO route_variants')) return { rows: [{ id: 'variant' }] };
    if (sql.includes('INSERT INTO stops') && failStop) throw new Error('stop failed');
    return { rows: [] };
  } });
  cache.invalidateRoutesCache = async () => {};
  const body = input(); body.visible_in_app = false;
  body.variants[0].stops = [{ name: 'Centro', longitude: -116.6, latitude: 31.8 }];
  await importRoute(body);
  assert.equal(statements.find(s => s.sql.startsWith('INSERT INTO routes')).values[4], false);
  assert.deepEqual(statements.find(s => s.sql.includes('INSERT INTO stops')).values, ['route', 'variant', 'Centro', -116.6, 31.8, 0]);
  assert.equal(statements.at(-1).sql, 'COMMIT');
  statements = []; failStop = true;
  await assert.rejects(importRoute(body), /stop failed/);
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
  assert.ok(!statements.some(s => s.sql === 'COMMIT'));
  statements = [];
  body.variants[0].stops[0].latitude = 91;
  await assert.rejects(importRoute(body), { statusCode: 400 });
  assert.equal(statements.length, 0);
  await assert.rejects(importRoute({ ...input(), visible_in_app: 'true' }), { statusCode: 400 });
});
