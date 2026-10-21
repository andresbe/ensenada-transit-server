const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
process.env.NODE_ENV='test';process.env.JWT_SECRET='isolated-security-tests-only-key';process.env.DOTENV_CONFIG_PATH='.local/empty.env';
const cache=require('../dist/redis/cache');
const {rateLimiter}=require('../dist/middleware/rateLimiter');
const {trustedProxies}=require('../dist/config/trustedProxies');
const {validatePassword}=require('../dist/auth/validators');

test('untrusted forwarded headers cannot rotate auth budgets; proxy chains stop at the first untrusted address',async t=>{
 const old=cache.incrementRateLimit,counts=new Map();
 cache.incrementRateLimit=async(p,id)=>{const key=p+':'+id;counts.set(key,(counts.get(key)||0)+1);return counts.get(key);};
 t.after(()=>{cache.incrementRateLimit=old;});
 const app=express();app.set('trust proxy',trustedProxies('203.0.113.1/32'));
 app.get('/',rateLimiter({prefix:'auth',maxRequests:2,windowSeconds:60}),(_,res)=>res.json({ok:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port;
 for(let i=0;i<3;i++)assert.equal((await fetch(url,{headers:{'x-forwarded-for':'198.51.100.'+i}})).status,i<2?200:429);
 counts.clear();app.set('trust proxy',trustedProxies('127.0.0.1/32'));
 for(let i=0;i<3;i++)assert.equal((await fetch(url,{headers:{'x-forwarded-for':'198.51.100.'+i+', 192.0.2.5'}})).status,i<2?200:429);
 assert.equal(counts.get('auth:192.0.2.5'),3);
 for(const invalid of ['true','1','0.0.0.0/0','::/0','example.com'])assert.throws(()=>trustedProxies(invalid));
 assert.equal(trustedProxies(''),false);
});

test('auth fails closed without Redis and also limits an account across addresses',async t=>{
 const old=cache.incrementRateLimit;t.after(()=>{cache.incrementRateLimit=old;});
 const limiter=rateLimiter({prefix:'auth',maxRequests:100,windowSeconds:60});
 const invoke=async ip=>{let status=200,next=false;await limiter({ip,body:{email:' Test@Example.COM '},headers:{},socket:{}},{setHeader(){},status(n){status=n;return this;},json(){}},()=>{next=true;});return {status,next};};
 cache.incrementRateLimit=async()=>0;
 assert.deepEqual(await invoke('one'),{status:503,next:false});
 const counts=new Map();cache.incrementRateLimit=async(p,id)=>{const key=p+':'+id;counts.set(key,(counts.get(key)||0)+1);return counts.get(key);};
 for(let i=0;i<6;i++)assert.equal((await invoke('ip-'+i)).status,i<5?200:429);
 assert.ok([...counts.keys()].filter(k=>k.startsWith('auth-account:')).every(k=>!k.includes('example')));
});

test('password limits count UTF-8 bytes before bcrypt can truncate them',()=>{
 assert.equal(validatePassword('a'.repeat(72)).length,72);
 assert.throws(()=>validatePassword('a'.repeat(73)),e=>e.statusCode===400);
 assert.equal(validatePassword('é'.repeat(36)).length,36);
 assert.throws(()=>validatePassword('é'.repeat(37)),e=>e.statusCode===400);
});

test('driver telemetry requires a session even when optional anonymous mode is configured',async()=>{
 const {validateLocationUpdateAuth}=require('../dist/tracking/locationAuth');
 const {registerGpsCheckin}=require('../dist/driver-sessions/checkpoints.service');
 const payload={sourceType:'driver',busId:'bus',sourceId:'driver@test.local'};
 await assert.rejects(validateLocationUpdateAuth({header:()=>undefined},payload),e=>e.statusCode===401);
 await assert.rejects(validateLocationUpdateAuth({header:()=>undefined,user:{sub:payload.sourceId,role:'driver'}},payload),e=>e.statusCode===400);
 await assert.rejects(registerGpsCheckin(payload.sourceId,payload),e=>e.statusCode===400);
});
