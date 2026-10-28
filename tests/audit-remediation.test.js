const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
process.env.JWT_SECRET = "isolated-audit-regression-key-not-for-deployment";
process.env.NODE_ENV = "test";
// These tests use pre-issued JWTs, not password authentication. Do not load host-native bcrypt
// in the Linux test container; fail loudly if a tested path attempts password operations.
require.cache[require.resolve("bcrypt")] = { exports: {
  hash() { throw new Error("Password operations outside this fixture"); },
  compare() { throw new Error("Password operations outside this fixture"); },
} };

test("welcome template treats supplied names as literal text", () => {
  const { renderEmailTemplate } = require("../dist/email/email.service");
  const name = '[Cuenta](https://example.invalid) ![image](https://example.invalid/img) <img src=x> & {{display_name}}';
  const rendered = renderEmailTemplate("Hola {{display_name}}\n\n**Bienvenido**", { display_name: name });
  assert.equal(rendered.text, "Hola " + name + "\n\n**Bienvenido**");
  assert.match(rendered.html, /<strong>Bienvenido<\/strong>/);
  assert.doesNotMatch(rendered.html, /<a\b|<img\b/);
  assert.match(rendered.html, /&lt;img src=x&gt; &amp; \{\{display_name\}\}/);
});

test("audit remediations enforce tenant targets, device budgets and service checkpoints", { timeout: 120000 }, async t => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const execute = async (sql, params) => {
    const r = params ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1) ?? { rows: [] };
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  await require("../scripts/migration-runner").migrate({ query: execute }, path.join(__dirname, "../src/db/migrations"), () => {});
  const db = require("../dist/db"), pool = db.default;
  const oldQuery = pool.query, oldConnect = pool.connect;
  let tail = Promise.resolve();
  pool.connect = async () => {
    let release; const before = tail; tail = new Promise(r => { release = r; }); await before;
    return { query: execute, release };
  };
  pool.query = execute;
  t.after(async () => { pool.query = oldQuery; pool.connect = oldConnect; await pg.close(); });
  const cache = require("../dist/redis/cache");
  const oldRate = cache.incrementRateLimit;
  cache.incrementRateLimit = async () => 1;
  t.after(() => { cache.incrementRateLimit = oldRate; });
  const row = async (sql, params) => (await pg.query(sql, params)).rows[0];
  const a = await row("INSERT INTO transport_lines(name,short_code) VALUES('A','A') RETURNING id");
  const b = await row("INSERT INTO transport_lines(name,short_code) VALUES('B','B') RETURNING id");
  const fixtureHash = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";
  const admin = await row("INSERT INTO admins(email,password_hash) VALUES('a@example.invalid',$1) RETURNING id",[fixtureHash]);
  await pg.query("INSERT INTO admin_line_memberships(admin_id,line_id,role) VALUES($1,$2,'operator')", [admin.id,a.id]);
  const route = async (line, name) => row("INSERT INTO routes(name,short_name,transport_line_id,visible_in_app) VALUES($1,$1,$2,true) RETURNING id", [name,line]);
  const ra = await route(a.id,"A"), rb = await route(b.id,"B"), legacy = await route(null,"Legacy");
  const variant = async r => row("INSERT INTO route_variants(route_id,name,direction,coordinates) VALUES($1,'Ida','ida','[[-116,31],[-116,31.02]]') RETURNING id", [r.id]);
  const va = await variant(ra), vb = await variant(rb), vl = await variant(legacy);
  const stop = async (r,v) => row("INSERT INTO stops(route_id,variant_id,name,latitude,longitude,sequence) VALUES($1,$2,'Control',31.01,-116,0) RETURNING id", [r.id,v.id]);
  const sa = await stop(ra,va), sb = await stop(rb,vb), sl = await stop(legacy,vl);
  const express = require("express"), jwt = require("jsonwebtoken");
  const app = express(); app.use(express.json());
  const { authMiddleware } = require("../dist/auth/auth.middleware");
  const { requireLine } = require("../dist/tenancy/access");
  const { passengerRouter } = require("../dist/passengers/passengers.routes");
  app.use("/admin/lines/:lineId",authMiddleware,requireLine,passengerRouter);
  app.use(passengerRouter);
  app.use(require("../dist/passengers/notifications.routes").notificationsRouter);
  app.use(require("../dist/shared/errors").errorHandler);
  const server = app.listen(0,"127.0.0.1"); await new Promise(r => server.once("listening",r));
  t.after(() => new Promise(r => server.close(r)));
  const token = jwt.sign({ sub:admin.id,role:"admin",identityType:"admin",tokenVersion:1 },process.env.JWT_SECRET);
  const call = async (url, method="GET", body, auth=token) => {
    const res = await fetch("http://127.0.0.1:"+server.address().port+url,{ method,headers:{"content-type":"application/json",...(auth?{authorization:"Bearer "+auth}:{})},...(body?{body:JSON.stringify(body)}:{}) });
    return { status:res.status,body:await res.json() };
  };
  const notice = { category:"stops",severity:"info",title_es:"Dummy",description_es:"Dummy",published:true,expires_at:new Date(Date.now()+3600000).toISOString() };

  await t.test("cross-line stops are rejected without a route and valid stops infer ownership",async () => {
    const endpoint = "/admin/lines/"+a.id+"/alerts";
    assert.equal((await call(endpoint,"POST",{...notice,stop_id:sb.id})).status,400);
    assert.equal((await call(endpoint,"POST",{...notice,route_id:ra.id,stop_id:sb.id})).status,400);
    const own = await call(endpoint,"POST",{...notice,stop_id:sa.id});
    assert.equal(own.status,201,JSON.stringify(own.body));
    assert.equal(own.body.alert.route_id,ra.id);
    assert.equal(own.body.alert.transport_line_id,a.id);
    assert.equal((await call("/alerts?stopId="+sb.id,"GET",undefined,null)).body.alerts.length,0);
    assert.equal((await call("/alerts?stopId="+sa.id,"GET",undefined,null)).body.alerts.length,1);
    const insert = "INSERT INTO alerts(route_id,stop_id,transport_line_id,category,severity,title_es,description_es,expires_at) VALUES($1,$2,$3,'stops','info','Dummy','Dummy',now()+interval '1 hour')";
    await assert.rejects(pg.query(insert,[null,sb.id,a.id]));
    await assert.rejects(pg.query(insert,[rb.id,sb.id,a.id]));
    await assert.rejects(pg.query(insert,[ra.id,sb.id,a.id]));
    // Existing SET NULL semantics must still work when removing a route and its stops.
    await pg.query("DELETE FROM routes WHERE id=$1",[ra.id]);
    const detached = await row("SELECT route_id,stop_id FROM alerts WHERE id=$1",[own.body.alert.id]);
    assert.equal(detached.route_id,null); assert.equal(detached.stop_id,null);
  });

  const owner = await row("INSERT INTO users(auth_provider) VALUES('guest') RETURNING id");
  const other = await row("INSERT INTO users(auth_provider) VALUES('guest') RETURNING id");
  await t.test("parallel registration keeps five devices, refresh is idempotent and handoff stays usable",async () => {
    const { registerDevice } = require("../dist/passengers/devices.service");
    await Promise.all(Array.from({length:8},(_,i)=>registerDevice(owner.id,`ExpoPushToken[fixture${i}]`,"android")));
    assert.equal((await row("SELECT count(*)::int n FROM passenger_devices WHERE user_id=$1",[owner.id])).n,5);
    const before = await registerDevice(owner.id,"ExpoPushToken[fixture7]","android");
    const after = await registerDevice(owner.id,"ExpoPushToken[fixture7]","ios");
    assert.equal(before.id,after.id);
    await registerDevice(other.id,"ExpoPushToken[fixture7]","android");
    assert.equal((await row("SELECT user_id FROM passenger_devices WHERE id=$1",[before.id])).user_id,other.id);
    const userToken=jwt.sign({sub:owner.id,role:"user",tokenVersion:1},process.env.JWT_SECRET);
    assert.equal((await call("/devices","POST",{token:"ExpoPushToken[http]",platform:"android"},userToken)).status,201);
    assert.equal((await row("SELECT count(*)::int n FROM passenger_devices WHERE user_id=$1",[owner.id])).n,5);
  });

  await t.test("legacy device excess is excluded and the shared batch gives both owners a turn",async () => {
    await pg.exec("DELETE FROM passenger_devices; DELETE FROM alerts;");
    for(const id of [owner.id,other.id]) {
      await pg.query("INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING",[id]);
      await pg.query("INSERT INTO notification_subscriptions(user_id,route_id,created_at) VALUES($1,$2,now()-interval '1 hour')",[id,legacy.id]);
    }
    for(let i=0;i<26;i++) await pg.query("INSERT INTO passenger_devices(user_id,token,platform) VALUES($1,$2,'android')",[owner.id,`ExpoPushToken[old${i}]`]);
    await pg.query("INSERT INTO passenger_devices(user_id,token,platform) VALUES($1,'ExpoPushToken[other]','android')",[other.id]);
    for(let i=0;i<6;i++) await pg.query("INSERT INTO alerts(route_id,category,severity,title_es,description_es,published,expires_at,published_at) VALUES($1,'routes','info','Dummy','Dummy',true,now()+interval '1 hour',now())",[legacy.id]);
    const sent=[];
    await require("../dist/passengers/push.service").deliverPublishedAlerts(async (_url,options)=>{
      sent.push(JSON.parse(options.body).to);
      return {ok:true,json:async()=>({data:{status:"ok",id:"dummy-"+sent.length}})};
    });
    assert.equal((await row("SELECT count(*)::int n FROM notification_deliveries")).n,36);
    assert.equal(sent.length,25);
    assert.ok(sent.includes("ExpoPushToken[other]"),"one owner cannot take the whole batch");
  });

  await t.test("new routed services require a valid variant; old sessions recover checkpoint snapshots",async () => {
    const driver = await row("INSERT INTO conductores(correo,password,nombre_usuario) VALUES('driver@example.invalid',$1,'Driver') RETURNING id,correo",[fixtureHash]);
    await pg.query("INSERT INTO driver_line_memberships(conductor_id,line_id) VALUES($1,$2)",[driver.id,b.id]);
    const vehicle=await row("INSERT INTO fleet_vehicles(tracking_id,economic_number,transport_line_id,assigned_driver_id,assigned_route_id) VALUES('dummy','1',$1,$2,$3) RETURNING id",[b.id,driver.id,rb.id]);
    await pg.query("INSERT INTO route_checkpoints(route_id,variant_id,transport_line_id,stop_id,target_minutes) VALUES($1,$2,$3,$4,15)",[rb.id,vb.id,b.id,sb.id]);
    const {startSession,endSession} = require("../dist/driver-sessions/driverSessions.service");
    await assert.rejects(startSession(driver.correo,{bus_id:"dummy",route_id:rb.id}),{statusCode:400});
    await assert.rejects(startSession(driver.correo,{bus_id:"dummy",route_id:rb.id,variant_id:vl.id}),{statusCode:400});
    assert.equal((await row("SELECT count(*)::int n FROM driver_sessions")).n,0,"invalid start rolls back");
    const session=await startSession(driver.correo,{bus_id:"dummy",route_id:rb.id,variant_id:vb.id});
    assert.equal((await row("SELECT count(*)::int n FROM driver_checkpoint_runs WHERE session_id=$1",[session.id])).n,1);
    assert.equal((await row("SELECT count(*)::int n FROM driver_checkins WHERE session_id=$1",[session.id])).n,1);
    await endSession(driver.correo,session.id);
    // Simulate a pre-fix session with a line-administered checkpoint plan.
    const old=await row("INSERT INTO driver_sessions(conductor_id,vehicle_id,bus_id,route_id,transport_line_id,status,started_at) VALUES($1,$2,'dummy',$3,$4,'active',now()-interval '1 minute') RETURNING *",[driver.id,vehicle.id,rb.id,b.id]);
    const accepted=await require("../dist/driver-sessions/checkpoints.service").registerGpsCheckin(driver.correo,{sourceType:"driver",sourceId:driver.correo,sessionId:old.id,busId:"dummy",routeId:rb.id,routeVariantId:vb.id,routeVariantDirection:"ida",latitude:31.01,longitude:-116,accuracy:5,timestamp:Date.now()});
    assert.equal(accepted.routeVariantId,vb.id);
    const run=await row("SELECT * FROM driver_checkpoint_runs WHERE session_id=$1",[old.id]);
    assert.equal(String(run.started_at),String(old.started_at));
    assert.equal((await row("SELECT variant_id FROM driver_sessions WHERE id=$1",[old.id])).variant_id,vb.id);
    assert.equal((await row("SELECT count(*)::int n FROM driver_checkins WHERE session_id=$1",[old.id])).n,1);
  });
});

test("replica memory expires historical buses even with includeStale and repeated hydration",async t=>{
  const cache=require("../dist/redis/cache"), old=cache.getLiveBusLocations;
  const realNow=Date.now; let now=realNow(); Date.now=()=>now;
  const record={busId:"replica-fixture",sourceId:"dummy",sourceType:"driver",sessionId:"dummy",routeId:"dummy",routeVariantId:"dummy",routeVariantDirection:"ida",latitude:31,longitude:-116,timestamp:now,updatedAt:now};
  let values=[record]; cache.getLiveBusLocations=async()=>values;
  t.after(()=>{cache.getLiveBusLocations=old;Date.now=realNow;});
  const {locationsService}=require("../dist/modules/locations/locations.service");
  assert.ok((await locationsService.getLiveBuses()).some(b=>b.busId===record.busId));
  values=[]; now+=6*60*1000;
  assert.equal((await locationsService.getLiveBuses(true)).some(b=>b.busId===record.busId),false);
  values=[record];
  assert.equal((await locationsService.getLiveBusesByRouteVariant("dummy",true)).length,0,"old Redis copies cannot resurrect an evicted entry");
  values=[{...record,timestamp:now,updatedAt:now}];
  assert.equal((await locationsService.getLiveBusesByRouteVariant("dummy")).length,1,"fresh evidence remains visible");
});
