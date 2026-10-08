const {test}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const {PGlite}=require("@electric-sql/pglite");
const {pgcrypto}=require("@electric-sql/pglite/contrib/pgcrypto");
process.env.JWT_SECRET="fleet-test-only";
test("fleet migration, CRUD, sessions, telemetry ownership and admin authorization",async t=>{
  const pg=new PGlite({extensions:{pgcrypto}});
  t.after(()=>pg.close());
  const execute=async(sql,params)=>params ? pg.query(sql,params):((await pg.exec(sql)).at(-1) ?? {rows:[]});
  const client={query:execute,release(){}};
  await require("../scripts/migration-runner").migrate(client,path.join(__dirname,"../src/db/migrations"),()=>{});
  const db=require("../dist/db");db.query=execute;db.getClient=async()=>client;
  const {saveVehicle,archiveVehicle,getVehicle}=require("../dist/fleet/fleet.service");
  const {startSession}=require("../dist/driver-sessions/driverSessions.service");
  const {validateLocationUpdateAuth}=require("../dist/tracking/locationAuth");
  const hash="$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";
  const admin=(await pg.query("INSERT INTO admins(email,password_hash,is_superadmin) VALUES('fleet@test.local',$1,true) RETURNING *",[hash])).rows[0];
  const driver=(await pg.query("INSERT INTO conductores(correo,password,nombre_usuario) VALUES('driver@test.local',$1,'Conductor prueba') RETURNING *",[hash])).rows[0];
  const other=(await pg.query("INSERT INTO conductores(correo,password,nombre_usuario) VALUES('other@test.local',$1,'Otro conductor') RETURNING *",[hash])).rows[0];
  const payload={economic_number:"042",plate:"ABC-123",capacity:35,operational_status:"available",assigned_driver_id:driver.id,tracking_id:"legacy-bus-42"};
  let vehicle=await saveVehicle(null,payload,admin.id);
  assert.equal(vehicle.tracking_id,"legacy-bus-42");
  assert.equal((await getVehicle(vehicle.id)).driver_name,"Conductor prueba");
  await assert.rejects(saveVehicle(null,{...payload,economic_number:"043",tracking_id:"new-id"},admin.id),{statusCode:409});
  await assert.rejects(saveVehicle(null,{...payload,capacity:-1},admin.id),{statusCode:400});
  await assert.rejects(saveVehicle(vehicle.id,{...payload,revision:0},admin.id),{statusCode:409});
  await assert.rejects(saveVehicle(vehicle.id,{...payload,revision:1,tracking_id:"changed"},admin.id),{statusCode:400});
  vehicle=await saveVehicle(vehicle.id,{...payload,economic_number:"042-A",revision:1},admin.id);
  assert.equal(vehicle.tracking_id,"legacy-bus-42");
  const session=await startSession(driver.correo,{bus_id:vehicle.tracking_id});
  assert.equal(session.conductor_id,driver.id);assert.equal(session.driver_id,null);assert.equal(session.vehicle_id,vehicle.id);
  await assert.rejects(startSession(other.correo,{bus_id:vehicle.tracking_id}),{statusCode:403});
  await assert.rejects(archiveVehicle(vehicle.id,vehicle.revision,admin.id),{statusCode:409});
  await assert.rejects(saveVehicle(vehicle.id,{...payload,assigned_driver_id:other.id,revision:vehicle.revision},admin.id),{statusCode:409});
  const location={sourceType:"driver",sourceId:driver.correo,busId:vehicle.tracking_id};
  await validateLocationUpdateAuth({user:{sub:driver.correo,role:"driver"}},location);
  await assert.rejects(validateLocationUpdateAuth({},location),{statusCode:403});
  await assert.rejects(validateLocationUpdateAuth({user:{sub:other.correo,role:"driver"}},{...location,sourceId:other.correo}),{statusCode:403});
  const replacement=await startSession(driver.correo,{bus_id:vehicle.tracking_id});
  assert.notEqual(replacement.id,session.id);
  assert.equal((await pg.query("SELECT status FROM driver_sessions WHERE id=$1",[session.id])).rows[0].status,"ended");
  await pg.query("UPDATE driver_sessions SET status='ended',ended_at=now() WHERE id=$1",[replacement.id]);
  await archiveVehicle(vehicle.id,vehicle.revision,admin.id);
  assert.ok((await getVehicle(vehicle.id)).archived_at);
  await assert.rejects(startSession(driver.correo,{bus_id:vehicle.tracking_id}),{statusCode:403});
  assert.equal((await pg.query("SELECT count(*)::int n FROM driver_sessions WHERE vehicle_id=$1",[vehicle.id])).rows[0].n,2);
  // Existing UUID user drivers and unregistered IDs still work during rollout.
  const oldDriver=(await pg.query("INSERT INTO users(email,role) VALUES('legacy@test.local','driver') RETURNING id")).rows[0];
  const legacy=await startSession(oldDriver.id,{bus_id:"old-client-id"});
  assert.equal(legacy.driver_id,oldDriver.id);assert.equal(legacy.vehicle_id,null);
  await assert.rejects(saveVehicle(null,{economic_number:"legacy",operational_status:"available",tracking_id:"old-client-id"},admin.id),{statusCode:409});
  // Exercise the actual HTTP boundary and response shape without any live database.
  require("../dist/redis/cache").incrementRateLimit=async()=>1;
  const express=require("express"),jwt=require("jsonwebtoken");
  const app=express();app.use(express.json());app.use("/admin/buses",require("../dist/fleet/fleet.routes").fleetRouter);
  app.use(require("../dist/shared/errors").errorHandler);
  const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  try {
    const url="http://127.0.0.1:"+server.address().port+"/admin/buses";
    for (const method of ["GET","POST","PUT","DELETE"]) {
      const target=url+(["PUT","DELETE"].includes(method)?"/"+vehicle.id:"");
      assert.equal((await fetch(target,{method})).status,401);
      const token=jwt.sign({sub:oldDriver.id,role:"driver"},process.env.JWT_SECRET);
      assert.equal((await fetch(target,{method,headers:{Authorization:"Bearer "+token}})).status,403);
    }
    const token=jwt.sign({sub:admin.id,role:"admin",identityType:"admin",tokenVersion:1},process.env.JWT_SECRET);
    const headers={Authorization:"Bearer "+token,"Content-Type":"application/json"};
    assert.equal((await (await fetch(url,{headers})).json()).total,0);
    assert.equal((await (await fetch(url+"?archived=true",{headers})).json()).total,1);
    const create=await fetch(url,{method:"POST",headers,body:JSON.stringify({economic_number:"050",operational_status:"available"})});
    assert.equal(create.status,201);
    const saved=(await create.json()).vehicle;
    assert.equal((await fetch(url+"/"+saved.id,{headers})).status,200);
    assert.equal((await fetch(url+"?limit=999",{headers})).status,400);
    const catalogs=await (await fetch(url+"/options",{headers})).json();
    assert.equal(catalogs.drivers.length,2);assert.equal(catalogs.drivers[0].password,undefined);
  } finally {await new Promise(r=>server.close(r));}
});

test("fleet migration preserves existing user-driver sessions and is additive",async t=>{
  const fs=require("node:fs");
  const pg=new PGlite({extensions:{pgcrypto}});t.after(()=>pg.close());
  const folder=path.join(__dirname,"../src/db/migrations");
  for(const file of fs.readdirSync(folder).filter(f=>f.endsWith(".sql")&&f<"012_fleet.sql").sort()) {
    await pg.exec(fs.readFileSync(path.join(folder,file),"utf8"));
  }
  const driver=(await pg.query("INSERT INTO users(email,role) VALUES('before@test.local','driver') RETURNING id")).rows[0];
  const session=(await pg.query("INSERT INTO driver_sessions(driver_id,bus_id) VALUES($1,'existing-id') RETURNING id",[driver.id])).rows[0];
  await pg.exec(fs.readFileSync(path.join(folder,"012_fleet.sql"),"utf8"));
  const after=(await pg.query("SELECT * FROM driver_sessions WHERE id=$1",[session.id])).rows[0];
  assert.equal(after.driver_id,driver.id);assert.equal(after.bus_id,"existing-id");assert.equal(after.status,"active");
  assert.equal(after.vehicle_id,null);assert.equal(after.conductor_id,null);
  await assert.rejects(pg.query("INSERT INTO driver_sessions(bus_id) VALUES('no-identity')"),{code:"23514"});
});
