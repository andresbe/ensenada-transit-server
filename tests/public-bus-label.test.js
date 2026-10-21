const {test}=require('node:test');
const assert=require('node:assert/strict');
test('public fleet requires matching active session, hides ended and superseded samples and private identifiers',async t=>{
 const db=require('../dist/db'),original=db.query;t.after(()=>{db.query=original;});
 const active={id:'active',bus_id:'internal-id',route_id:'public-route',source_id:'private-driver',economic_number:'001',started_at:new Date(1000)};
 let activeRows=[active];
 db.query=async sql=>({rows:sql.includes('FROM driver_sessions')?activeRows:[{id:'public-route'}]});
 const {publicBuses}=require('../dist/tracking/publicBuses');
 const sample={busId:'internal-id',routeId:'public-route',sourceId:'private-driver',sessionId:'active',timestamp:2000};
 const buses=await publicBuses([sample,{...sample,sessionId:'ended'},{...sample,sessionId:undefined},{...sample,sourceId:'other'}, {...sample,timestamp:500},{...sample,routeId:'private-route'}]);
 assert.equal(buses.length,1);assert.equal(buses[0].economicNumber,'001');assert.equal(buses[0].busId,'internal-id');
 assert.equal(buses[0].sourceId,undefined);assert.equal(buses[0].sessionId,undefined);
 activeRows=[];assert.equal((await publicBuses([sample])).length,0,'end hides cached location immediately');
 activeRows=[{...active,id:'next',started_at:new Date(3000)}];
 assert.equal((await publicBuses([sample])).length,0,'a new active service cannot legitimize a previous location');
 assert.equal((await publicBuses([{...sample,sessionId:'next',timestamp:4000}])).length,1);
});
