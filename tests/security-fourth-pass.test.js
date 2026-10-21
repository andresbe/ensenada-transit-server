const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
process.env.JWT_SECRET='fourth-pass-isolated-test';process.env.NODE_ENV='test';

test('registration rollback and boarding session binding',async t=>{
 const pg=new PGlite({extensions:{pgcrypto}});t.after(()=>pg.close());
 const q=async(s,p)=>p?pg.query(s,p):((await pg.exec(s)).at(-1)||{rows:[]});
 await require('../scripts/migration-runner').migrate({query:q},path.resolve('src/db/migrations'),()=>{});
 const db=require('../dist/db');db.query=q;let failPreferences=false;let releases=0;
 db.getClient=async()=>({query:async(s,p)=>{if(failPreferences&&s.includes('INSERT INTO user_preferences'))throw new Error('injected preferences failure');return q(s,p);},release(){releases++;}});
 let emails=0;require('../dist/email/email.service').sendWelcomeEmail=async()=>{emails++;return false;};
 const auth=require('../dist/auth/auth.service');
 await t.test('failed registration rolls back, releases connection and can be retried',async()=>{
  const input={email:'atomic@test.local',password:'ReviewPassword123',display_name:'Review'};
  failPreferences=true;await assert.rejects(auth.register(input),/injected preferences failure/);
  assert.equal((await q('SELECT * FROM users WHERE email=$1',[input.email])).rows.length,0);
  assert.equal(emails,0);assert.equal(releases,1);
  failPreferences=false;const result=await auth.register(input);
  assert.equal(auth.validateToken(result.token).sub,result.user.id);
  assert.equal((await q('SELECT * FROM user_preferences WHERE user_id=$1',[result.user.id])).rows.length,1);
  assert.equal(result.user.token_version,undefined);assert.equal(emails,1);assert.equal(releases,2);
  await assert.rejects(auth.register(input),{statusCode:409});
 });
 await t.test('missing or different GPS session is rejected; matching session succeeds',async()=>{
  const u=(await q("INSERT INTO users(email) VALUES('boarding@test.local') RETURNING id")).rows[0];
  const r=(await q("INSERT INTO routes(name,short_name) VALUES('Review','R') RETURNING id")).rows[0];
  const c=(await q("INSERT INTO conductores(correo,password,nombre_usuario) VALUES('driver@test.local','unused','Review') RETURNING id")).rows[0];
  const v=(await q("INSERT INTO fleet_vehicles(tracking_id,economic_number,assigned_driver_id) VALUES('review-bus','1',$1) RETURNING id",[c.id])).rows[0];
  const s=(await q("INSERT INTO driver_sessions(conductor_id,vehicle_id,bus_id,route_id) VALUES($1,$2,'review-bus',$3) RETURNING id",[c.id,v.id,r.id])).rows[0];
  const point={busId:'review-bus',routeId:r.id,routeVariantId:'variant',routeVariantDirection:'ida',latitude:31.85,longitude:-116.6,accuracy:5,timestamp:Date.now()};
  const sample={...point,updatedAt:Date.now(),sourceType:'driver',sourceId:'driver@test.local'};
  const redis=require('../dist/redis/client').default;Object.defineProperty(redis,'isReady',{value:true});redis.get=async()=>JSON.stringify(sample);
  const {recordBoarding}=require('../dist/boardings/service');
  await assert.rejects(recordBoarding(u.id,point),{statusCode:409});
  sample.sessionId='00000000-0000-4000-8000-000000000001';
  await assert.rejects(recordBoarding(u.id,point),{statusCode:409});
  assert.equal((await q('SELECT * FROM passenger_boardings')).rows.length,0);
  sample.sessionId=s.id;const receipt=await recordBoarding(u.id,point);
  assert.equal(receipt.status,'pending');
  assert.equal((await q('SELECT driver_session_id FROM passenger_boardings WHERE id=$1',[receipt.id])).rows[0].driver_session_id,s.id);
 });
});
