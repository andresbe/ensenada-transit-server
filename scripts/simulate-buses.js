const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { randomBytes } = require("node:crypto");

const profiles = {
  normal: { interval:6, latency:0, jitter:0, "drop-rate":0 },
  "high-latency": { interval:15, latency:8, jitter:5, "drop-rate":0.25 },
  jumps: { interval:60, latency:15, jitter:10, "drop-rate":0, speed:60, dwell:0 },
};
function options(args) {
  const supplied={};
  for(let i=0;i<args.length;i++){
    const name=args[i].replace(/^--/,"");
    if(["list","dry-run","help","both"].includes(name))supplied[name]=true;
    else if(["route","variant","stop","profile","port","count","speed","interval","seconds","dwell","latency","jitter","drop-rate","seed"].includes(name)){
      const value=args[++i];if(!value||value.startsWith("--"))throw new Error("Falta valor para "+name);
      supplied[name]=["route","variant","stop","profile"].includes(name)?value:Number(value);
    }else throw new Error("Opcion desconocida: "+args[i]);
  }
  const profile=supplied.profile??"normal";if(!Object.hasOwn(profiles,profile))throw new Error("Perfil desconocido: "+profile);
  const result={port:3000,count:3,speed:24,seconds:600,dwell:12,seed:42,...profiles[profile],...supplied,profile};
  result.both=!!result.both||!result.variant;
  if(result.both&&result.variant)throw new Error("Usa --both o --variant, no ambos.");
  for(const [key,min,max] of [["port",1024,65535],["count",1,10],["speed",5,60],["interval",3,180],["seconds",5,7200],["dwell",0,120],["latency",0,120],["jitter",0,120],["drop-rate",0,1],["seed",0,4294967295]]){
    if(!Number.isFinite(result[key])||result[key]<min||result[key]>max)throw new Error("Valor invalido: "+key);
  }
  if(![result.port,result.count,result.seed].every(Number.isInteger))throw new Error("Puerto, cantidad y semilla deben ser enteros.");
  if(result.count*(result.both?2:1)*60/result.interval>60)throw new Error("Aumenta --interval para no superar 60 envios/minuto entre ambos sentidos.");
  return result;
}
function seededRandom(seed){let state=seed>>>0;return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
function networkSample(payload,now,settings,random,previousDue=0){
  if(random()<settings["drop-rate"])return undefined;
  const delay=Math.max(0,settings.latency+(random()*2-1)*settings.jitter)*1000;
  // Preserve per-bus order and original GPS timestamp, independently of delivery time.
  return {payload,capturedAt:now,due:Math.max(now+delay,previousDue+1)};
}

function distance(a, b) {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * 111320 * Math.cos((a[1] + b[1]) * rad / 2);
  const y = (b[1] - a[1]) * 111320;
  return Math.hypot(x, y);
}
function returnRunsSameWay(outbound, inbound) {
  if (!outbound?.length || !inbound?.length) return false;
  const span=distance(outbound[0],outbound.at(-1));
  if(span<200)return false; // Circular/short routes need manual inspection.
  const same=distance(outbound[0],inbound[0])+distance(outbound.at(-1),inbound.at(-1));
  const opposite=distance(outbound[0],inbound.at(-1))+distance(outbound.at(-1),inbound[0]);
  return same < span*0.25 && opposite > span;
}
function geometry(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.some(p => !Array.isArray(p)
    || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) throw new Error("Geometria invalida.");
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i++) cumulative.push(cumulative[i-1] + distance(coordinates[i-1], coordinates[i]));
  if (cumulative.at(-1) < 1) throw new Error("Recorrido sin longitud util.");
  return { coordinates, cumulative, length: cumulative.at(-1) };
}
function pointAt(g, meters) {
  const progress = Math.max(0, Math.min(g.length, meters));
  let i = 1;
  while (i < g.cumulative.length - 1 && g.cumulative[i] < progress) i++;
  const a = g.coordinates[i-1], b = g.coordinates[i];
  const f = (progress - g.cumulative[i-1]) / (g.cumulative[i] - g.cumulative[i-1] || 1);
  const heading = (Math.atan2((b[0]-a[0])*Math.cos(a[1]*Math.PI/180), b[1]-a[1])*180/Math.PI+360)%360;
  return { longitude: a[0]+(b[0]-a[0])*f, latitude: a[1]+(b[1]-a[1])*f, heading };
}
function stopProgress(g, stop) {
  const target = [Number(stop.longitude), Number(stop.latitude)];
  let closest = Infinity, progress = 0;
  for (let i=1; i<g.coordinates.length; i++) {
    const a=g.coordinates[i-1], b=g.coordinates[i], scale=Math.cos(target[1]*Math.PI/180);
    const dx=(b[0]-a[0])*scale, dy=b[1]-a[1];
    const t=Math.max(0,Math.min(1,(((target[0]-a[0])*scale)*dx+(target[1]-a[1])*dy)/(dx*dx+dy*dy || 1)));
    const d=distance(target,[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);
    if(d<closest){closest=d;progress=g.cumulative[i-1]+(g.cumulative[i]-g.cumulative[i-1])*t;}
  }
  return progress;
}
function advance(bus, dt, speed, length, stops, dwell, paused) {
  if (paused) return { ...bus, speed: 0 };
  if (bus.wait > 0) return { ...bus, wait: Math.max(0,bus.wait-dt), speed: 0 };
  const end = Math.min(length,bus.progress+speed*dt);
  const next = stops.find(stop => stop > bus.progress+0.1 && stop <= end);
  return { progress: next ?? end, wait: next !== undefined ? dwell : 0, speed: end >= length || next !== undefined ? 0 : speed };
}
async function request(base, resource, body, token) {
  const response = await fetch(base+resource, { method: body ? "POST" : "GET", redirect: "error",
    signal: AbortSignal.timeout(5000), headers: body ? { "content-type":"application/json", "x-local-simulation-token":token } : {},
    ...(body ? {body:JSON.stringify(body)} : {}) });
  if (!response.ok) throw new Error("HTTP " + response.status + " en " + resource + (response.status===403 ? ". Reinicia el backend con node scripts/dev-local.js." : ""));
  return response.json();
}
async function choose(items, title, requested, name) {
  if (!items.length) throw new Error("No hay " + title + " disponibles en el catalogo local.");
  items.forEach((item,i)=>console.log((i+1)+". "+name(item)+" ["+item.id+"]"));
  if (requested) {
    const selected=items.find(item=>item.id===requested);
    if (!selected) throw new Error("ID no encontrado: "+requested);
    return selected;
  }
  if (items.length===1) return items[0];
  if (!process.stdin.isTTY) throw new Error("Especifica el ID de " + title + " por parametro.");
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try { const answer=Number(await rl.question("Selecciona " + title + " (numero): ")); if (!Number.isInteger(answer)||!items[answer-1]) throw new Error("Seleccion invalida."); return items[answer-1]; }
  finally { rl.close(); }
}
async function main(args=process.argv.slice(2)) {
  const settings=options(args);
  if(settings.help){console.log("node scripts/simulate-buses.js [--list] [--route ID] [--both | --variant ID] [--profile normal|high-latency|jumps] [--latency SEG] [--jitter SEG] [--drop-rate 0..1] [--seed 42] [--stop ID] [--count 3] [--speed 24] [--seconds 600] [--interval 5] [--dwell 12] [--port 3000] [--dry-run]");return;}
  // Fixed literal loopback only: never load .env, accept remote URLs or follow redirects.
  const base="http://127.0.0.1:"+settings.port;
  const catalog=await request(base,"/catalog");
  if(catalog.schema_version!==1) throw new Error("Catalogo incompatible.");
  if(settings.list){for(const stop of catalog.stops) console.log("Parada: "+stop.name+" ["+stop.id+"] recorrido: "+stop.variant_id);for(const route of catalog.routes){console.log(route.name+" ["+route.id+"]");for(const variant of catalog.variants.filter(v=>v.route_id===route.id)) console.log("  "+variant.name+" ["+variant.id+"] - "+catalog.stops.filter(s=>s.variant_id===variant.id).length+" paradas");}return;}
  const route=await choose(catalog.routes,"ruta",settings.route,r=>r.name);
  const available=catalog.variants.filter(v=>v.route_id===route.id);
  const variants=[];
  if(settings.both){
    for(const direction of ["ida","vuelta"])variants.push(await choose(available.filter(v=>v.direction===direction),"recorrido de "+direction,undefined,v=>v.name+" ("+v.direction+")"));
  }else variants.push(await choose(available,"recorrido",settings.variant,v=>v.name+" ("+v.direction+")"));
  if(settings.stop&&!catalog.stops.some(stop=>stop.id===settings.stop&&variants.some(v=>v.id===stop.variant_id)))throw new Error("La parada no pertenece a los recorridos.");
  const outbound=available.find(v=>v.direction==="ida");
  for(const variant of variants){
    if(variant.direction==="vuelta" && returnRunsSameWay(outbound?.coordinates,variant.coordinates))
      throw new Error("El recorrido de vuelta esta guardado en el mismo sentido que ida. Corrige el orden de sus coordenadas antes de simular; no se invertira artificialmente el movimiento.");
  }
  const runId=randomBytes(4).toString("hex"),vehicles=[];
  for(const variant of variants){
    const g=geometry(variant.coordinates),stops=catalog.stops.filter(stop=>stop.variant_id===variant.id);
    const target=stops.find(stop=>stop.id===settings.stop)??stops[Math.floor(stops.length/2)];
    const targetProgress=target?stopProgress(g,target):g.length*0.5;
    const stopPositions=stops.map(stop=>stopProgress(g,stop)).sort((a,b)=>a-b);
    console.log(variant.direction+": "+settings.count+" camiones; "+stops.length+" paradas.");
    if(target)console.log("Parada de referencia: "+target.name+" ["+target.id+"]");
    if(targetProgress<50)console.log("AVISO: parada al inicio; selecciona una parada intermedia para evaluar llegadas.");
    for(let i=0;i<settings.count;i++){
      const progress=settings.stop&&target?.id===settings.stop?Math.max(0,Math.min(g.length,targetProgress+(i===2?150:-350-500*i))):g.length*(0.1+0.6*i/Math.max(1,settings.count-1));
      vehicles.push({id:"SIM-"+runId+"-"+String(vehicles.length+1).padStart(3,"0"),variant,g,stopPositions,state:{progress,wait:0,speed:settings.speed/3.6},lastDue:0,nextSample:0});
    }
  }
  console.log("Solo LOCAL: "+base+" | "+vehicles.length+" camiones totales | perfil "+settings.profile);
  console.log("Muestra cada "+settings.interval+"s; latencia "+settings.latency+"s +/- "+settings.jitter+"s; perdida "+settings["drop-rate"]*100+"%; semilla "+settings.seed);
  vehicles.forEach(bus=>console.log(bus.id+" -> "+bus.variant.direction));
  if(settings["dry-run"]){console.log("Validacion completada; no se enviaron posiciones.");return;}
  const secrets=JSON.parse(fs.readFileSync(path.join(__dirname,"../.local/secrets.json"),"utf8"));
  if(!/^[a-f0-9]{64}$/.test(secrets.debug))throw new Error("Credencial local invalida.");
  let paused=false,silent=false,stopped=false,queue=[];
  const random=seededRandom(settings.seed);
  const rl=process.stdin.isTTY?readline.createInterface({input:process.stdin,output:process.stdout}):undefined;
  rl?.on("line",line=>{if(line.trim()==="p")paused=!paused;if(line.trim()==="x"){silent=!silent;queue=[];vehicles.forEach(bus=>{bus.lastDue=0;bus.nextSample=0;});}if(line.trim()==="q")stopped=true;console.log("Movimiento: "+(paused?"pausado":"activo")+" | transmision: "+(silent?"apagada":"activa"));});
  const stop=()=>{stopped=true;};process.on("SIGINT",stop);process.on("SIGTERM",stop);
  console.log("p: pausa movimiento; x: corta senal; q: termina (seguido de Enter). Los camiones avanzan durante la latencia.");
  let last=Date.now(),nextSend=0;const started=last;
  try{
    while(!stopped&&Date.now()-started<settings.seconds*1000){
      const now=Date.now(),dt=(now-last)/1000;last=now;
      for(const bus of vehicles){
        bus.state=advance(bus.state,dt,settings.speed/3.6,bus.g.length,bus.stopPositions,settings.dwell,paused);
        if(now<bus.nextSample)continue;
        bus.nextSample=now+settings.interval*1000;
        if(silent)continue;
        const payload={sourceId:bus.id,sourceType:"driver",busId:bus.id,routeId:route.id,routeVariantId:bus.variant.id,routeVariantDirection:bus.variant.direction,...pointAt(bus.g,bus.state.progress),accuracy:5,speed:bus.state.speed,timestamp:now};
        const sample=networkSample(payload,now,settings,random,bus.lastDue);
        if(sample){bus.lastDue=sample.due;queue.push(sample);}else console.log("PERDIDA "+bus.id+" "+bus.variant.direction);
      }
      queue.sort((a,b)=>a.due-b.due);
      if(queue.length>1000)throw new Error("Cola de red excedida.");
      if(!silent&&queue[0]?.due<=now&&now>=nextSend){
        const sample=queue.shift();await request(base,"/locations/update",sample.payload,secrets.debug);
        nextSend=Date.now()+1000;
        console.log("ENVIADO "+sample.payload.busId+" "+sample.payload.routeVariantDirection+" | edad GPS "+((Date.now()-sample.capturedAt)/1000).toFixed(1)+"s | pendientes "+queue.length);
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }finally{queue=[];rl?.close();process.off("SIGINT",stop);process.off("SIGTERM",stop);console.log("Simulacion detenida; cola descartada. Unidades expiran con el TTL del backend. Flota sin cambios.");}

}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={options,geometry,pointAt,stopProgress,advance,request,seededRandom,networkSample,returnRunsSameWay};
