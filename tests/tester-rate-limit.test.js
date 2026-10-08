const {test}=require('node:test');const assert=require('node:assert/strict');process.env.JWT_SECRET='tester-rate-tests-only';
test('API quotas consult current server tester flag, never client claims; authentication quotas remain enforced',async()=>{
 const auth=require('../dist/auth/auth.service');const tester=require('../dist/users/tester');const cache=require('../dist/redis/cache');
 let enabled=true,queries=0;auth.validateToken=token=>{if(token!=='valid') throw Error('bad token');return{sub:'11111111-1111-4111-8111-111111111111',role:'user'};};tester.isTesterAccount=async()=>{queries++;return enabled;};cache.incrementRateLimit=async()=>1000;
 const {apiRateLimiter,authRateLimiter}=require('../dist/middleware/rateLimiter');
 async function call(middleware,token){let status,next=false;const req={headers:{...(token?{authorization:'Bearer '+token}:{})},body:{is_tester:true},socket:{remoteAddress:'127.0.0.1'}};const res={status(n){status=n;return this;},json(){}};await middleware(req,res,()=>{next=true;});return{status,next};}
 assert.equal((await call(apiRateLimiter,'valid')).next,true);
 enabled=false;assert.equal((await call(apiRateLimiter,'valid')).status,429);assert.equal(queries,2);
 enabled=true;assert.equal((await call(apiRateLimiter,'forged')).status,429);assert.equal((await call(apiRateLimiter)).status,429);
 assert.equal((await call(authRateLimiter,'valid')).status,429);
});
