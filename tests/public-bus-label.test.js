const {test}=require('node:test');
const assert=require('node:assert/strict');
test('public bus names use fleet numbers, preserve tracking IDs and hide private sources',async()=>{
  const db=require('../dist/db');
  db.query=async sql=>({rows:sql.includes('FROM fleet_vehicles')?[{tracking_id:'internal-id',economic_number:'001'}]:[{id:'public-route'}]});
  const {publicBuses}=require('../dist/tracking/publicBuses');
  const buses=await publicBuses([{busId:'internal-id',routeId:'public-route',sourceId:'private-driver'},{busId:'unregistered',routeId:'public-route'},{busId:'hidden',routeId:'private-route'}]);
  assert.equal(buses.length,2);
  assert.equal(buses[0].economicNumber,'001');
  assert.equal(buses[0].busId,'internal-id');
  assert.equal(buses[0].sourceId,undefined);
  assert.equal(buses[1].economicNumber,null);
});
