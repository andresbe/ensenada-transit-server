const {test}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const fs=require("node:fs");
const {PGlite}=require("@electric-sql/pglite");
const {pgcrypto}=require("@electric-sql/pglite/contrib/pgcrypto");
const {migrate}=require("../scripts/migration-runner");
const dir=path.join(__dirname,"../src/db/migrations");
const IMEI=["356307042441013","356307042441021"];
test("gps schema: dedup, reassignment history, test vehicles, idempotent migrations",async t=>{
  const pg=new PGlite({extensions:{pgcrypto}});
  t.after(()=>pg.close());
  const client={query:async(s,p)=>p?pg.query(s,p):((await pg.exec(s)).at(-1)??{rows:[]})};
  const logs=[];
  await migrate(client,dir,m=>logs.push(m));
  assert.ok(logs.some(l=>l.includes("Applying 029_")) && logs.some(l=>l.includes("Applying 030_")));
  // Second run applies nothing and leaves the journal untouched.
  const before=(await pg.query("SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name")).rows;
  const logs2=[];await migrate(client,dir,m=>logs2.push(m));
  assert.equal(logs2.filter(l=>l.includes("Applying")).length,0);
  assert.deepEqual((await pg.query("SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name")).rows,before);
  const q=(s,p)=>pg.query(s,p).then(r=>r.rows);
  const [d1,d2]=await Promise.all(IMEI.map(i=>q("INSERT INTO tracking_devices(imei,model) VALUES($1,'FTC927') RETURNING id",[i]).then(r=>r[0].id)));
  const [vA,vB]=(await q("INSERT INTO fleet_vehicles(economic_number,is_test_vehicle) VALUES('A',false),('B',true) RETURNING id")).map(r=>r.id);
  await assert.rejects(q("INSERT INTO tracking_devices(imei) VALUES($1)",[IMEI[0]]),/unique/);
  await assert.rejects(q("INSERT INTO tracking_devices(imei) VALUES('abc')"),/check/);
  // Dedup: same timestamp, different event_key kept; exact resend ignored.
  const ins=(key,dev=d1,veh=vA)=>q(`INSERT INTO vehicle_gps_locations(source,device_id,vehicle_id,latitude,longitude,recorded_at,event_key)
    VALUES('TELTONIKA',$1,$2,31.86,-116.6,'2026-01-01T00:00:00Z',$3) ON CONFLICT DO NOTHING RETURNING id`,[dev,veh,key]);
  assert.equal((await ins("")).length,1);
  assert.equal((await ins("")).length,0);
  assert.equal((await ins("evt-239")).length,1);
  assert.equal((await ins("evt-239")).length,0);
  assert.equal((await ins("",d2,vB)).length,1,"other device may share a timestamp");
  // Source rules.
  await assert.rejects(q("INSERT INTO vehicle_gps_locations(source,vehicle_id,latitude,longitude,recorded_at) VALUES('TELTONIKA',$1,1,1,now())",[vA]),/check/);
  await assert.rejects(q("INSERT INTO vehicle_gps_locations(source,device_id,vehicle_id,latitude,longitude,recorded_at) VALUES('ANDROID',$1,$2,1,1,now())",[d1,vA]),/check/);
  await assert.rejects(q("INSERT INTO vehicle_gps_locations(source,vehicle_id,latitude,longitude,recorded_at) VALUES('OTHER',$1,1,1,now())",[vA]),/check/);
  await assert.rejects(q("INSERT INTO vehicle_gps_locations(source,vehicle_id,latitude,longitude,recorded_at) VALUES('ANDROID',$1,91,1,now())",[vA]),/check/);
  await q("INSERT INTO vehicle_gps_locations(source,vehicle_id,latitude,longitude,recorded_at) VALUES('ANDROID',$1,1,1,'2026-01-01Z')",[vA]);
  await assert.rejects(q("INSERT INTO vehicle_gps_locations(source,vehicle_id,latitude,longitude,recorded_at) VALUES('ANDROID',$1,1,1,'2026-01-01Z')",[vA]),/unique/);
  assert.ok((await q("SELECT last_seen_at FROM tracking_devices WHERE id=$1",[d1]))[0].last_seen_at);
  // Reassignment keeps history; one open assignment per device/vehicle.
  const assign=(d,v)=>q("INSERT INTO vehicle_device_assignments(device_id,vehicle_id) VALUES($1,$2)",[d,v]);
  const close=d=>q("UPDATE vehicle_device_assignments SET unassigned_at=now() WHERE device_id=$1 AND unassigned_at IS NULL",[d]);
  await assign(d1,vA);
  await assert.rejects(assign(d1,vB),/unique/);
  await assert.rejects(assign(d2,vA),/unique/);
  await close(d1);await assign(d1,vB);
  await close(d1);await assign(d1,vA);   // back again
  const hist=await q("SELECT vehicle_id,unassigned_at FROM vehicle_device_assignments WHERE device_id=$1 ORDER BY assigned_at,id",[d1]);
  assert.equal(hist.length,3);assert.equal(hist.filter(h=>!h.unassigned_at).length,1);
  await assert.rejects(q("DELETE FROM tracking_devices WHERE id=$1",[d1]),/foreign key/);
  await assert.rejects(q("DELETE FROM fleet_vehicles WHERE id=$1",[vA]),/foreign key/);
  await assert.rejects(q("UPDATE vehicle_device_assignments SET unassigned_at=assigned_at-interval '1 day'"),/check/);
  // Test vehicle: the view hides it, the table does not (endpoints are not wired yet).
  assert.equal((await q("SELECT count(*)::int n FROM vehicle_gps_locations WHERE vehicle_id=$1",[vB]))[0].n,1);
  assert.equal((await q("SELECT count(*)::int n FROM public_vehicle_gps_locations WHERE vehicle_id=$1",[vB]))[0].n,0);
  assert.ok((await q("SELECT count(*)::int n FROM public_vehicle_gps_locations WHERE vehicle_id=$1",[vA]))[0].n>0);
  assert.equal((await q("SELECT is_test_vehicle FROM fleet_vehicles WHERE economic_number='A'"))[0].is_test_vehicle,false);
  // Checksum guard: editing an applied migration is refused.
  const tmp=fs.mkdtempSync(path.join(require("os").tmpdir(),"mig-"));
  for(const f of fs.readdirSync(dir))fs.copyFileSync(path.join(dir,f),path.join(tmp,f));
  fs.appendFileSync(path.join(tmp,"030_vehicle_gps_locations.sql"),"\n-- edited\n");
  await assert.rejects(migrate(client,tmp,()=>{}),/Applied migration changed: 030_/);
});
