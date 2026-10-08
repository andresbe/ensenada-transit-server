const {test}=require('node:test');const assert=require('node:assert/strict');
process.env.JWT_SECRET='boarding-http-test-only';
test('passenger endpoint rejects anonymous/admin identities and cannot mutate live bus tracking',async t=>{
 const express=require('express');
 const auth=require('../dist/auth/auth.middleware');
 const userId='11111111-1111-4111-8111-111111111111';
 auth.optionalAuthMiddleware=(req,res,next)=>{if(req.header('x-test-user')) req.user={sub:userId,role:'user',identityType:req.header('x-test-user')==='admin'?'admin':'user'};next();};
 const db=require('../dist/db');db.query=async()=>({rows:[{status:'active'}]});
 const identity=require('../dist/passengers/identity');identity.canonicalTrackingIds=async()=>({});
 const boarding=require('../dist/boardings/service');let accepted;
 boarding.recordBoarding=async(user,payload)=>{accepted={user,payload};return {id:'receipt',status:'pending'};};
 const locations=require('../dist/modules/locations/locations.service');let mutated=false;
 locations.locationsService.updateLocation=()=>{mutated=true;throw Error('Passenger must never write live position');};
 const limiter=require('../dist/middleware/rateLimiter');limiter.apiRateLimiter=(_q,_s,n)=>n();
 const app=express();app.use(express.json());app.use(require('../dist/tracking/locations.routes').trackingRouter);app.use(require('../dist/shared/errors').errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/locations/update';
 const body={sourceType:'user',sourceId:'victim',busId:'BUS-1',routeId:'route',routeVariantId:'variant',routeVariantDirection:'ida',latitude:31.8,longitude:-116.6,accuracy:10,timestamp:Date.now()};
 async function send(who){return fetch(url,{method:'POST',headers:{'content-type':'application/json',...(who?{'x-test-user':who}:{})},body:JSON.stringify(body)});}
 assert.equal((await send()).status,403);assert.equal((await send('admin')).status,403);
 assert.equal((await send('passenger')).status,201);assert.equal(accepted.user,userId);assert.equal(mutated,false);
});
