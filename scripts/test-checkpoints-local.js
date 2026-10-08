// Transactional integration checks. Uses only dev-local's loopback database; all fixtures roll back.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const dev=require('./dev-local');
const env=dev.childEnvironment(dev.options(['--no-mobile']),JSON.parse(fs.readFileSync('.local/secrets.json')));
const url=new URL(env.DATABASE_URL);
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Local database required.');
Object.assign(process.env,env);
const database=require('../dist/db');
const {beginCheckpointRun,registerGpsCheckin,sessionCheckins}=require('../dist/driver-sessions/checkpoints.service');
const db=new Client({connectionString:env.DATABASE_URL});
(async()=>{
  await db.connect();await db.query('BEGIN');
  // Keep service transaction behavior inside an outer transaction that is always rolled back.
  database.getClient=async()=>({release(){},query(sql,args){
    if(sql==='BEGIN')return db.query('SAVEPOINT tracking_test');
    if(sql==='COMMIT')return db.query('RELEASE SAVEPOINT tracking_test');
    if(sql==='ROLLBACK')return db.query('ROLLBACK TO SAVEPOINT tracking_test');
    return db.query(sql,args);
  }});
  try{
    const line=randomUUID(),otherLine=randomUUID(),route=randomUUID(),variant=randomUUID(),back=randomUUID(),driver=randomUUID(),session=randomUUID(),first=randomUUID(),last=randomUUID(),admin=randomUUID();
    const email='checkpoint-'+driver+'@local.test',bus='TEST-'+driver;
    await db.query("INSERT INTO transport_lines(id,name,short_code) VALUES($1,'Checkpoint test','TEST'),($2,'Other test','OTHER')",[line,otherLine]);
    await db.query("INSERT INTO routes(id,name,short_name,transport_line_id) VALUES($1,'Checkpoint test','TEST',$2)",[route,line]);
    await db.query("INSERT INTO route_variants(id,route_id,name,direction,coordinates) VALUES($1,$3,'Ida','ida',$4),($2,$3,'Vuelta','vuelta',$5)",[variant,back,route,JSON.stringify([[-116,31],[-116,31.01]]),JSON.stringify([[-116,31.01],[-116,31]])]);
    await db.query("INSERT INTO stops(id,route_id,variant_id,name,latitude,longitude,sequence) VALUES($1,$3,$4,'Inicio',31,-116,0),($2,$3,$4,'Terminal',31.01,-116,1)",[first,last,route,variant]);
    await db.query("INSERT INTO route_checkpoints(route_id,variant_id,transport_line_id,stop_id,target_minutes) VALUES($1,$2,$3,$4,0),($1,$2,$3,$5,15)",[route,variant,line,first,last]);
    await db.query("INSERT INTO conductores(id,correo,password,nombre_usuario) VALUES($1,$2,'test-only','Test')",[driver,email]);
    const started=new Date(Date.now()-120000);
    await db.query("INSERT INTO driver_sessions(id,conductor_id,bus_id,route_id,variant_id,transport_line_id,started_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[session,driver,bus,route,variant,line,started]);
    await db.query("UPDATE route_checkpoints SET name='Control inicial' WHERE stop_id=$1",[first]);
    await beginCheckpointRun(db,session,route,variant,started);
    assert.equal((await sessionCheckins(db,session))[0].name,'Control inicial');
    await db.query("UPDATE route_checkpoints SET name='Nombre nuevo' WHERE stop_id=$1",[first]);
    assert.equal((await sessionCheckins(db,session))[0].name,'Control inicial','active run keeps its original name');

    const backStop=randomUUID();
    await db.query("INSERT INTO stops(id,route_id,variant_id,name,latitude,longitude,sequence) VALUES($1,$2,$3,'Regreso',31,-116,0)",[backStop,route,back]);
    await db.query("INSERT INTO route_checkpoints(route_id,variant_id,transport_line_id,stop_id,target_minutes) VALUES($1,$2,$3,$4,5)",[route,back,line,backStop]);
    const payload={sourceType:'driver',sourceId:email,busId:bus,routeId:route,routeVariantId:variant,routeVariantDirection:'ida',latitude:31,longitude:-116,accuracy:15,timestamp:Date.now()-10000};
    await registerGpsCheckin(email,{...payload,latitude:31.01});
    assert.equal((await sessionCheckins(db,session)).filter(p=>p.arrived_at).length,0,'later point cannot skip first');
    await registerGpsCheckin(email,{...payload,timestamp:payload.timestamp+1});
    await registerGpsCheckin(email,{...payload,timestamp:payload.timestamp+1});
    let rows=await sessionCheckins(db,session);
    assert.equal(rows.filter(p=>p.arrived_at).length,1,'duplicate GPS remains idempotent');
    assert.equal(new Date(rows[1].expected_at)-started,900000,'expected time anchored to leg start');
    await db.query("UPDATE stops SET name='Edited stop' WHERE id=$1",[first]);
    assert.equal((await sessionCheckins(db,session))[0].name,'Control inicial','history keeps snapshot');
    await registerGpsCheckin(email,{...payload,latitude:31.01,timestamp:payload.timestamp+2000});
    assert.equal((await sessionCheckins(db,session)).filter(p=>p.arrived_at).length,2);
    await registerGpsCheckin(email,{...payload,routeVariantId:back,routeVariantDirection:'vuelta',latitude:31.01,timestamp:payload.timestamp+3000});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM driver_checkpoint_runs WHERE session_id=$1',[session])).rows[0].n,2,'return starts a new clock at terminal');
    const returnPoint=(await sessionCheckins(db,session)).find(p=>p.variant_id===back);
    assert.equal(new Date(returnPoint.expected_at).getTime(),payload.timestamp+3000+300000,'return deadline resets relative to new leg');
    await registerGpsCheckin(email,{...payload,routeVariantId:variant,latitude:31.005,timestamp:payload.timestamp+4000});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM driver_checkpoint_runs WHERE session_id=$1',[session])).rows[0].n,2,'direction toggle away from terminal cannot reset clock');
    await registerGpsCheckin(email,{...payload,routeVariantId:back,routeVariantDirection:'vuelta',timestamp:payload.timestamp+5000});
    await db.query("UPDATE driver_checkpoint_runs SET started_at=now()-interval '2 minutes' WHERE session_id=$1 AND ended_at IS NULL",[session]);
    const switched=await registerGpsCheckin(email,{...payload,routeVariantId:back,routeVariantDirection:'vuelta',latitude:31.0002,timestamp:payload.timestamp+6000,speed:3,heading:0});
    assert.equal(switched.routeVariantId,variant,'precise terminal departure automatically updates native sender variant');
    await db.query("INSERT INTO admins(id,email,password_hash,display_name) VALUES($1,$2,$3,'Test')",[admin,'checkpoint-admin-'+admin+'@local.test','$2b$12$'+'A'.repeat(53)]);
    await db.query("INSERT INTO admin_line_memberships(admin_id,line_id,role) VALUES($1,$2,'viewer'),($1,$3,'admin')",[admin,line,otherLine]);
    await db.query('SET LOCAL ROLE et_line_runtime');
    await db.query("SELECT set_config('app.line_id',$1,true),set_config('app.admin_id',$2,true),set_config('app.token_version','1',true)",[otherLine,admin]);
    assert.equal((await db.query('SELECT id FROM route_checkpoints WHERE route_id=$1',[route])).rows.length,0,'other line cannot read plan');
    assert.equal((await db.query('SELECT id FROM driver_checkins WHERE session_id=$1',[session])).rows.length,0,'other line cannot read history');
    await db.query("SELECT set_config('app.line_id',$1,true)",[line]);
    assert.equal((await db.query('SELECT id FROM route_checkpoints WHERE route_id=$1',[route])).rows.length,3,'viewer can read own plan');
    assert.equal((await db.query('DELETE FROM route_checkpoints WHERE route_id=$1 RETURNING id',[route])).rows.length,0,'viewer cannot remove plan');
    console.log('PASS: snapshot, schedule, GPS ordering, idempotency, leg restart and tenant/viewer isolation. All test data rolled back.');
  }finally{await db.query('ROLLBACK');await db.end();await database.default.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
