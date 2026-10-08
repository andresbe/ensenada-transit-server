const fs=require('fs');for(const p of ['src/passengers/catalog.routes.ts','src/passengers/passengers.routes.ts']){let s=fs.readFileSync(p,'utf8').replaceAll('\r\n','\n');s=s.replace(/(?:catalogRouter|passengerRouter)\.use\(apiRateLimiter\);\n/,'').replace(/((?:catalogRouter|passengerRouter)\.(?:get|post|patch|delete)\("[^"]+",)/g,'$1 apiRateLimiter,');fs.writeFileSync(p,s)}
'@ | node
@'
const {test}=require('node:test');const assert=require('node:assert/strict');
process.env.JWT_SECRET='passenger-unit-tests';
const express=require('express'),jwt=require('jsonwebtoken');
const db=require('../dist/db'),cache=require('../dist/redis/cache');
cache.incrementRateLimit=async()=>0;
const {passengerRouter}=require('../dist/passengers/passengers.routes');
const {catalogRouter}=require('../dist/passengers/catalog.routes');
const {usersRouter}=require('../dist/users/users.routes');
const {errorHandler}=require('../dist/shared/errors');
const owner='10000000-0000-4000-8000-000000000001',route='20000000-0000-4000-8000-000000000002',item='30000000-0000-4000-8000-000000000003';
const token=jwt.sign({sub:owner,role:'user'},process.env.JWT_SECRET);

test('passenger HTTP contracts enforce ownership, validation and public visibility',async(t)=>{
 const original=db.query;let calls=[];
 db.query=async(sql,params=[])=>{calls.push({sql,params});
  if(sql.includes('SELECT id FROM route_variants'))return {rows:[]};
  if(sql.includes('FROM users WHERE'))return {rows:[{id:owner}],rowCount:1};
  if(sql.includes('FROM user_preferences'))return {rows:[{user_id:owner,language:'en'}]};
  return {rows:[{id:item}],rowCount:1};
 };
 const app=express();app.use(express.json());app.use(passengerRouter);app.use(catalogRouter);app.use('/users',usersRouter);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{db.query=original;await new Promise(resolve=>server.close(resolve));});
 const request=(path,method='GET',body,auth=true)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 await t.test('private reads reject unauthenticated callers before querying',async()=>{calls=[];assert.equal((await request('/saved-journeys','GET',undefined,false)).status,401);assert.equal(calls.length,0);});
 await t.test('saved journeys list is scoped and paginated',async()=>{calls=[];assert.equal((await request('/saved-journeys?limit=20&offset=5')).status,200);assert.match(calls[0].sql,/WHERE user_id=\$1/);assert.deepEqual(calls[0].params,[owner,20,5]);});
 await t.test('deleting another user favorite always includes owner in SQL',async()=>{calls=[];assert.equal((await request('/saved-journeys/'+item,'DELETE')).status,204);assert.match(calls[0].sql,/user_id=\$2/);assert.deepEqual(calls[0].params,[item,owner]);});
 await t.test('cross-route variant rejects before favorite insert',async()=>{calls=[];assert.equal((await request('/saved-journeys','POST',{route_id:route,variant_id:item,client_id:'retry-1'})).status,400);assert.ok(calls.every(c=>!c.sql.includes('INSERT')));});
 await t.test('support has bounded text and an idempotency key',async()=>{calls=[];assert.equal((await request('/support/tickets','POST',{message:'help',client_id:'request-1'})).status,201);assert.deepEqual(calls[0].params,[owner,'help','request-1']);assert.match(calls[0].sql,/ON CONFLICT/);calls=[];assert.equal((await request('/support/tickets','POST',{message:'',client_id:'request-1'})).status,400);assert.equal(calls.length,0);});
 await t.test('alerts expose only currently published entries and validated filters',async()=>{calls=[];assert.equal((await request('/alerts?language=en&routeId='+route,'GET',undefined,false)).status,200);assert.match(calls[0].sql,/published AND starts_at<=NOW\(\) AND expires_at>NOW\(\)/);assert.deepEqual(calls[0].params.slice(0,2),['en',route]);assert.equal((await request('/alerts?routeId=legacy')).status,400);});
 await t.test('ordinary users cannot publish alerts or create lines',async()=>{calls=[];assert.equal((await request('/alerts','POST',{})).status,403);assert.equal((await request('/transport-lines','POST',{})).status,403);assert.equal(calls.length,0);});
 await t.test('invalid language is rejected before changing profile',async()=>{calls=[];assert.equal((await request('/users/me','PATCH',{display_name:'changed',preferences:{language:'fr'}})).status,400);assert.equal(calls.length,0);});
 await t.test('profile includes saved language preferences',async()=>{const response=await request('/users/me');assert.equal(response.status,200);assert.equal((await response.json()).preferences.language,'en');});
 await t.test('invalid limits and coordinates reject before querying',async()=>{calls=[];assert.equal((await request('/trips?limit=1000')).status,400);assert.equal((await request('/stops?lat=abc&lng=0')).status,400);assert.equal(calls.length,0);});
});
