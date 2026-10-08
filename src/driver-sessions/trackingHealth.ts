import { AppError } from "../shared/errors";
export const trackingSilenceMs = Math.max(60000, Math.min(600000, Number(process.env.DRIVER_TRACKING_SILENCE_MS) || 120000));
export function trackingHealth(row: {status:string; started_at:Date|string; last_heartbeat_at?:Date|string|null; last_gps_at?:Date|string|null}, now=Date.now()) {
  if(row.status!=="active") return "ended";
  if(!row.last_heartbeat_at) return now-new Date(row.started_at).getTime()>trackingSilenceMs ? "disconnected" : "starting";
  if(now-new Date(row.last_heartbeat_at).getTime()>trackingSilenceMs) return "disconnected";
  if(!row.last_gps_at || now-new Date(row.last_gps_at).getTime()>trackingSilenceMs) return "gps_stale";
  return "transmitting";
}
export function parseTrackingHeartbeat(body:any, now=Date.now()) {
  if(!body || typeof body.busId!=="string" || !body.busId.trim() || body.busId.length>100) throw new AppError("Invalid busId.",400);
  const time=(v:unknown) => typeof v==="number" && Number.isFinite(v) && v>0 && v<=now+30000 && v>=now-86400000;
  if(body.gpsTimestamp!=null && !time(body.gpsTimestamp)) throw new AppError("Invalid GPS timestamp.",400);
  const samples=body.samples ?? [];
  if(!Array.isArray(samples)||samples.length>120) throw new AppError("Invalid sample batch.",400);
  const clean=samples.map((p:any)=>{
    if(!p || !time(p.timestamp)||typeof p.latitude!=="number"||!Number.isFinite(p.latitude)||Math.abs(p.latitude)>90||typeof p.longitude!=="number"||!Number.isFinite(p.longitude)||Math.abs(p.longitude)>180)throw new AppError("Invalid GPS sample.",400);
    return {timestamp:p.timestamp,latitude:p.latitude,longitude:p.longitude};
  });
  const diagnostics:Record<string,string|number>={};
  for(const key of ["model","androidVersion","appVersion","lastExitReason"]) if(typeof body[key]==="string") diagnostics[key]=body[key].slice(0,160);
  for(const key of ["batteryPercent","pendingSamples","serviceUptimeMs","memoryPssKb","processCpuTimeMs"]) if(typeof body[key]==="number"&&Number.isFinite(body[key])&&body[key]>=0)diagnostics[key]=Math.min(body[key],1e12);
  return {busId:body.busId,gpsTimestamp:body.gpsTimestamp??null,samples:clean,diagnostics};
}
