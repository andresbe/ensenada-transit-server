const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
process.env.JWT_SECRET = "nearby-routes-test-only";

test("nearby routes use nearest stops and exclude unpublished and inactive lines", async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE transport_lines(id text, active boolean);
    CREATE TABLE routes(id text, active boolean, visible_in_app boolean, transport_line_id text);
    CREATE TABLE stops(id text, name text, route_id text, latitude float8, longitude float8);
    INSERT INTO transport_lines VALUES ('disabled',false);
    INSERT INTO routes VALUES ('near',true,true,null),('far',true,true,null),('hidden',true,false,null),('disabled',true,true,'disabled'),('inactive',false,true,null);
    INSERT INTO stops VALUES ('n1','Nearest','near',31.8601,-116.60),('n2','Other','near',31.861,-116.60),
      ('f','Far','far',32.5,-116.60),('h','Hidden','hidden',31.86,-116.60),
      ('d','Disabled','disabled',31.86,-116.60),('i','Inactive','inactive',31.86,-116.60);`);
  const db = require('../dist/db');
  db.query = (sql, params) => pg.query(sql, params);
  require('../dist/redis/cache').incrementRateLimit = async () => 0;
  const app = require('express')();
  app.use(require('../dist/passengers/catalog.routes').catalogRouter);
  app.use(require('../dist/shared/errors').errorHandler);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const url = 'http://127.0.0.1:'+server.address().port+'/nearby-routes';
  try {
    const response = await fetch(url+'?lat=31.86&lng=-116.60&radius=2000');
    assert.equal(response.status,200);
    const data = await response.json();
    assert.deepEqual(data.routes.map(r=>r.route_id),['near']);
    assert.equal(data.routes[0].stop_id,'n1');
    assert.equal(data.routes[0].walking_minutes,1);
    assert.equal(data.distance_basis,'straight_line');
    for(const query of ['?lat=91&lng=0','?lat=abc&lng=0','?lat=0','?lat=0&lng=0&radius=5001'])
      assert.equal((await fetch(url+query)).status,400);
    assert.deepEqual((await (await fetch(url+'?lat=0&lng=0')).json()).routes,[]);
  } finally { await new Promise(resolve=>server.close(resolve)); await pg.close(); }
});
