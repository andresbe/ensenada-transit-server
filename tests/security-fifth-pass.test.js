const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const path=require('node:path');
process.env.JWT_SECRET='fifth-pass-isolated';process.env.NODE_ENV='test';

test('planning validates live sessions and ETA loads current database geometry',async t=>{
 const pg=new PGlite({extensions:{pgcrypto}});t.after(()=>pg.close());
 const q=async(s,p)=>p?pg.query(s,p):(await pg.exec(s)).at(-1);
 await require('../scripts/migration-runner').migrate({query:q},path.resolve('src/db/migrations'),()=>{});
 const db=require('../dist/db');db.query=q;
 require('../dist/redis/cache').incrementRateLimit=async()=>1;
 const r=(await q("INSERT INTO routes(name,short_name,visible_in_app) VALUES('Review','R',true) RETURNING id")).rows[0].id;
 const v=(await q("INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'Ida','ida','[[-116.6,31.8],[-116.6,31.83]]') RETURNING id",[r])).rows[0].id;
 await q("INSERT INTO stops(route_id,variant_id,name,latitude,longitude,sequence) VALUES($1,$2,'Board',31.81,-116.6,1),($1,$2,'Exit',31.82,-116.6,2)",[r,v]);
 const driver=(await q("INSERT INTO users(email,role) VALUES('review@test.local','driver') RETURNING id")).rows[0].id;
 const session=(await q("INSERT INTO driver_sessions(driver_id,bus_id,route_id) VALUES($1,'review-bus',$2) RETURNING id",[driver,r])).rows[0].id;
 const sample={busId:'review-bus',sourceId:driver,sourceType:'driver',sessionId:session,routeId:r,routeVariantId:v,latitude:31.805,longitude:-116.6,timestamp:Date.now(),isStale:false,directionConfidence:'high',isStopped:false,avgSpeedMps:10};
 const locations=require('../dist/modules/locations/locations.service').locationsService;
 let failLive=false;locations.getLiveBuses=async()=>{if(failLive)throw new Error('isolated outage');return [sample];};locations.getLiveBusesByRouteVariant=async()=>[];
 const express=require('express'),app=express();app.use(express.json());app.use(require('../dist/passengers/journeyPlanner.routes').journeyPlannerRouter);app.use('/routes',require('../dist/modules/routes/routes.routes').routesRouter);app.use(require('../dist/shared/errors').errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const plan=async()=>{const response=await fetch(base+'/journeys/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:{latitude:31.81,longitude:-116.6},destination:{latitude:31.82,longitude:-116.6}})});assert.equal(response.status,200);return response.json();};
 await t.test('active service supplies arrival; ended or replaced service never does',async()=>{
  let result=await plan();assert.equal(result.plans[0].activeBuses,1);assert.equal(result.plans[0].arrival.busId,'review-bus');
  await q("UPDATE driver_sessions SET status='ended',ended_at=now() WHERE id=$1",[session]);
  result=await plan();assert.equal(result.plans[0].activeBuses,0);assert.equal(result.plans[0].arrival,null);
  await q("INSERT INTO driver_sessions(driver_id,bus_id,route_id) VALUES($1,'review-bus',$2)",[driver,r]);
  result=await plan();assert.equal(result.plans[0].activeBuses,0);assert.equal(result.plans[0].arrival,null);
  await q('DELETE FROM stops WHERE route_id=$1',[r]);result=await plan();assert.equal(result.plans[0].matchType,'near_destination');assert.equal(result.plans[0].activeBuses,0);
 });
 await t.test('live failure retains route coverage without claiming live availability',async()=>{
  failLive=true;const result=await plan();assert.equal(result.liveAvailable,false);assert.equal(result.plans.length,1);assert.equal(result.plans[0].arrival,null);failLive=false;
 });
 await t.test('cold ETA succeeds without GPS and reloads edited geometry',async()=>{
  const geometry=require('../dist/modules/routes/routeGeometry.service').routeGeometryService;
  assert.equal(geometry.getRouteGeometry(v),undefined);
  const uri=base+'/routes/'+v+'/eta?userLat=31.81&userLng=-116.6';
  let response=await fetch(uri);assert.equal(response.status,200);assert.equal((await response.json()).user.snappedLongitude,-116.6);
  await q("UPDATE route_variants SET coordinates='[[-116.59,31.8],[-116.59,31.83]]' WHERE id=$1",[v]);
  response=await fetch(uri);assert.equal(response.status,200);assert.equal((await response.json()).user.snappedLongitude,-116.59);
  await q('UPDATE routes SET visible_in_app=false WHERE id=$1',[r]);assert.equal((await fetch(uri)).status,404);
 });
});
