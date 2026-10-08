const {test}=require('node:test');
const assert=require('node:assert/strict');
const {planDirectRoutes,parsePlanInput,recommendRoutes}=require('../dist/passengers/journeyPlanner');
const now=Date.now();
const a={id:'a',name:'Start',latitude:31.86,longitude:-116.61,sequence:1};
const b={id:'b',name:'End',latitude:31.88,longitude:-116.61,sequence:2};
const variant={id:'outbound',route_id:'route',name:'Ida',direction:'ida',route_name:'Route',short_name:'R',color:'#FFCC00',coordinates:[[-116.61,31.86],[-116.61,31.88]],stops:[a,b]};
const input={origin:a,destination:b,maxWalkingMeters:800};
test('walking minutes are server estimates and never bus arrival times',()=>{
 const {walkingMinutes}=require('../dist/passengers/journeyPlanner');
 assert.equal(walkingMinutes(34),1);
 assert.equal(walkingMinutes(144),2);
 assert.equal(walkingMinutes(0),0);
 const [coverage]=recommendRoutes({...input,destination:{...b,longitude:-116.6096}},[{...variant,stops:[]}],[],now);
 assert.equal(coverage.destinationWalkMinutes,Math.ceil(coverage.destinationRouteDistanceMeters/72));
 assert.equal(coverage.originWalkMinutes,null);
 assert.equal(coverage.arrival,null);
 assert.equal(coverage.walkingTimeBasis,'straight_line_estimate');
 const [direct]=recommendRoutes(input,[variant],[],now);
 assert.equal(direct.originWalkMinutes,0);
 assert.equal(direct.destinationWalkMinutes,0);
});
test('direct routes use registered ordered stops even with no live buses',()=>{
 const [plan]=planDirectRoutes(input,[variant],[],now);
 assert.equal(plan.boardingStop.id,'a');assert.equal(plan.exitStop.id,'b');
 assert.equal(plan.arrival,null);assert.equal(plan.activeBuses,0);assert.equal(plan.walkingDistanceType,'straight_line');
 assert.equal(planDirectRoutes(input,[{...variant,stops:[]}],[],now).length,0);
});
test('reverse journey requires the return variant and correct stop order',()=>{
 const reverse={origin:b,destination:a,maxWalkingMeters:800};
 assert.equal(planDirectRoutes(reverse,[variant],[],now).length,0);
 const back={...variant,id:'return',direction:'vuelta',coordinates:[...variant.coordinates].reverse(),stops:[{...b,sequence:1},{...a,sequence:2}]};
 assert.equal(planDirectRoutes(reverse,[variant,back],[],now)[0].variantId,'return');
});
test('walking limit only expands explicitly and off-route stops are rejected',()=>{
 const far={...input,origin:{latitude:31.86,longitude:-116.599}};
 assert.equal(planDirectRoutes(far,[variant],[],now).length,0);
 assert.equal(planDirectRoutes({...far,maxWalkingMeters:1500},[variant],[],now).length,1);
 assert.equal(planDirectRoutes(input,[{...variant,stops:[{...a,longitude:-116.607},b]}],[],now).length,0);
});
test('arrival excludes stale, opposite, passed, and uncertain buses',()=>{
 const bus={busId:'bus',routeId:'route',routeVariantId:'outbound',latitude:31.86,longitude:-116.61,timestamp:now,isStale:false,avgSpeedMps:5,directionConfidence:'high'};
 assert.ok(planDirectRoutes(input,[variant],[bus],now)[0].arrival);
 for(const override of [{isStale:true},{timestamp:now-61000},{routeVariantId:'return'},{latitude:31.87},{directionConfidence:'low'},{avgSpeedMps:undefined},{isStopped:true}]){
  assert.equal(planDirectRoutes(input,[variant],[{...bus,...override}],now)[0].arrival,null);
 }
});
test('request rejects invalid coordinates and arbitrary walking limits',()=>{
 for(const body of [{},{origin:null,destination:b},{origin:{latitude:91,longitude:0},destination:b},{origin:a,destination:b,maxWalkingMeters:6000},{origin:{latitude:'31',longitude:0},destination:b}])assert.throws(()=>parsePlanInput(body),{statusCode:400});
 assert.equal(parsePlanInput({origin:a,destination:b}).maxWalkingMeters,800);
});
test('closed routes excluded, unknown hours stay explicit and ranking is stable',()=>{
 const date=Date.parse('2026-10-06T19:00:00Z');
 assert.equal(planDirectRoutes(input,[{...variant,operating_hours:{start:'20:00',end:'23:00'}}],[],date).length,0);
 assert.equal(planDirectRoutes(input,[variant],[],date)[0].scheduleKnown,false);
 const plans=planDirectRoutes(input,[{...variant,id:'z'},variant],[],date);
 assert.equal(plans.length,1);assert.equal(plans[0].id,'outbound');
});

test('public endpoint validates before querying and restricts catalog visibility',async t=>{
 const express=require('express'),db=require('../dist/db');
 const {locationsService}=require('../dist/modules/locations/locations.service');
 const cache=require('../dist/redis/cache');
 const oldQuery=db.query,oldLive=locationsService.getLiveBuses,oldRate=cache.incrementRateLimit;
 cache.incrementRateLimit=async()=>1;
 let calls=0;
 db.query=async(sql,args)=>{calls++;assert.match(sql,/r\.active AND r\.visible_in_app/);assert.match(sql,/l\.active/);assert.match(sql,/s\.variant_id=v\.id AND s\.route_id=r\.id/);assert.deepEqual(args,[]);assert.doesNotMatch(sql,/s.latitude BETWEEN/);return {rows:[variant]};};
 locationsService.getLiveBuses=async()=>{throw Error('unavailable');};
 const app=express();app.use(express.json());app.use(require('../dist/passengers/journeyPlanner.routes').journeyPlannerRouter);
 app.use((err,req,res,next)=>res.status(err.statusCode??500).json({message:err.message}));
 const server=await new Promise(resolve=>{const srv=app.listen(0,'127.0.0.1',()=>resolve(srv));});
 t.after(async()=>{db.query=oldQuery;locationsService.getLiveBuses=oldLive;cache.incrementRateLimit=oldRate;await new Promise(resolve=>server.close(resolve));});
 const url=`http://127.0.0.1:${server.address().port}/journeys/plan`;
 let response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:a})});
 assert.equal(response.status,400);assert.equal(calls,0);
 response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
 assert.equal(response.status,200);const raw=await response.json();const data=raw.data??raw;
 assert.equal(data.plans.length,1);assert.equal(data.liveAvailable,false);assert.equal(data.plans[0].arrival,null);
});

test('destination coverage uses segments even without stops and never invents boarding',()=>{
 const destination={latitude:31.87,longitude:-116.609};
 const [plan]=recommendRoutes({...input,destination},[{...variant,stops:[]}],[],now);
 assert.equal(plan.matchType,'near_destination');assert.equal(plan.reason,'stops_unconfirmed');
 assert.ok(plan.destinationRouteDistanceMeters < 100);
 assert.equal(plan.boardingStop,null);assert.equal(plan.exitStop,null);assert.equal(plan.arrival,null);
 assert.equal(plan.originWalkMeters,null);
 assert.ok(Math.abs(plan.closestDestinationPoint.latitude-31.87)<0.001);
});
test('coverage explains inaccessible origin and wrong direction without hiding route',()=>{
 assert.equal(recommendRoutes({...input,origin:{latitude:31,longitude:-116}},[variant],[],now)[0].reason,'origin_far');
 assert.equal(recommendRoutes({origin:b,destination:a,maxWalkingMeters:800},[variant],[],now)[0].reason,'direction_unconfirmed');
 assert.equal(recommendRoutes({...input,destination:{latitude:31,longitude:-116}},[variant],[],now).length,0);
});
test('confirmed connections rank first, coverage sorts by destination distance and deduplicates',()=>{
 const coverage={...variant,route_id:'coverage',id:'coverage',stops:[]};
 const farther={...coverage,id:'farther',route_id:'farther',coordinates:variant.coordinates.map(([lng,lat])=>[lng+0.004,lat])};
 const plans=recommendRoutes(input,[farther,coverage,{...variant,id:'z'},variant],[],now);
 assert.deepEqual(plans.map(p=>p.routeId),['route','coverage','farther']);
 assert.equal(plans[0].matchType,'direct');
 assert.equal(recommendRoutes(input,[{...variant,coordinates:[[NaN,31],[-116,32]]}],[],now).length,0);
});
test('destination radius expands explicitly for coverage',()=>{
 const request={...input,destination:{latitude:31.88,longitude:-116.599}};
 assert.equal(recommendRoutes(request,[variant],[],now).length,0);
 assert.equal(recommendRoutes({...request,maxWalkingMeters:1500},[variant],[],now).length,1);
});
