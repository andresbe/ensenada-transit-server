const test=require("node:test"),assert=require("node:assert/strict");
const {options,geometry,pointAt,stopProgress,advance}=require("../scripts/simulate-buses");
const {localSimulationAllowed}=require("../dist/tracking/localSimulation");
const token="a".repeat(64);
const env={NODE_ENV:"development",LOCAL_SIMULATION_ENABLED:"true",DATABASE_URL:"postgresql://u:p@127.0.0.1:55432/transit_local",REDIS_URL:"redis://127.0.0.1:56379",LOCATION_DEBUG_TOKEN:token};

test("simulation authentication fails closed outside isolated local environment",()=>{
 assert.equal(localSimulationAllowed(env,"127.0.0.1",token),true);
 for(const change of [{NODE_ENV:"production"},{LOCAL_SIMULATION_ENABLED:"false"},{DATABASE_URL:"postgresql://host/production"},{DATABASE_URL:"postgresql://u:p@127.0.0.1:55432/other"},{REDIS_URL:"redis://remote:56379"},{LOCATION_DEBUG_TOKEN:""}])assert.equal(localSimulationAllowed({...env,...change},"127.0.0.1",token),false);
 assert.equal(localSimulationAllowed(env,"192.168.1.2",token),false);
 assert.equal(localSimulationAllowed(env,"127.0.0.1","wrong"),false);
 assert.equal(localSimulationAllowed(env,"127.0.0.1",undefined),false);
});
test("CLI rejects remote targets and excessive traffic",()=>{
 assert.throws(()=>options(["--url","https://production"]));
 assert.throws(()=>options(["--count","10","--interval","3"]));
 assert.throws(()=>options(["--speed","NaN"]));
 assert.throws(()=>options(["--count","1.5"]));
 assert.equal(options([]).count,3);
});
test("positions interpolate by distance and never reverse or jump past the endpoint",()=>{
 const g=geometry([[-116,31],[-116,31.01],[-116,31.03]]);
 const middle=pointAt(g,g.length/2);
 assert.ok(Math.abs(middle.latitude-31.015)<0.00001);
 assert.equal(pointAt(g,g.length+500).latitude,31.03);
 assert.equal(pointAt(g,-10).latitude,31);
 assert.ok(Math.abs(stopProgress(g,{longitude:-116,latitude:31.015})-g.length/2)<1);
 assert.throws(()=>geometry([[0,0],[0,0]]));
});
test("bus pauses at stops and resumes; manual pause preserves position",()=>{
 const bus={progress:90,wait:0,speed:10};
 const arrived=advance(bus,5,10,1000,[100,400],12,false);
 assert.deepEqual(arrived,{progress:100,wait:12,speed:0});
 const waiting=advance(arrived,5,10,1000,[100,400],12,false);
 assert.equal(waiting.progress,100);assert.equal(waiting.wait,7);
 const moving=advance({...waiting,wait:0},5,10,1000,[100,400],12,false);
 assert.equal(moving.progress,150);
 assert.equal(advance(moving,5,10,1000,[],12,true).progress,150);
 assert.equal(advance({progress:999,wait:0},5,10,1000,[],12,false).speed,0);
});

const {seededRandom,networkSample}=require('../scripts/simulate-buses');
test('default creates three per direction and profiles validate total traffic',()=>{
 const defaults=options([]);assert.equal(defaults.both,true);assert.equal(defaults.count,3);
 assert.equal(options(['--variant','single']).both,false);
 assert.equal(options(['--profile','high-latency']).latency,8);
 assert.equal(options(['--profile','jumps']).interval,60);
 assert.throws(()=>options(['--both','--variant','single']));
 assert.throws(()=>options(['--drop-rate','1.2']));
 assert.throws(()=>options(['--profile','unknown']));
 assert.throws(()=>options(['--count','6','--interval','6']));
});
test('delayed samples retain captured GPS and timestamp, with per-vehicle ordering',()=>{
 const config={latency:10,jitter:5,'drop-rate':0};
 const payload={latitude:31,timestamp:1000};
 const first=networkSample(payload,1000,config,()=>0.9);
 assert.equal(first.due,15000);assert.equal(first.payload.timestamp,1000);
 const second=networkSample({timestamp:2000},2000,config,()=>0.1,first.due);
 assert.equal(second.due,15001);
 assert.equal(networkSample(payload,1000,{...config,'drop-rate':1},()=>0.5),undefined);
});
test('network impairment is reproducible and movement continues between sparse captures',()=>{
 const config=options(['--profile','high-latency']);
 const sequence=()=>{const rng=seededRandom(42);return Array.from({length:20},(_,i)=>networkSample({timestamp:i*15000},i*15000,config,rng));};
 assert.deepEqual(sequence(),sequence());assert.ok(sequence().some(item=>item===undefined));
 let bus={progress:0,wait:0};for(let i=0;i<600;i++)bus=advance(bus,0.1,60/3.6,5000,[],0,false);
 assert.ok(Math.abs(bus.progress-1000)<0.001);
});

const {returnRunsSameWay}=require('../scripts/simulate-buses');
test('flags return routes drawn in outbound order without reversing distinct paths',()=>{
 const outbound=[[-116.6,31.8],[-116.5,31.9]];
 const ownReturn=[[-116.6001,31.8001],[-116.55,31.84],[-116.5001,31.9001]];
 assert.equal(returnRunsSameWay(outbound,ownReturn),true);
 assert.equal(returnRunsSameWay(outbound,[...ownReturn].reverse()),false);
 assert.equal(returnRunsSameWay([outbound[0],outbound[1],outbound[0]],ownReturn),false);
 assert.equal(returnRunsSameWay(undefined,ownReturn),false);
});
