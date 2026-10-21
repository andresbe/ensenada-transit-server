const {test}=require('node:test');const assert=require('node:assert/strict');
test('administrative live map rejects ended and mismatched GPS without hiding draft routes',async t=>{
 const db=require('../dist/db'),locations=require('../dist/modules/locations/locations.service').locationsService;
 const original=db.query,originalLive=locations.getLiveBuses;t.after(()=>{db.query=original;locations.getLiveBuses=originalLive;});
 let rows=[{tracking_id:'bus',economic_number:'001',fleet_color:'#ffcc00',session_id:'active',route_id:'draft',source_id:'driver',started_at:new Date(1000)}];
 db.query=async sql=>{assert.match(sql,/s.status='active'/);assert.match(sql,/v.operational_status='available'/);assert.doesNotMatch(sql,/visible_in_app/);return {rows};};
 const valid={busId:'bus',sourceType:'driver',sourceId:'driver',sessionId:'active',routeId:'draft',timestamp:2000};
 locations.getLiveBuses=async()=>[valid,{...valid,sessionId:'ended'},{...valid,sourceId:'other'},{...valid,timestamp:500},{...valid,routeId:'other'},{...valid,sourceType:'user'}];
 const app=require('express')();app.use(require('../dist/tenancy/adminRead.routes').adminReadRouter);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/buses/live';
 let response=await(await fetch(url)).json();assert.equal(response.buses.length,1);assert.equal(response.buses[0].economicNumber,'001');rows=[];response=await(await fetch(url)).json();assert.equal(response.buses.length,0);
});
