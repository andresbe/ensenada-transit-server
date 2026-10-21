const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

// Explicit opt-in. Only the dev-local.js database/API are reachable by this test.
test('local HTTP lifecycle with assigned vehicle and concurrent retries', {
  skip: process.env.RUN_LOCAL_LIFECYCLE !== '1', timeout: 30000,
}, async () => {
  const secrets = JSON.parse(readFileSync('.local/secrets.json', 'utf8'));
  const db = new Client({ host: '127.0.0.1', port: 55432, database: 'transit_local',
    user: 'transit_local', password: secrets.db, ssl: false });
  await db.connect();
  const line = randomUUID(), driver = randomUUID(), vehicle = randomUUID();
  const route = randomUUID(), variant = randomUUID(), stop = randomUUID();
  const email = 'lifecycle-' + driver + '@example.invalid';
  const token = jwt.sign({ sub: email, role: 'driver', tokenVersion: 0 }, secrets.jwt, { expiresIn: '5m' });
  async function api(path, body, expected = 200, auth = token) {
    const response = await fetch('http://127.0.0.1:3000/driver-sessions' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  try {
    await db.query('INSERT INTO transport_lines(id,name,short_code) VALUES($1,$2,$3)', [line, 'Lifecycle test', 'TEST']);
    await db.query('INSERT INTO conductores(id,correo,password,nombre_usuario) VALUES($1,$2,$3,$4)', [driver,email,'disabled-test-login','Lifecycle test']);
    await db.query('INSERT INTO driver_line_memberships(conductor_id,line_id) VALUES($1,$2)', [driver,line]);
    await db.query('INSERT INTO routes(id,name,short_name,transport_line_id) VALUES($1,$2,$3,$4)', [route,'Lifecycle route','TEST',line]);
    await db.query("INSERT INTO route_variants(id,route_id,name,direction,coordinates) VALUES($1,$2,'Ida','ida','[[-116,31],[-116,31.02]]')", [variant,route]);
    await db.query("INSERT INTO stops(id,route_id,variant_id,name,latitude,longitude) VALUES($1,$2,$3,'Control',31.01,-116)", [stop,route,variant]);
    await db.query('INSERT INTO route_checkpoints(route_id,variant_id,transport_line_id,stop_id,target_minutes) VALUES($1,$2,$3,$4,15)', [route,variant,line,stop]);
    await db.query('INSERT INTO fleet_vehicles(id,tracking_id,economic_number,transport_line_id,assigned_driver_id,assigned_route_id) VALUES($1::uuid,$1::text,$2,$3,$4,$5)', [vehicle,'TEST',line,driver,route]);
    await db.query("INSERT INTO stops(route_id,variant_id,name,latitude,longitude,sequence) VALUES($1,$2,'Parada sin control',31.015,-116,1)",[route,variant]);
    const catalog = await api('/catalog');
    assert.equal(catalog.routes[0].stops.length,2);
    assert.equal(catalog.vehicles[0].bus_id, vehicle);
    assert.equal(catalog.routes[0].id, route);
    assert.equal((await api('/current')).session, null);
    const body = { bus_id: vehicle, route_id: route, variant_id: variant, request_id: randomUUID() };
    const [first, retry] = await Promise.all([api('/start', body, 201), api('/start', body, 201)]);
    assert.equal(first.session.id, retry.session.id);
    assert.equal(first.session.started_at, retry.session.started_at);
    const current = (await api('/current')).session;
    assert.equal(current.id, first.session.id);
    assert.equal(current.direction, 'ida');
    assert.equal(current.route.stops.length,2);
    await db.query('UPDATE fleet_vehicles SET assigned_driver_id=NULL WHERE id=$1',[vehicle]);
    assert.equal((await api('/catalog')).vehicles.length,0);
    const reassigned=(await api('/current')).session;
    assert.equal(reassigned.id,current.id);
    assert.equal(reassigned.route.id,route);
    assert.equal(reassigned.bus_number,'TEST');
    await db.query('UPDATE fleet_vehicles SET assigned_driver_id=$1 WHERE id=$2',[driver,vehicle]);
    assert.equal(current.started_at, first.session.started_at);
    const checks = await api('/current/checkpoints');
    assert.equal(checks.checkins.length, 1);
    await api('/start', { ...body, request_id: randomUUID() }, 409);
    await api('/start', { ...body, bus_id: randomUUID() }, 409);
    await api('/current', undefined, 401, 'invalid-token');
    await api('/start', {bus_id:vehicle,route_id:route,variant_id:variant},409);
    const sample={sessionId:current.id,busId:vehicle,routeId:route,routeVariantId:variant,routeVariantDirection:'ida',sourceType:'driver',sourceId:email,latitude:31.01,longitude:-116,accuracy:8,timestamp:Date.now()};
    const sendPosition=body=>fetch('http://127.0.0.1:3000/locations/update',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const missingSession={...sample};delete missingSession.sessionId;
    assert.equal((await sendPosition(missingSession)).status,400);
    assert.equal((await sendPosition(sample)).status,201);
    const visibleBefore=await (await fetch('http://127.0.0.1:3000/buses/live')).json();
    assert.ok(visibleBefore.buses.some(bus=>bus.busId===vehicle));
    const end = '/'+ current.id + '/end';
    const [closed, closedAgain] = await Promise.all([api(end, {}), api(end, {})]);
    assert.equal(closed.session.ended_at, closedAgain.session.ended_at);
    assert.equal((await sendPosition({...sample,timestamp:Date.now()})).status,409);
    const visibleAfter=await (await fetch('http://127.0.0.1:3000/buses/live')).json();
    assert.ok(!visibleAfter.buses.some(bus=>bus.busId===vehicle));
    assert.equal((await api('/current')).session, null);
    assert.equal((await api('/start', body, 201)).session.status, 'ended');
    const next = await api('/start', {...body, request_id: randomUUID()}, 201);
    assert.notEqual(next.session.id, current.id);
    await api('/' + next.session.id + '/end', {});
    const runs = await db.query('SELECT ended_at FROM driver_checkpoint_runs WHERE session_id IN (SELECT id FROM driver_sessions WHERE conductor_id=$1)', [driver]);
    assert.equal(runs.rows.length, 2);
    assert.ok(runs.rows.every(run => run.ended_at));

    // Exercise the actual mobile service against HTTP, keeping only device storage/auth as adapters.
    const vm = require('node:vm'), ts = require('typescript');
    const {resolve} = require('node:path');
    const source = readFileSync(resolve('../ensenada-transit-conductor/src/services/driverAssignments.ts'),'utf8');
    const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const storage = new Map();
    let online = true, loseStartReply = true;
    const loadMobile = () => {
      const exports = {};
      vm.runInNewContext(compiled, {
        exports, AbortController, setTimeout, clearTimeout, Error,
        process:{env:{EXPO_PUBLIC_BACKEND_URL:'http://127.0.0.1:3000'}},
        fetch:async(url,options)=>{
          if(!online)throw new Error('simulated network outage');
          const response=await fetch(url,options);
          if(url.endsWith('/start') && loseStartReply){loseStartReply=false;await response.text();throw new Error('simulated lost response');}
          return response;
        },
        require:name=>{
          if(name==='react-native')return {NativeModules:{}};
          if(name==='@react-native-async-storage/async-storage')return {default:{
            getItem:async key=>storage.get(key)??null,
            setItem:async(key,value)=>storage.set(key,value),
          }};
          if(name==='./driverAuth')return {
            getDriverAuthToken:async()=>token,
            getDriverAuthSession:async()=>({user:{id:email}}),
            refreshDriverAuthSession:async()=>{throw Error('unexpected token renewal');},
          };
          throw Error('Unexpected mobile import: '+name);
        },
      });
      return exports;
    };
    let mobile=loadMobile();
    await assert.rejects(mobile.beginAssignedSession(vehicle,route,variant),/pendiente/i);
    const created=(await api('/current')).session;
    assert.ok(created);
    mobile=loadMobile(); // Simulated process restart, durable storage retained.
    const recovered=await mobile.beginAssignedSession(vehicle,route,variant);
    assert.equal(recovered.id,created.id);
    assert.equal(recovered.started_at,created.started_at);
    await mobile.acknowledgeSessionStart(email);
    online=false;
    await mobile.endAssignedSession(recovered.id,email);
    assert.equal(await mobile.pendingSessionEndCount(email),1);
    await assert.rejects(mobile.beginAssignedSession(vehicle,route,variant),/cierre anterior/i);
    mobile=loadMobile();
    online=true;
    await mobile.flushPendingSessionEnds();
    assert.equal(await mobile.pendingSessionEndCount(email),0);
    assert.equal((await api('/current')).session,null);
    const count=await db.query('SELECT count(*)::int AS count FROM driver_sessions WHERE conductor_id=$1',[driver]);
    assert.equal(count.rows[0].count,3,'lost response and process restart must not duplicate a service');

  } finally {
    await db.query('DELETE FROM driver_sessions WHERE conductor_id=$1', [driver]);
    await db.query('DELETE FROM fleet_vehicles WHERE id=$1', [vehicle]);
    await db.query('DELETE FROM route_checkpoints WHERE route_id=$1', [route]);
    await db.query('DELETE FROM routes WHERE id=$1', [route]);
    await db.query('DELETE FROM driver_line_memberships WHERE conductor_id=$1', [driver]);
    await db.query('DELETE FROM conductores WHERE id=$1', [driver]);
    await db.query('DELETE FROM transport_lines WHERE id=$1', [line]);
    await db.end();
  }
});
