const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
test('real local Redis preserves newest concurrent sample and duplicate expiry',{
 skip:process.env.RUN_LOCAL_LIFECYCLE!=='1',timeout:15000,
},async()=>{
 const secrets=JSON.parse(readFileSync('.local/secrets.json','utf8'));
 process.env.REDIS_URL='redis://:'+secrets.redis+'@127.0.0.1:56379';
 process.env.DOTENV_CONFIG_PATH='.local/empty.env';
 const {default:redis,connectRedis}=require('../dist/redis/client');
 const cache=require('../dist/redis/cache');
 const bus='lifecycle-test-'+randomUUID();
 await connectRedis();
 try {
  const stamp=Date.now();
  await Promise.all(Array.from({length:30},(_,i)=>cache.setLiveBusLocation(bus,{busId:bus,timestamp:stamp+(i*17)%30,latitude:31,longitude:-116},60)));
  assert.equal((await cache.getLiveBusLocation(bus)).timestamp,stamp+29);
  const key=cache.busLocationKey(bus);
  await redis.pExpire(key,5000);
  const ttl=await redis.pTTL(key);
  await cache.setLiveBusLocation(bus,{busId:bus,timestamp:stamp+29,latitude:0,longitude:0},60);
  await cache.setLiveBusLocation(bus,{busId:bus,timestamp:stamp,latitude:0,longitude:0},60);
  assert.ok(await redis.pTTL(key)<=ttl,'duplicate or old samples must not renew expiry');
  assert.equal((await cache.getLiveBusLocation(bus)).latitude,31);
  assert.ok(await redis.sIsMember(cache.liveBusesIndexKey(),bus));
  await cache.setBusLocation(bus,{sessionId:'old'},60);
  await cache.removeEndedSessionLocation(bus,'old');
  assert.equal(await cache.getLiveBusLocation(bus),null);
  await cache.setBusLocation(bus,{sessionId:'new'},60);
  await cache.removeEndedSessionLocation(bus,'old');
  assert.equal((await cache.getLiveBusLocation(bus)).sessionId,'new','delayed close cannot remove the new service');
  // Model an expired snapshot followed by a new write before index cleanup.
  await redis.del(key);
  await redis.sAdd(cache.liveBusesIndexKey(),bus);
  await cache.setLiveBusLocation(bus,{busId:bus,timestamp:Date.now(),sessionId:'new'},60);
  assert.equal(await cache.removeMissingLiveBusIndexEntries([bus]),0);
  assert.ok(await redis.sIsMember(cache.liveBusesIndexKey(),bus));
  await redis.del(key);
  assert.equal(await cache.removeMissingLiveBusIndexEntries([bus]),1);
  assert.equal(await redis.sIsMember(cache.liveBusesIndexKey(),bus),false);
  const counter='audit-'+bus;
  const counts=await Promise.all(Array.from({length:30},()=>cache.incrementRateLimit('test',counter,60)));
  assert.equal(Math.max(...counts),30);
  assert.ok(await redis.ttl(cache.rateLimitKey('test',counter))>0);
  await redis.del(cache.rateLimitKey('test',counter));
 } finally {
  await cache.removeLiveBusLocation(bus);
  await redis.quit();
 }
});
