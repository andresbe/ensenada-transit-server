const {test}=require('node:test');
const assert=require('node:assert/strict');
const {checkpointPlan,qualifiesForCheckin,checkpointStatus}=require('../dist/driver-sessions/checkpointRules');
const stop='12345678-1234-1234-1234-123456789012';
test('checkpoint plans are bounded, typed and cannot duplicate a stop',()=>{
  const point={stop_id:stop,target_minutes:15,tolerance_minutes:2,radius_meters:75};
  assert.equal(checkpointPlan({revision:0,checkpoints:[point]}).checkpoints[0].target_minutes,15);
  for(const change of [{target_minutes:-1},{target_minutes:1.5},{radius_meters:5000},{radius_meters:NaN},{tolerance_minutes:31},{stop_id:'not-an-id'},{name:123},{name:'x'.repeat(101)}])assert.throws(()=>checkpointPlan({revision:0,checkpoints:[{...point,...change}]}));
  assert.throws(()=>checkpointPlan({revision:0,checkpoints:[point,point]}));
  assert.throws(()=>checkpointPlan({revision:0,checkpoints:Array(101).fill(point)}));
});
test('automatic check-in requires recent precise GPS inside the radius and current leg',()=>{
  const now=Date.now(),target={latitude:31,longitude:-116,radius_meters:75};
  const gps={...target,accuracy:15,timestamp:now};
  assert.equal(qualifiesForCheckin(gps,target,now-1000,now),true);
  for(const patch of [{accuracy:undefined},{accuracy:60},{accuracy:-1},{timestamp:now-121000},{timestamp:now+11000},{latitude:31.01}])assert.equal(qualifiesForCheckin({...gps,...patch},target,now-100000,now),false);
  assert.equal(qualifiesForCheckin(gps,target,now+1,now),false);
});
test('tolerance separates pending, overdue, early, on-time and late without inventing arrival',()=>{
  const expected=new Date('2026-10-06T12:15:00Z');
  assert.equal(checkpointStatus(expected,null,2,false,expected.getTime()+120000),'pending');
  assert.equal(checkpointStatus(expected,null,2,false,expected.getTime()+121000),'overdue');
  assert.equal(checkpointStatus(expected,null,2,true),'not_recorded');
  assert.equal(checkpointStatus(expected,new Date(expected.getTime()-121000),2,false),'early');
  assert.equal(checkpointStatus(expected,new Date(expected.getTime()+120000),2,false),'on_time');
  assert.equal(checkpointStatus(expected,new Date(expected.getTime()+121000),2,false),'late');
});
