const {test}=require('node:test');const assert=require('node:assert/strict');const {trackingHealth,parseTrackingHeartbeat}=require('../dist/driver-sessions/trackingHealth');
const now=Date.now();const row={status:'active',started_at:new Date(now-300000)};
test('connection and GPS freshness are independent',()=>{
 assert.equal(trackingHealth(row,now),'disconnected');
 assert.equal(trackingHealth({...row,last_heartbeat_at:new Date(now)},now),'gps_stale');
 assert.equal(trackingHealth({...row,last_heartbeat_at:new Date(now),last_gps_at:new Date(now)},now),'transmitting');
 assert.equal(trackingHealth({...row,status:'ended'},now),'ended');
 assert.equal(trackingHealth({...row,started_at:new Date(now)},now),'starting');
});
test('telemetry rejects unbounded and fabricated samples and strips unknown diagnostics',()=>{
 const good={busId:'bus',gpsTimestamp:now,samples:[{timestamp:now,latitude:31,longitude:-116}],token:'never store'};
 assert.equal(parseTrackingHeartbeat(good,now).diagnostics.token,undefined);
 for(const change of [{busId:''},{busId:'   '},{gpsTimestamp:now+60000},{samples:Array(121).fill(good.samples[0])},{samples:[{...good.samples[0],latitude:NaN}]},{samples:[{...good.samples[0],timestamp:now-86400001}]}])assert.throws(()=>parseTrackingHeartbeat({...good,...change},now));
});
test('receiving old GPS does not keep a bus fresh or replace newer position',async(t)=>{
 const cache=require('../dist/redis/cache');
 const original=cache.getLiveBusLocations;cache.getLiveBusLocations=async()=>[];t.after(()=>{cache.getLiveBusLocations=original;});
 const {locationsService}=require('../dist/modules/locations/locations.service');
 const p={sourceId:'driver',sourceType:'driver',busId:'health-test',routeId:'missing',routeVariantId:'missing',routeVariantDirection:'ida',latitude:31,longitude:-116,timestamp:now-86400000};
 locationsService.updateLocation(p);
 assert.equal((await locationsService.getLiveBuses(true)).find(bus=>bus.busId==='health-test').isStale,true);
 assert.equal((await locationsService.getLiveBuses(false)).some(bus=>bus.busId==='health-test'),false);
 const fresh=locationsService.updateLocation({...p,timestamp:now});
 assert.equal(locationsService.updateLocation(p).timestamp,fresh.timestamp);
});
