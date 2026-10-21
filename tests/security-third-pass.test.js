const {test}=require('node:test');
const assert=require('node:assert/strict');const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
process.env.JWT_SECRET='third-pass-isolated-tests';process.env.NODE_ENV='test';

test('legacy APIs obey public visibility, one favorite quota, route geometry and session filters',async t=>{
 const pg=new PGlite({extensions:{pgcrypto}});t.after(()=>pg.close());
 const execute=async(sql,params)=>params?pg.query(sql,params):((await pg.exec(sql)).at(-1)??{rows:[]});
 await require('../scripts/migration-runner').migrate({query:execute},path.join(__dirname,'../src/db/migrations'),()=>{});
 const db=require('../dist/db');db.query=execute;db.getClient=async()=>({query:execute,release(){}});
 require('../dist/redis/cache').incrementRateLimit=async()=>1;
 const owner=(await pg.query("INSERT INTO users(email,auth_provider) VALUES('review@test.local','email') RETURNING *")).rows[0];
 const token=require('../dist/auth/auth.service').generateToken(owner);
 const line=(await pg.query("INSERT INTO transport_lines(name,short_code,color) VALUES('Review','R','#123456') RETURNING id")).rows[0].id;
 const ids=[];for(let i=0;i<5;i++)ids.push((await pg.query("INSERT INTO routes(name,short_name,transport_line_id,visible_in_app) VALUES($1,$2,$3,$4) RETURNING id",['Route '+i,'R'+i,line,i!==0])).rows[0].id);
 const express=require('express');const app=express();app.use(express.json());
 app.use('/favorites',require('../dist/favorites/favorites.routes').favoritesRouter);
 app.use(require('../dist/passengers/passengers.routes').passengerRouter);
 app.use(require('../dist/passengers/catalog.routes').catalogRouter);
 app.use(require('../dist/tracking/locations.routes').trackingRouter);
 app.use(require('../dist/shared/errors').errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const call=(url,method='GET',body,authenticated=true)=>fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 await t.test('old and new favorite writers share quota, idempotency, deletion and tester exemption',async()=>{
  assert.equal((await call('/favorites/routes','POST',{route_id:ids[0]})).status,404);
  assert.equal((await call('/saved-journeys','POST',{route_id:ids[0],client_id:'hidden'})).status,404);
  for(let i=1;i<=3;i++)assert.equal((await call(i===2?'/saved-journeys':'/favorites/routes','POST',{route_id:ids[i],client_id:'new-'+i})).status,201);
  assert.equal((await call('/favorites/routes','POST',{route_id:ids[1]})).status,201);
  assert.equal((await call('/favorites/routes','POST',{route_id:ids[2]})).status,201);
  assert.equal((await call('/favorites/routes','POST',{route_id:ids[4]})).status,409);
  assert.equal((await call('/saved-journeys','POST',{route_id:ids[4],client_id:'four'})).status,409);
  assert.equal((await(await call('/favorites/routes')).json()).routes.length,3);
  assert.equal((await(await call('/saved-journeys')).json()).favorites.length,3);
  assert.equal((await pg.query('SELECT * FROM favorite_routes')).rows.length,0);
  assert.equal((await call('/favorites/routes/'+ids[1],'DELETE')).status,200);
  assert.equal((await call('/saved-journeys','POST',{route_id:ids[4],client_id:'four'})).status,201);
  await pg.query('UPDATE users SET is_tester=true WHERE id=$1',[owner.id]);
  assert.equal((await call('/favorites/routes','POST',{route_id:ids[1]})).status,201);
  await pg.query('UPDATE users SET is_tester=false WHERE id=$1',[owner.id]);
 });
 await t.test('public alerts and legacy favorites hide unavailable routes; own saved IDs remain removable',async()=>{
  await pg.query("INSERT INTO alerts(route_id,category,severity,title_es,description_es,published,expires_at) VALUES($1,'routes','info','Private','Private',true,now()+interval '1 day'),($2,'routes','info','Public','Public',true,now()+interval '1 day')",[ids[0],ids[1]]);
  assert.deepEqual((await(await call('/alerts','GET',undefined,false)).json()).alerts.map(a=>a.route_id),[ids[1]]);
  await pg.query('UPDATE routes SET visible_in_app=false WHERE id=$1',[ids[1]]);
  assert.equal((await(await call('/alerts')).json()).alerts.length,0);
  assert.ok(!(await(await call('/favorites/routes')).json()).routes.some(r=>r.id===ids[1]));
  const unavailable=(await(await call('/saved-journeys')).json()).favorites.find(r=>r.route_id===ids[1]);
  assert.equal(unavailable.available,false);assert.equal(unavailable.name,undefined);
  assert.equal((await call('/saved-journeys/'+unavailable.id,'DELETE')).status,204);
  await pg.query('UPDATE routes SET visible_in_app=true,active=false WHERE id=$1',[ids[1]]);
  assert.equal((await(await call('/alerts')).json()).alerts.length,0);
  await pg.query('UPDATE routes SET active=true WHERE id=$1',[ids[1]]);
  await pg.query('UPDATE transport_lines SET active=false WHERE id=$1',[line]);
  assert.equal((await(await call('/favorites/routes')).json()).routes.length,0);
  assert.equal((await(await call('/alerts')).json()).alerts.length,0);
  assert.equal((await call('/favorites/routes','POST',{route_id:ids[4]})).status,404);
  await pg.query('UPDATE transport_lines SET active=true WHERE id=$1',[line]);
 });
 await t.test('favorite stops never disclose a hidden route',async()=>{
  const variant=(await pg.query("INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'Private','ida','[[-116,31],[-116,32]]') RETURNING id",[ids[0]])).rows[0].id;
  const stop=(await pg.query("INSERT INTO stops(route_id,variant_id,name,latitude,longitude,sequence) VALUES($1,$2,'Private stop',31,-116,1) RETURNING id",[ids[0],variant])).rows[0].id;
  assert.equal((await call('/favorites/stops','POST',{stop_id:stop})).status,404);
  await pg.query('INSERT INTO favorite_stops(user_id,stop_id) VALUES($1,$2)',[owner.id,stop]);
  assert.equal((await(await call('/favorites/stops')).json()).stops.length,0);
  await pg.query('UPDATE routes SET visible_in_app=true WHERE id=$1',[ids[0]]);
  assert.equal((await(await call('/favorites/stops')).json()).stops.length,1);
  await pg.query('UPDATE routes SET visible_in_app=false WHERE id=$1',[ids[0]]);
 });
 await t.test('legacy variant writer rejects invalid geometry and derives distance',async()=>{
  const {createVariant}=require('../dist/routes/routes.service');
  for(const coordinates of [[],[[0,0]],[[999,999],[998,998]],[[0,0],[0,0]],[[0,0],[NaN,1]]]) await assert.rejects(createVariant(ids[1],{name:'Bad',direction:'ida',coordinates,total_distance_meters:1}),{statusCode:400});
  const good=await createVariant(ids[1],{name:'Good',direction:'ida',coordinates:[[-116.6,31.8],[-116.6,31.81]],total_distance_meters:1});
  assert.ok(Number(good.total_distance_meters)>1000);
  assert.equal((await pg.query('SELECT count(*)::int n FROM route_variants WHERE route_id=$1',[ids[1]])).rows[0].n,1);
 });
 await t.test('line statistics count only current driver service samples',async()=>{
  const locations=require('../dist/modules/locations/locations.service').locationsService;
  const old=locations.getLiveBuses;t.after(()=>{locations.getLiveBuses=old;});
  const driver=(await pg.query("INSERT INTO users(email,role) VALUES('driver@test.local','driver') RETURNING id")).rows[0].id;
  const session=(await pg.query("INSERT INTO driver_sessions(driver_id,bus_id,route_id) VALUES($1,'bus',$2) RETURNING *",[driver,ids[1]])).rows[0];
  locations.getLiveBuses=async()=>[{busId:'bus',sourceId:driver,routeId:ids[1],sessionId:session.id,timestamp:Date.now()}];
  assert.equal((await(await call('/transport-lines/stats','GET',undefined,false)).json()).lines[0].active_buses,1);
  await pg.query("UPDATE driver_sessions SET status='ended',ended_at=now() WHERE id=$1",[session.id]);
  assert.equal((await(await call('/transport-lines/stats','GET',undefined,false)).json()).lines[0].active_buses,0);
 });
 await t.test('unauthenticated telemetry never creates received diagnostic state',async()=>{
  const log=console.log,warn=console.warn,error=console.error,events=[];console.log=console.warn=console.error=x=>{try{events.push(JSON.parse(x))}catch{}};
  try{for(let i=0;i<2;i++)assert.equal((await call('/locations/update','POST',{sourceType:'driver',sourceId:'fake',busId:'anonymous-bus',routeId:ids[1],routeVariantId:ids[1],routeVariantDirection:'ida',latitude:31,longitude:-116,timestamp:Date.now()},false)).status,401);}finally{console.log=log;console.warn=warn;console.error=error;}
  assert.ok(!events.some(e=>e.event==='location_update_received'));
 });
});

test('diagnostic state expires and evicts old entries at the capacity limit',()=>{
 const {recordLocationUpdateReceived}=require('../dist/tracking/locationDiagnostics');
 const log=console.log,warn=console.warn,now=Date.now;console.log=console.warn=()=>{};
 const req={body:{},headers:{'x-forwarded-for':'fake'},ip:'127.0.0.1',socket:{}};
 const payload={busId:'first',routeId:'route',routeVariantId:'variant',sourceType:'driver',sourceId:'driver',timestamp:now(),latitude:31,longitude:-116};
 try{
  recordLocationUpdateReceived(req,payload);
  for(let i=0;i<1000;i++)recordLocationUpdateReceived(req,{...payload,busId:'bounded-'+i});
  assert.equal(recordLocationUpdateReceived(req,payload).previousReceivedAt,undefined);
  Date.now=()=>now()+31*60*1000;
  assert.equal(recordLocationUpdateReceived(req,payload).previousReceivedAt,undefined);
 }finally{console.log=log;console.warn=warn;Date.now=now;}
});


test('favorite migration preserves legacy rows and does not duplicate a saved route',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec("CREATE TABLE schema_migrations(name text,applied_at timestamptz); INSERT INTO schema_migrations VALUES('008_passenger_platform.sql',now()-interval '1 day'); CREATE TABLE favorite_routes(user_id text,route_id uuid,created_at timestamptz DEFAULT now()); CREATE TABLE saved_journeys(user_id text,route_id uuid,client_id text,created_at timestamptz DEFAULT now(),UNIQUE(user_id,client_id)); INSERT INTO favorite_routes(user_id,route_id) VALUES('u','00000000-0000-4000-8000-000000000001'),('u','00000000-0000-4000-8000-000000000002'); INSERT INTO saved_journeys(user_id,route_id,client_id) VALUES('u','00000000-0000-4000-8000-000000000001','modern-client');");
 await pg.exec("INSERT INTO favorite_routes(user_id,route_id,created_at) VALUES('u','00000000-0000-4000-8000-000000000003',now()-interval '2 days')");
 const sql=require('fs').readFileSync(path.join(__dirname,'../src/db/migrations/027_unify_route_favorites.sql'),'utf8');
 await pg.exec(sql);await pg.exec(sql);
 const rows=(await pg.query('SELECT * FROM saved_journeys')).rows;
 assert.equal(rows.length,2);assert.ok(rows.some(r=>r.client_id==='modern-client'));
});
