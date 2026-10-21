const {test}=require('node:test');const assert=require('node:assert/strict');
const {directionEvidence}=require('../dist/driver-sessions/directionEvidence');
const ida={id:'ida',coordinates:[[-116,31],[-116,31.02]]};
const vuelta={id:'vuelta',coordinates:[[-116,31.02],[-116,31]]};
const now=Date.now();
function gps(latitude, timestamp, patch={}){return {latitude,longitude:-116,timestamp,accuracy:10,speed:10,heading:180,...patch}}
function sequence(next=vuelta,patch={}) {
 let state={runId:'run',lastAt:now-300000,latitude:31.019,longitude:-116,progress:2100};let result;
 for(let i=0;i<3;i++){result=directionEvidence(state,'run',now-600000,ida,next,gps(31.014-i*0.001,now+i*15000,patch));state=result.state}
 return result;
}
test('recovers return direction after terminal outage without check-ins',()=>assert.equal(sequence().switchTo,'vuelta'));
test('one point cannot flip direction and duplicate timestamps cannot count',()=>{
 const state={runId:'run',lastAt:now-10000,latitude:31.019,longitude:-116};
 const first=directionEvidence(state,'run',now-100000,ida,vuelta,gps(31.018,now));
 assert.equal(first.switchTo,undefined);
 assert.equal(directionEvidence(first.state,'run',now-100000,ida,vuelta,gps(31.017,now)).switchTo,undefined);
});
test('ambiguous shared bearing, no return route, poor GPS and stationary fixes preserve direction',()=>{
 assert.equal(sequence({...ida,id:'same-direction'} ,{heading:0}).switchTo,undefined);
 assert.equal(sequence(undefined,{accuracy:100}).switchTo,undefined);
 for(const patch of [{accuracy:undefined},{accuracy:100},{speed:0},{heading:undefined},{heading:0}])assert.equal(sequence(vuelta,patch).switchTo,undefined);
 assert.equal(directionEvidence({},'r',now-600000,ida,undefined,gps(31.015,now)).switchTo,undefined);
});
test('partial start honors selected direction and a new run resets old evidence',()=>{
 const sample=gps(31.01,now,{heading:0});
 const result=directionEvidence({runId:'previous',candidate:'vuelta',count:10,lastAt:now-1000},'new',now,ida,vuelta,sample);
 assert.equal(result.switchTo,undefined);assert.equal(result.state.runId,'new');assert.equal(result.state.count,undefined);
});
test('impossible GPS jump never confirms a transition',()=>{
 const result=directionEvidence({runId:'r',lastAt:now-1000,latitude:30,longitude:-116,candidate:'vuelta',candidateAt:now-30000,count:2,candidateProgress:1},'r',now-600000,ida,vuelta,gps(31.01,now));
 assert.equal(result.switchTo,undefined);
});
