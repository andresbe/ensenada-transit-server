const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const bcrypt=require('bcrypt');
process.env.JWT_SECRET='second-pass-isolated-tests-only';
process.env.GOOGLE_WEB_CLIENT_ID='test-audience';
process.env.NODE_ENV='test';

test('credential migration, Google ownership, revocation, profile and push boundaries',async t=>{
 const pg=new PGlite({extensions:{pgcrypto}});t.after(()=>pg.close());
 const execute=async(sql,params)=>params?pg.query(sql,params):((await pg.exec(sql)).at(-1)??{rows:[]});
 const client={query:execute,release(){}};
 await require('../scripts/migration-runner').migrate(client,path.join(__dirname,'../src/db/migrations'),()=>{});
 const db=require('../dist/db');db.query=execute;db.getClient=async()=>client;
 require('../dist/redis/cache').incrementRateLimit=async()=>1;
 const auth=require('../dist/auth/auth.service');
 const {OAuth2Client}=require('google-auth-library');
 const oldVerify=OAuth2Client.prototype.verifyIdToken;t.after(()=>{OAuth2Client.prototype.verifyIdToken=oldVerify;});
 let claims={sub:'victim-google',email:'victim@gmail.com',email_verified:true};
 OAuth2Client.prototype.verifyIdToken=async()=>({getPayload:()=>claims});
 const hash=await bcrypt.hash('precreated-password',4);
 const owner=(await pg.query("INSERT INTO users(email,password_hash,auth_provider,role,status) VALUES($1,$2,'email','user','active') RETURNING *",[claims.email,hash])).rows[0];
 const tokenBefore=auth.generateToken(owner);
 const express=require('express');const app=express();app.use(express.json());
 app.use('/users',require('../dist/users/users.routes').usersRouter);
 app.use(require('../dist/passengers/notifications.routes').notificationsRouter);
 app.use(require('../dist/shared/errors').errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const call=(url,token,method='GET',body)=>fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 let token;
 await t.test('Google conversion removes old password and revokes old tokens, preserving user data',async()=>{
  await pg.query("UPDATE users SET display_name='Preserved' WHERE id=$1",[owner.id]);
  await pg.query("INSERT INTO passenger_devices(user_id,token,platform) VALUES($1,'ExpoPushToken[prelink]','android')",[owner.id]);
  const session=await auth.socialAuth({provider:'google',provider_token:'test'});token=session.token;
  assert.equal(session.user.id,owner.id);assert.equal(session.user.display_name,'Preserved');assert.equal(session.user.token_version,undefined);
  const stored=(await pg.query('SELECT * FROM users WHERE id=$1',[owner.id])).rows[0];
  assert.equal((await pg.query("SELECT active FROM passenger_devices WHERE token='ExpoPushToken[prelink]'")).rows[0].active,false);
  assert.equal(stored.password_hash,null);assert.equal(stored.auth_provider,'google');assert.equal(stored.token_version,owner.token_version+1);
  await assert.rejects(auth.login(owner.email,'precreated-password'),{statusCode:401});
  await assert.rejects(auth.refreshToken(tokenBefore),{statusCode:401});
  assert.equal((await call('/users/me',tokenBefore)).status,401);
  assert.equal((await call('/users/me',token)).status,200);
  const again=await auth.socialAuth({provider:'google',provider_token:'test'});assert.equal(again.user.id,owner.id);
  assert.equal(auth.validateToken(again.token).tokenVersion,stored.token_version);
 });
 await t.test('password, email, role and suspension revoke sessions; harmless edits do not',async()=>{
  for(const [field,value] of [['password_hash',hash],['email','changed@gmail.com'],['role','driver'],['role','user'],['status','suspended'],['status','active']]){
   const before=(await pg.query('SELECT * FROM users WHERE id=$1',[owner.id])).rows[0];
   const old=auth.generateToken(before);
   await pg.query('UPDATE users SET '+field+'=$2 WHERE id=$1',[owner.id,value]);
   await assert.rejects(auth.refreshToken(old),{statusCode:401});
   assert.equal((await call('/users/me',old)).status,401);
  }
  const row=(await pg.query('SELECT * FROM users WHERE id=$1',[owner.id])).rows[0];token=auth.generateToken(row);
  await pg.query("UPDATE users SET display_name='New name' WHERE id=$1",[owner.id]);
  assert.equal((await call('/users/me',token)).status,200);assert.ok((await auth.refreshToken(token)).token);
  const unversioned=require('jsonwebtoken').sign({sub:owner.id,role:'user'},process.env.JWT_SECRET);
  assert.equal((await call('/users/me',unversioned)).status,401);
  await assert.rejects(pg.query('UPDATE users SET token_version=1 WHERE id=$1',[owner.id]));
 });
 await t.test('both profile entry points reject bad names and legacy arbitrary photo URLs',async()=>{
  for(const url of ['/users/me','/users/me/profile'])for(const display_name of ['',null,'x'.repeat(101),'bad\u0000name']){
   assert.equal((await call(url,token,'PATCH',{display_name})).status,400,url);
  }
  assert.equal((await call('/users/me',token,'PATCH',{photo_url:'https://arbitrary.example/image'})).status,400);
  assert.equal((await call('/users/me',token,'PATCH',{display_name:' Valid name '})).status,200);
  assert.equal((await pg.query('SELECT display_name FROM users WHERE id=$1',[owner.id])).rows[0].display_name,'Valid name');
 });
 await t.test('push checks visibility and account status at enqueue and delivery, including old queued jobs',async()=>{
  const line=(await pg.query("INSERT INTO transport_lines(name,color,short_code) VALUES('Test line','#123456','T') RETURNING id")).rows[0].id;
  const route=(await pg.query("INSERT INTO routes(name,short_name,transport_line_id) VALUES('Test','T',$1) RETURNING id",[line])).rows[0].id;
  await pg.query("INSERT INTO user_preferences(user_id,push_notifications_enabled,favorite_route_alerts) VALUES($1,true,true) ON CONFLICT(user_id) DO UPDATE SET push_notifications_enabled=true,favorite_route_alerts=true",[owner.id]);
  await pg.query("INSERT INTO passenger_devices(user_id,token,platform) VALUES($1,'ExpoPushToken[test-only]','android')",[owner.id]);
  const device=(await pg.query('SELECT id FROM passenger_devices WHERE user_id=$1 AND active',[owner.id])).rows[0].id;
  assert.equal((await call('/notification-subscriptions',token,'POST',{route_id:route})).status,201);
  const alert=(await pg.query("INSERT INTO alerts(route_id,category,severity,title_es,description_es,published,expires_at) VALUES($1,'routes','info','Test','Test',true,now()+interval '1 day') RETURNING id",[route])).rows[0].id;
  await pg.query("INSERT INTO alerts(transport_line_id,category,severity,title_es,description_es,published,expires_at) VALUES($1,'routes','info','Line alert','Test',true,now()+interval '1 day'),(NULL,'routes','info','Global alert','Test',true,now()+interval '1 day')",[line]);
  const {deliverPublishedAlerts}=require('../dist/passengers/push.service');let sends=0;
  const fakeFetch=async()=>{sends++;return{ok:true,json:async()=>({data:{status:'ok',id:'fake-ticket'}})}};
  const queue=async()=>{await pg.query('DELETE FROM notification_deliveries');await pg.query('INSERT INTO notification_deliveries(user_id,device_id,alert_id) SELECT $1,$2,id FROM alerts',[owner.id,device]);};
  for(const [table,field,bad,good,id] of [['routes','visible_in_app',false,true,route],['routes','active',false,true,route],['transport_lines','active',false,true,line],['users','status','suspended','active',owner.id]]){
   await pg.query('UPDATE '+table+' SET '+field+'=$2 WHERE id=$1',[id,bad]);
   await pg.query('DELETE FROM notification_deliveries');await deliverPublishedAlerts(fakeFetch);
   assert.equal((await pg.query('SELECT * FROM notification_deliveries')).rows.length,0,'must not enqueue');
   await queue();await deliverPublishedAlerts(fakeFetch);assert.equal(sends,0);
   assert.ok((await pg.query('SELECT status FROM notification_deliveries')).rows.every(r=>r.status==='suppressed'));
   await pg.query('UPDATE '+table+' SET '+field+'=$2 WHERE id=$1',[id,good]);
  }
  token=auth.generateToken((await pg.query('SELECT * FROM users WHERE id=$1',[owner.id])).rows[0]);
  await pg.query('UPDATE routes SET visible_in_app=false WHERE id=$1',[route]);
  assert.equal((await call('/notification-subscriptions',token,'POST',{route_id:route})).status,404);
  await pg.query('UPDATE routes SET visible_in_app=true WHERE id=$1',[route]);
  await pg.query('DELETE FROM notification_deliveries');await deliverPublishedAlerts(fakeFetch);assert.equal(sends,3);
 });
});


test('migration repairs already-linked credentials and leaves unlinked passwords intact',async t=>{
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec("CREATE TABLE users(id text PRIMARY KEY,email text,password_hash text,role text,status text,auth_provider text); CREATE TABLE user_social_identities(user_id text,provider text); CREATE TABLE passenger_devices(user_id text,active boolean); INSERT INTO users VALUES('linked','one@gmail.com','old-hash','user','active','email'),('email','two@example.com','keep-hash','user','active','email');INSERT INTO user_social_identities VALUES('linked','google');");
 await pg.exec(require('fs').readFileSync(path.join(__dirname,'../src/db/migrations/026_passenger_credentials.sql'),'utf8'));
 const linked=(await pg.query("SELECT * FROM users WHERE id='linked'")).rows[0];
 assert.equal(linked.password_hash,null);assert.equal(linked.auth_provider,'google');assert.equal(linked.token_version,2);
 const email=(await pg.query("SELECT * FROM users WHERE id='email'")).rows[0];assert.equal(email.password_hash,'keep-hash');assert.equal(email.token_version,1);
 await pg.exec("UPDATE users SET password_hash='new-hash' WHERE id='email'");assert.equal((await pg.query("SELECT token_version FROM users WHERE id='email'")).rows[0].token_version,2);
});
