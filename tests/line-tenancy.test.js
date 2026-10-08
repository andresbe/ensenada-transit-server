const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
process.env.JWT_SECRET='line-isolation-tests-only-not-a-production-secret';
process.env.NODE_ENV='production';
process.env.DATABASE_SSL_MODE='disable';
test('line tenancy: real RLS, HTTP isolation, revocation, drafts, and compatible identities',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}});t.after(()=>pg.close());
  const execute=async(sql,params)=>{const r=params?await pg.query(sql,params):(await pg.exec(sql)).at(-1)??{rows:[]};return {...r,rowCount:r.affectedRows??r.rows.length};};
  await require('../scripts/migration-runner').migrate({query:execute},path.join(__dirname,'../src/db/migrations'),()=>{});
  const db=require('../dist/db'),pool=db.default;
  // Serialize checked-out clients, just as independent PostgreSQL connections do.
  let tail=Promise.resolve();
  pool.connect=async()=>{let release;const before=tail;tail=new Promise(r=>{release=r;});await before;return {query:execute,release};};
  pool.query=execute;
  require('../dist/redis/cache').incrementRateLimit=async()=>1;
  for(const key of ['invalidateRoutesCache','invalidateRouteCache','invalidateVariantCache'])require('../dist/redis/cache')[key]=async()=>{};
  require('../dist/modules/locations/locations.service').locationsService.getLiveBuses=async()=>[];
  const hash='$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';
  const admin=async(email,superadmin=false)=>(await execute('INSERT INTO admins(email,password_hash,is_superadmin) VALUES($1,$2,$3) RETURNING *',[email,hash,superadmin])).rows[0];
  const root=await admin('root@test.local',true),yellowAdmin=await admin('yellow@test.local'),redAdmin=await admin('red@test.local'),viewer=await admin('viewer@test.local');
  const express=require('express'),jwt=require('jsonwebtoken');
  const app=express();app.use(express.json({limit:'10mb'}));app.use('/admin/lines',require('../dist/tenancy/management.routes').lineManagementRouter);
  app.use('/admin/lines/:lineId',require('../dist/tenancy/scoped.routes').scopedLineRouter);
  app.use('/admin/platform',require('../dist/tenancy/platform.routes').platformRouter);
  app.use('/admin/buses',require('../dist/fleet/fleet.routes').fleetRouter);
  app.use('/db-routes',require('../dist/routes/routes.routes').dbRoutesRouter);
  app.use('/driver-sessions',require('../dist/driver-sessions/driverSessions.routes').driverSessionsRouter);
  app.use(require('../dist/shared/errors').errorHandler);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(a,url,method='GET',body)=>{
    const token=jwt.sign({sub:a.id,role:'admin',identityType:'admin',tokenVersion:1},process.env.JWT_SECRET);
    const response=await fetch(base+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json().catch(()=>({}))};
  };
  await t.test('superadmin can open every section before any line exists',async()=>{
    for(const endpoint of ['/summary','/vehicles','/drivers','/db-routes','/catalog','/alerts','/trips','/reports','/audit','/buses/live']) {
      const response=await call(root,'/admin/platform'+endpoint);
      assert.equal(response.status,200,endpoint+JSON.stringify(response.body));
    }
    assert.deepEqual((await call(root,'/admin/lines')).body,{lines:[],is_superadmin:true});
    assert.equal((await call(root,'/admin/platform/summary')).body.drivers.total,0);
  });
  const yellow=(await execute("INSERT INTO transport_lines(name,short_code) VALUES('Amarilla','AMA') RETURNING *")).rows[0];
  const red=(await execute("INSERT INTO transport_lines(name,short_code) VALUES('Roja','ROJ') RETURNING *")).rows[0];
  for(const [a,l,role] of [[yellowAdmin,yellow,'admin'],[redAdmin,red,'operator'],[viewer,yellow,'viewer']])await execute('INSERT INTO admin_line_memberships(admin_id,line_id,role) VALUES($1,$2,$3)',[a.id,l.id,role]);
  const prefix='/admin/lines/'+yellow.id;
  await t.test('creates an account and its line role atomically from the access form',async()=>{
    const endpoint=prefix+'/members';
    const payload={email:' NewAccess@Test.local ',role:'operator',active:true,new_account:{name:'Nueva cuenta',password:'access-test-password'}};
    assert.equal((await call(yellowAdmin,endpoint,'PUT',payload)).status,403);
    assert.equal((await call(viewer,endpoint,'PUT',payload)).status,403);
    assert.equal((await call(root,endpoint,'PUT',{...payload,role:'superadmin'})).status,400);
    const created=await call(root,endpoint,'PUT',payload);
    assert.equal(created.status,200,JSON.stringify(created.body));
    const account=(await execute('SELECT * FROM admins WHERE email=$1',['newaccess@test.local'])).rows[0];
    assert.equal(account.is_superadmin,false);
    assert.equal(account.display_name,'Nueva cuenta');
    assert.equal(await require('bcrypt').compare(payload.new_account.password,account.password_hash),true);
    const membership=(await execute('SELECT * FROM admin_line_memberships WHERE admin_id=$1 AND line_id=$2',[account.id,yellow.id])).rows[0];
    assert.equal(membership.role,'operator');
    assert.equal(membership.active,true);
    assert.equal((await call(root,endpoint,'PUT',payload)).status,409);
    assert.equal((await execute('SELECT password_hash FROM admins WHERE id=$1',[account.id])).rows[0].password_hash,account.password_hash);
    assert.equal((await call(yellowAdmin,endpoint,'PUT',{email:account.email,role:'viewer',active:true})).status,200);
    assert.equal((await execute('SELECT role FROM admin_line_memberships WHERE admin_id=$1 AND line_id=$2',[account.id,yellow.id])).rows[0].role,'viewer');
    await execute("CREATE FUNCTION reject_test_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM admins WHERE id=NEW.admin_id AND email='rollback@test.local') THEN RAISE EXCEPTION 'Test membership rejected' USING ERRCODE='23514'; END IF; RETURN NEW; END $$");
    await execute('CREATE TRIGGER reject_test_access BEFORE INSERT ON admin_line_memberships FOR EACH ROW EXECUTE FUNCTION reject_test_access()');
    try {
      assert.equal((await call(root,endpoint,'PUT',{...payload,email:'rollback@test.local'})).status,400);
      assert.equal((await execute("SELECT id FROM admins WHERE email='rollback@test.local'")).rows.length,0,'failed membership must roll back the new account');
    } finally {
      await execute('DROP TRIGGER reject_test_access ON admin_line_memberships');
      await execute('DROP FUNCTION reject_test_access()');
    }
  });

  assert.equal((await call(yellowAdmin,'/admin/lines')).body.lines.length,1);
  assert.equal((await call(yellowAdmin,'/admin/lines/'+red.id+'/vehicles')).status,403);
  assert.equal((await call(yellowAdmin,'/admin/buses')).status,403);
  assert.equal((await call(yellowAdmin,'/admin/lines','POST',{name:'Bad'})).status,403);
  assert.equal((await call(viewer,prefix+'/vehicles','POST',{economic_number:'001',operational_status:'available'})).status,403);
  const y=await call(yellowAdmin,prefix+'/vehicles','POST',{economic_number:'042',operational_status:'available'});
  assert.equal(y.status,201,JSON.stringify(y.body));assert.equal(y.body.vehicle.transport_line_id,yellow.id);
  const r=await call(redAdmin,'/admin/lines/'+red.id+'/vehicles','POST',{economic_number:'042',operational_status:'available'});
  assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal((await call(yellowAdmin,prefix+'/vehicles/'+r.body.vehicle.id)).status,404);
  assert.equal((await call(yellowAdmin,prefix+'/vehicles/'+r.body.vehicle.id,'DELETE',{revision:1})).status,404);
  assert.equal((await call(yellowAdmin,prefix+'/vehicles')).body.vehicles.length,1);
  assert.equal((await call(yellowAdmin,prefix+'/vehicles','POST',{economic_number:'bad',operational_status:'available',transport_line_id:red.id})).status,403);
  const routePayload={name:'Ruta privada',short_name:'RP',color:'#112233',visible_in_app:false,variants:[{name:'Ida',direction:'ida',geojson:{type:'LineString',coordinates:[[-116.6,31.8],[-116.5,31.9]]},stops:[]}]};
  const imported=await call(yellowAdmin,prefix+'/db-routes/import','POST',routePayload);assert.equal(imported.status,201,JSON.stringify(imported.body));
  const routeId=imported.body.route.id;
  await t.test('checkpoint saves preserve permissions and database-owned audit', async () => {
    const variant=(await execute('SELECT id FROM route_variants WHERE route_id=$1',[routeId])).rows[0];
    const stop=(await execute("INSERT INTO stops(route_id,variant_id,name,latitude,longitude,sequence) VALUES($1,$2,'Control',31.8,-116.6,0) RETURNING id",[routeId,variant.id])).rows[0];
    const endpoint=prefix+'/routes/'+routeId+'/checkpoints';
    const initial=await call(yellowAdmin,endpoint);
    assert.equal(initial.status,200);
    const payload={revision:initial.body.revision,checkpoints:[{stop_id:stop.id,target_minutes:15,tolerance_minutes:2,radius_meters:75}]};
    assert.equal((await call(viewer,endpoint,'PUT',payload)).status,403);
    assert.equal((await call(redAdmin,'/admin/lines/'+red.id+'/routes/'+routeId+'/checkpoints','PUT',payload)).status,404);
    const saved=await call(yellowAdmin,endpoint,'PUT',payload);
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    assert.equal((await call(yellowAdmin,endpoint)).body.checkpoints.length,1);
    const original=(await call(yellowAdmin,endpoint)).body.checkpoints[0];
    const edited=await call(yellowAdmin,endpoint,'PUT',{revision:saved.body.revision,checkpoints:[{...payload.checkpoints[0],name:'  Control Centro  ',target_minutes:20}]});
    assert.equal(edited.status,200,JSON.stringify(edited.body));
    const updated=(await call(yellowAdmin,endpoint)).body.checkpoints[0];
    assert.equal(updated.id,original.id,'editing preserves checkpoint identity');
    assert.equal(updated.name,'Control Centro');
    assert.equal(updated.target_minutes,20);
    saved.body.revision=edited.body.revision;

    assert.equal((await call(yellowAdmin,endpoint,'PUT',payload)).status,409);
    assert.equal((await execute("SELECT count(*)::int AS n FROM line_audit_log WHERE entity_type='route_checkpoints' AND action='INSERT' AND line_id=$1 AND actor_id=$2",[yellow.id,yellowAdmin.id])).rows[0].n,1);
    assert.equal((await execute("SELECT has_table_privilege('et_line_runtime','line_audit_log','INSERT') AS allowed")).rows[0].allowed,false);
    assert.equal((await call(yellowAdmin,endpoint,'PUT',{revision:saved.body.revision,checkpoints:[]})).status,200);
    await execute('DELETE FROM stops WHERE id=$1',[stop.id]);
  });

  await t.test('route alerts can be published only inside an authorized line', async () => {
    const payload = { route_id: routeId, category: 'routes', severity: 'info', title_es: 'Aviso de prueba', description_es: 'Prueba de aviso a pasajeros', published: true, expires_at: new Date(Date.now() + 3600000).toISOString() };
    assert.equal((await call(yellowAdmin,prefix+'/alerts','POST',payload)).status,400);
    await execute('UPDATE routes SET visible_in_app=true WHERE id=$1',[routeId]);
    assert.equal((await call(viewer,prefix+'/alerts','POST',payload)).status,403);
    assert.equal((await call(redAdmin,'/admin/lines/'+red.id+'/alerts','POST',payload)).status,400);
    const created = await call(yellowAdmin,prefix+'/alerts','POST',payload);
    assert.equal(created.status,201,JSON.stringify(created.body));
    assert.equal(created.body.alert.transport_line_id,yellow.id);
    assert.ok(created.body.alert.published_at);
    const listed = await call(yellowAdmin,prefix+'/alerts');
    assert.ok(listed.body.alerts.some(alert => alert.id === created.body.alert.id && alert.route_name === 'Ruta privada'));
    assert.equal((await call(redAdmin,'/admin/lines/'+red.id+'/alerts')).body.alerts.length,0);
    assert.equal((await call(yellowAdmin,prefix+'/alerts/'+created.body.alert.id,'PATCH',{published:false})).status,200);
    await execute('UPDATE routes SET visible_in_app=false WHERE id=$1',[routeId]);
  });
  assert.equal((await call(yellowAdmin,prefix+'/db-routes')).body.routes.length,1);
  assert.equal((await call(redAdmin,'/admin/lines/'+red.id+'/db-routes/'+routeId)).status,404);
  assert.equal((await fetch(base+'/db-routes/'+routeId)).status,404);
  const edit=await call(yellowAdmin,prefix+'/vehicles/'+y.body.vehicle.id,'PUT',{...y.body.vehicle,assigned_route_id:routeId});assert.equal(edit.status,200,JSON.stringify(edit.body));
  const options=await call(yellowAdmin,prefix+'/vehicles/options');assert.equal(options.status,200,JSON.stringify(options.body));assert.equal(options.body.lines.length,1);
  const driverCreated=await call(yellowAdmin,prefix+'/drivers','POST',{name:'Conductor Amarilla',email:'driver-yellow@test.local',password:'test-password-123'});
  assert.equal(driverCreated.status,201,JSON.stringify(driverCreated.body));
  const driver=driverCreated.body.driver;
  assert.equal((await call(yellowAdmin,prefix+'/drivers','POST',{name:'Duplicado',email:driver.correo,password:'test-password-123'})).status,409);
  assert.equal((await call(redAdmin,'/admin/lines/'+red.id+'/drivers')).body.drivers.length,0);
  const driverEdit=await call(yellowAdmin,prefix+'/vehicles/'+y.body.vehicle.id,'PUT',{...edit.body.vehicle,assigned_driver_id:driver.id});
  assert.equal(driverEdit.status,200,JSON.stringify(driverEdit.body));
  const {startSession}=require('../dist/driver-sessions/driverSessions.service');
  const {validateLocationUpdateAuth}=require('../dist/tracking/locationAuth');
  const session=await startSession(driver.correo,{bus_id:y.body.vehicle.tracking_id,route_id:routeId});
  assert.equal(session.transport_line_id,yellow.id);
  await assert.rejects(startSession(driver.correo,{bus_id:'unknown-bus',route_id:routeId}),{statusCode:403});
  await validateLocationUpdateAuth({header:()=>undefined,user:{sub:driver.correo,role:'driver'}},{sourceType:'driver',sourceId:driver.correo,busId:y.body.vehicle.tracking_id,routeId});
  await assert.rejects(validateLocationUpdateAuth({header:()=>undefined,user:{sub:driver.correo,role:'driver'}},{sourceType:'driver',sourceId:driver.correo,busId:r.body.vehicle.tracking_id,routeId}),{statusCode:403});
  const {refreshToken,generateDriverToken}=require('../dist/auth/auth.service');
  assert.equal((await refreshToken(generateDriverToken(driver.correo))).user.id,driver.correo);
  const driverCatalog=await fetch(base+'/driver-sessions/catalog',{headers:{authorization:'Bearer '+generateDriverToken(driver.correo)}});
  assert.equal(driverCatalog.status,200);
  const catalog=await driverCatalog.json();
  assert.deepEqual(catalog.vehicles.map(v=>v.bus_id),[y.body.vehicle.tracking_id]);
  assert.deepEqual(catalog.routes.map(r=>r.id),[routeId]);
  assert.equal(catalog.routes[0].variants.length,1);
  assert.deepEqual(catalog.routes[0].variants[0].coordinates,[[-116.6,31.8],[-116.5,31.9]]);
  await execute('UPDATE driver_line_memberships SET active=false WHERE conductor_id=$1',[driver.id]);
  await assert.rejects(startSession(driver.correo,{bus_id:'unknown-bus'}),{statusCode:403});
  await assert.rejects(validateLocationUpdateAuth({header:()=>undefined,user:{sub:driver.correo,role:'driver'}},{sourceType:'driver',sourceId:driver.correo,busId:'unknown-bus',routeId}),{statusCode:403});
  const revokedCatalog=await fetch(base+'/driver-sessions/catalog',{headers:{authorization:'Bearer '+generateDriverToken(driver.correo)}});
  assert.deepEqual(await revokedCatalog.json(),{vehicles:[],routes:[]});
  await execute('UPDATE driver_line_memberships SET active=true WHERE conductor_id=$1',[driver.id]);
  for(const endpoint of ['/trips','/reports','/summary','/audit','/catalog','/alerts']) {
    const result=await call(yellowAdmin,prefix+endpoint);assert.equal(result.status,200,endpoint+':'+JSON.stringify(result.body));
  }
  const alert=await call(yellowAdmin,prefix+'/alerts','POST',{title_es:'Aviso Amarilla',description_es:'Solo esta línea',category:'service',severity:'info',published:false,expires_at:new Date(Date.now()+3600000).toISOString()});
  assert.equal(alert.status,201,JSON.stringify(alert.body));
  assert.equal((await call(redAdmin,'/admin/lines/'+red.id+'/alerts')).body.alerts.length,0);
  assert.equal((await call(yellowAdmin,prefix+'/alerts')).body.alerts.length,2); // Published-then-disabled fixture plus this new alert.
  // A poisoned former global cache must not reveal drafts or another tenant.
  require('../dist/redis/cache').getCachedRoutes=async()=>[{id:'must-not-leak'}];
  assert.equal((await call(yellowAdmin,prefix+'/db-routes')).body.routes[0].id,routeId);
    // RLS protects even an accidentally unfiltered SQL query and database writes.
  const {lineContext}=require('../dist/tenancy/context');
  await lineContext.run({lineId:yellow.id,adminId:yellowAdmin.id,role:'admin',tokenVersion:1},async()=>{
    assert.equal((await db.query('SELECT * FROM fleet_vehicles')).rows.length,1);
    await assert.rejects(db.query('UPDATE fleet_vehicles SET transport_line_id=$1 WHERE id=$2',[red.id,y.body.vehicle.id]),{code:'42501'});
    await assert.rejects(db.query('SELECT password_hash FROM admins'),{code:'42501'});
    const client=await db.getClient();try{await client.query('BEGIN');assert.equal((await client.query('SELECT * FROM fleet_vehicles')).rows.length,1);await client.query('ROLLBACK');}finally{client.release();}
  });
  assert.equal((await execute('SELECT * FROM fleet_vehicles')).rows.length,2);
  await execute('UPDATE admin_line_memberships SET active=false WHERE admin_id=$1',[yellowAdmin.id]);
  assert.equal((await call(yellowAdmin,prefix+'/vehicles')).status,403);
  await lineContext.run({lineId:yellow.id,adminId:yellowAdmin.id,role:'admin',tokenVersion:1},async()=>assert.equal((await db.query('SELECT * FROM fleet_vehicles')).rows.length,0));
  const newLine=await call(root,'/admin/lines','POST',{name:'Verde',short_code:'VER',color:'#00FF00'});assert.equal(newLine.status,201,JSON.stringify(newLine.body));
  await t.test('lines only require name and color and preserve legacy codes on edit',async()=>{
    const created=await call(root,'/admin/lines','POST',{name:'Morada',color:'#8833AA'});
    assert.equal(created.status,201,JSON.stringify(created.body));
    assert.equal(created.body.line.short_code,'');
    for(const line of [created.body.line,newLine.body.line]) {
      const body={name:line.name+' nueva',color:'#663399',active:true,revision:line.revision};
      const updated=await call(root,'/admin/lines/'+line.id,'PUT',body);
      assert.equal(updated.status,200,JSON.stringify(updated.body));
      assert.equal(updated.body.line.id,line.id);
      assert.equal(updated.body.line.name,body.name);
      assert.equal(updated.body.line.color,body.color);
      assert.equal(updated.body.line.short_code,line.short_code);
      assert.equal((await call(root,'/admin/lines/'+line.id,'PUT',body)).status,409);
    }
    assert.equal((await call(redAdmin,'/admin/lines','POST',{name:'Otra',color:'#663399'})).status,403);
  });
  const deniedMember=await call(redAdmin,'/admin/lines/'+red.id+'/members','PUT',{email:viewer.email,role:'admin',active:true});assert.equal(deniedMember.status,403);
  assert.ok((await execute('SELECT * FROM line_audit_log')).rows.length>0);
  await execute('UPDATE transport_lines SET active=false WHERE id=$1',[red.id]);
  assert.equal((await call(redAdmin,'/admin/lines/'+red.id+'/vehicles')).status,403);

  await t.test('pending assignments exclude deleted routes and archived vehicles, but retain drafts',async()=>{
    const draft=(await execute("INSERT INTO routes(name,short_name,active,visible_in_app) VALUES('Pending draft','PD',true,false) RETURNING id")).rows[0];
    const deleted=(await execute("INSERT INTO routes(name,short_name,active,visible_in_app) VALUES('Deleted route','DR',false,false) RETURNING id")).rows[0];
    const archived=(await execute("INSERT INTO fleet_vehicles(economic_number,archived_at) VALUES('archived-pending',now()) RETURNING id")).rows[0];
    const pending=await call(root,'/admin/platform/unassigned');
    assert.equal(pending.status,200);
    assert.ok(pending.body.routes.some(r=>r.id===draft.id));
    assert.ok(!pending.body.routes.some(r=>r.id===deleted.id));
    assert.ok(!pending.body.vehicles.some(v=>v.id===archived.id));
    for(const [kind,id] of [['routes',deleted.id],['vehicles',archived.id]]) {
      const result=await call(root,'/admin/platform/assign','POST',{kind,id,line_id:yellow.id});
      assert.equal(result.status,409,JSON.stringify(result.body));
    }
    const assigned=await call(root,'/admin/platform/assign','POST',{kind:'routes',id:draft.id,line_id:yellow.id});
    assert.equal(assigned.status,200,JSON.stringify(assigned.body));
  });
  await t.test('driver management, trip filters/detail and vehicle lifecycle stay isolated',async()=>{
    const driverUrl=prefix+'/drivers/'+driver.id;
    let profile=(await call(root,prefix+'/drivers?q=driver-yellow')).body.drivers[0];
    const update=()=>({name:profile.nombre_usuario,active:profile.active,revision:profile.revision});
    assert.equal((await call(root,driverUrl,'PUT',{...update(),active:false})).status,409);
    assert.equal((await call(viewer,driverUrl,'PUT',update())).status,403);
    assert.equal((await call(root,'/admin/lines/'+red.id+'/drivers/'+driver.id,'PUT',update())).status,403);
    const headers={authorization:'Bearer '+generateDriverToken(driver.correo),'content-type':'application/json'};
    const ended=await fetch(base+'/driver-sessions/'+session.id+'/end',{method:'POST',headers});
    assert.equal(ended.status,200);
    let trips=await call(root,prefix+'/trips?driver_id='+driver.id+'&vehicle_id='+y.body.vehicle.id+'&status=ended&limit=1');
    assert.equal(trips.status,200,JSON.stringify(trips.body));assert.equal(trips.body.total,1);
    assert.equal(trips.body.records[0].economic_number,'042');
    assert.equal((await call(root,prefix+'/trips/'+session.id)).body.trip.driver_name,'Conductor Amarilla');
    assert.equal((await call(root,'/admin/lines/'+newLine.body.line.id+'/trips/'+session.id)).status,404);
    assert.equal((await call(root,prefix+'/trips?from=2026-02-30')).status,400);
    assert.equal((await call(root,prefix+'/trips?from=2026-10-02&to=2026-10-01')).status,400);
    assert.equal((await call(root,driverUrl,'PUT',{...update(),active:false})).status,200);
    assert.equal((await call(root,driverUrl,'PUT',update())).status,409);
    assert.equal((await call(root,prefix+'/drivers?status=suspended')).body.total,1);
    assert.equal((await call(root,prefix+'/vehicles/options')).body.drivers.length,0);
    await assert.rejects(startSession(driver.correo,{bus_id:y.body.vehicle.tracking_id,route_id:routeId}),{statusCode:403});
    profile=(await call(root,prefix+'/drivers')).body.drivers[0];
    assert.equal((await call(root,driverUrl,'PUT',{...update(),active:true,password:'replacement-password-456'})).status,200);
    await assert.rejects(refreshToken(generateDriverToken(driver.correo)),{statusCode:401});
    assert.equal((await fetch(base+'/driver-sessions/catalog',{headers})).status,401);
    const stored=(await execute('SELECT password,token_version FROM conductores WHERE id=$1',[driver.id])).rows[0];
    assert.equal(await require('bcrypt').compare('replacement-password-456',stored.password),true);
    assert.equal(require('bcrypt').getRounds(stored.password),12);
    const freshHeaders={authorization:'Bearer '+generateDriverToken(driver.correo,stored.token_version),'content-type':'application/json'};
    const started=await fetch(base+'/driver-sessions/start',{method:'POST',headers:freshHeaders,body:JSON.stringify({bus_id:y.body.vehicle.tracking_id,route_id:routeId})});
    assert.equal(started.status,201);const active=(await started.json()).session;
    assert.equal((await call(root,prefix+'/trips?status=active')).body.records[0].id,active.id);
    assert.equal((await fetch(base+'/driver-sessions/'+active.id+'/end',{method:'POST',headers:freshHeaders})).status,200);
    let vehicle=(await call(root,prefix+'/vehicles/'+y.body.vehicle.id)).body.vehicle;
    assert.equal((await call(root,prefix+'/vehicles/'+vehicle.id,'DELETE',{revision:vehicle.revision})).status,204);
    vehicle=(await call(root,prefix+'/vehicles/'+vehicle.id)).body.vehicle;
    assert.equal((await call(viewer,prefix+'/vehicles/'+vehicle.id+'/restore','POST',{revision:vehicle.revision})).status,403);
    assert.equal((await call(root,prefix+'/vehicles/'+vehicle.id+'/restore','POST',{revision:0})).status,409);
    assert.equal((await call(root,prefix+'/vehicles/'+vehicle.id+'/restore','POST',{revision:vehicle.revision})).status,200);
    vehicle=(await call(root,prefix+'/vehicles/'+vehicle.id)).body.vehicle;
    assert.equal(vehicle.assigned_driver_id,null);assert.equal(vehicle.assigned_route_id,null);assert.equal(vehicle.operational_status,'out_of_service');
    const history=await call(root,prefix+'/vehicles/'+vehicle.id+'/history');
    assert.equal(history.status,200,JSON.stringify(history.body));
    assert.ok(history.body.records.some(row=>row.action==='archive'));
    assert.ok(history.body.records.some(row=>row.action==='restore'));
    assert.ok(history.body.records.some(row=>row.route_name==='Ruta privada'));
    assert.equal((await call(root,'/admin/lines/'+newLine.body.line.id+'/vehicles/'+vehicle.id+'/history')).status,404);
    assert.equal((await call(root,prefix+'/trips?driver_id='+driver.id+'&limit=1&page=2')).body.records.length,1);
    await execute('UPDATE admin_line_memberships SET active=true WHERE admin_id=$1',[yellowAdmin.id]);
    await execute('INSERT INTO driver_line_memberships(conductor_id,line_id) VALUES($1,$2)',[driver.id,newLine.body.line.id]);
    profile=(await call(yellowAdmin,prefix+'/drivers')).body.drivers[0];
    assert.equal((await call(yellowAdmin,driverUrl,'PUT',{...update(),name:'Nombre compartido'})).status,403);
    assert.equal((await call(root,driverUrl,'PUT',{...update(),name:'Nombre actualizado'})).status,200);
    assert.equal((await call(root,prefix+'/drivers?q=Nombre%20actualizado')).body.drivers[0].nombre_usuario,'Nombre actualizado');
    await execute('UPDATE routes SET active=false WHERE id=$1',[routeId]);
    assert.ok((await call(root,prefix+'/trips/options')).body.routes.some(row=>row.id===routeId));
  });

  await t.test('superadmin operates every dashboard section without membership or selected line',async()=>{
    const global='/admin/platform';
    for(const endpoint of ['/summary','/buses/live','/vehicles','/vehicles/options','/drivers','/db-routes','/catalog','/alerts','/trips','/trips/options','/reports','/audit']) {
      const response=await call(root,global+endpoint);
      assert.equal(response.status,200,endpoint+JSON.stringify(response.body));
      assert.equal((await call(yellowAdmin,global+endpoint)).status,403,endpoint);
      assert.equal((await fetch(base+global+endpoint)).status,401,endpoint);
    }
    const globalVehicles=(await call(root,global+'/vehicles')).body.vehicles;
    assert.ok(globalVehicles.some(v=>v.transport_line_id===yellow.id));
    assert.ok(globalVehicles.some(v=>v.transport_line_id===red.id));
    const created=await call(root,global+'/drivers','POST',{name:'Sin línea',email:'platform-driver@test.local',password:'driver-platform-password'});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const list=await call(root,global+'/drivers?q=platform-driver');
    const globalDriver=list.body.drivers[0];
    assert.equal(globalDriver.unassigned,true);
    assert.equal((await call(root,global+'/drivers/'+globalDriver.id,'PUT',{name:'Nombre editado',revision:globalDriver.revision})).status,200);
    assert.equal((await call(root,global+'/drivers/'+globalDriver.id,'PUT',{name:'Obsoleto',revision:globalDriver.revision})).status,409);
    assert.equal((await call(yellowAdmin,global+'/drivers','POST',{name:'Bad'})).status,403);
    const payload={...routePayload,name:'Borrador global',transport_line_id:yellow.id};
    const importedGlobal=await call(root,global+'/db-routes/import','POST',payload);
    assert.equal(importedGlobal.status,201,JSON.stringify(importedGlobal.body));
    const id=importedGlobal.body.route.id;
    assert.equal(importedGlobal.body.route.transport_line_id,yellow.id);
    assert.ok((await call(root,global+'/db-routes')).body.routes.some(r=>r.id===id));
    const detail=await call(root,global+'/db-routes/'+id);
    assert.equal(detail.status,200);
    const variant=detail.body.route.variants[0];
    assert.equal((await call(root,global+'/db-routes/'+id+'/variants/'+variant.id)).status,200);
    assert.equal((await fetch(base+'/db-routes/'+id)).status,404,'draft remains private');
    assert.equal((await call(root,global+'/db-routes/'+id,'PUT',{...payload,version:detail.body.route.version,name:'Editada global'})).status,200);
    assert.equal((await call(root,global+'/routes/'+id+'/checkpoints')).status,200);
    assert.equal((await call(root,global+'/routes/'+id+'/checkpoints','PUT',{revision:1,checkpoints:[]})).status,200);
    const vehicle=await call(root,global+'/vehicles','POST',{economic_number:'GLOBAL-001',transport_line_id:yellow.id,operational_status:'available'});
    assert.equal(vehicle.status,201,JSON.stringify(vehicle.body));
    assert.equal((await call(root,global+'/vehicles/'+vehicle.body.vehicle.id,'PUT',{...vehicle.body.vehicle,economic_number:'GLOBAL-002'})).status,200);
    assert.equal((await call(root,global+'/vehicles/'+vehicle.body.vehicle.id+'/history')).status,200);
    assert.equal((await call(root,global+'/vehicles','POST',{economic_number:'Missing-line',operational_status:'available'})).status,400);
    await execute('UPDATE routes SET visible_in_app=true WHERE id=$1',[id]);
    const alert=await call(root,global+'/alerts','POST',{route_id:id,category:'routes',severity:'info',title_es:'Global',description_es:'Aviso global',published:false,expires_at:new Date(Date.now()+3600000).toISOString()});
    assert.equal(alert.status,201,JSON.stringify(alert.body));
    assert.equal(alert.body.alert.transport_line_id,yellow.id);
    assert.equal((await call(root,global+'/alerts/'+alert.body.alert.id,'PATCH',{published:false})).status,200);
    for(const [endpoint,method,body] of [
      ['/vehicles/'+vehicle.body.vehicle.id,'PUT',vehicle.body.vehicle],
      ['/db-routes/import','POST',payload],
      ['/alerts','POST',{route_id:id}],
      ['/drivers/'+globalDriver.id,'PUT',{name:'Intruso',revision:2}],
    ]) assert.equal((await call(yellowAdmin,global+endpoint,method,body)).status,403,endpoint);
    const lineList=await call(root,'/admin/lines');
    assert.ok(lineList.body.lines.length>=2);
    await execute('UPDATE admins SET is_superadmin=false WHERE id=$1',[root.id]);
    assert.equal((await call(root,global+'/summary')).status,403,'revocation applies to existing token');
    await execute('UPDATE admins SET is_superadmin=true WHERE id=$1',[root.id]);
  });

});
