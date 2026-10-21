const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const {once}=require('node:events');

test('Redis reconnects beyond the old retry limit and after a second outage',{timeout:30000},async t=>{
 // Isolated RESP endpoint: no shared Redis or application data is touched.
 const sockets=new Set();
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  let pending='';socket.on('data',data=>{
   pending+=data.toString();
   while(pending.startsWith('*')){
    const lines=pending.split('\r\n');const count=Number(lines[0].slice(1));
    if(lines.length<2*count+2)break;
    const args=Array.from({length:count},(_,i)=>lines[2+i*2]);
    pending=lines.slice(2*count+1).join('\r\n');
    socket.write(args[0].toUpperCase()==='PING'?'+PONG\r\n':'+OK\r\n');
   }
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 await new Promise(r=>server.close(r));
 process.env.REDIS_URL='redis://127.0.0.1:'+port;
 const {default:client,connectRedis}=require('../dist/redis/client');
 t.after(async()=>{if(client.isOpen)await client.disconnect();for(const s of sockets)s.destroy();if(server.listening)await new Promise(r=>server.close(r));});
 let attempts=0;
 const enoughAttempts=new Promise(resolve=>client.on('reconnecting',()=>{if(++attempts===12)resolve();}));
 const connecting=connectRedis();connecting.catch(()=>{});
 await enoughAttempts;
 await assert.rejects(client.get('offline-test'));
 server.listen(port,'127.0.0.1');await once(server,'listening');await connecting;
 assert.ok(attempts>=12);assert.equal(await client.ping(),'PONG');
 const recovered=new Promise(resolve=>client.once('ready',resolve));
 for(const socket of sockets)socket.destroy();
 await recovered;assert.equal(await client.ping(),'PONG');
});
