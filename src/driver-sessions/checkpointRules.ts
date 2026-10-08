import { AppError } from "../shared/errors";
import { record, uuid } from "../passengers/validation";
import { haversineDistanceMeters } from "../shared/geo/geometry";

export function checkpointPlan(input: unknown) {
  const body = record(input);
  if (!Number.isInteger(body.revision) || Number(body.revision) < 0) throw new AppError("Versión de check-ins inválida.",400);
  if (!Array.isArray(body.checkpoints) || body.checkpoints.length > 100) throw new AppError("Máximo 100 check-ins por ruta.",400);
  const integer = (value:unknown,min:number,max:number,label:string) => {
    if (typeof value!=="number" || !Number.isInteger(value) || value<min || value>max) throw new AppError(`${label}: usa un entero entre ${min} y ${max}.`,400);
    return value;
  };
  const checkpoints = body.checkpoints.map(raw => {
    const p=record(raw);
    if (p.name !== undefined && p.name !== null && (typeof p.name !== "string" || p.name.trim().length > 100)) throw new AppError("Nombre del check-in: usa hasta 100 caracteres.",400);
    const name = typeof p.name === "string" ? p.name.trim() || null : p.name as null | undefined;
    return {name,stop_id:uuid(p.stop_id,"Parada"),target_minutes:integer(p.target_minutes,0,1440,"Minutos objetivo"),tolerance_minutes:integer(p.tolerance_minutes,0,30,"Tolerancia"),radius_meters:integer(p.radius_meters,30,300,"Radio")};
  });
  if(new Set(checkpoints.map(p=>p.stop_id)).size!==checkpoints.length) throw new AppError("Una parada solo puede tener un check-in por recorrido.",400);
  return {revision:Number(body.revision),checkpoints};
}

export function qualifiesForCheckin(point:{latitude:number;longitude:number;timestamp:number;accuracy?:number}, checkpoint:{latitude:number;longitude:number;radius_meters:number}, startedAt:number, now=Date.now()) {
  return Number.isFinite(point.accuracy) && point.accuracy!>=0 && point.accuracy!<=Math.min(50,checkpoint.radius_meters/2)
    && point.timestamp>=startedAt && point.timestamp<=now+10000 && now-point.timestamp<=120000
    && haversineDistanceMeters(point,checkpoint)<=checkpoint.radius_meters;
}

export function checkpointStatus(expectedAt:string|Date,arrivedAt:string|Date|null,tolerance:number,ended:boolean,now=Date.now()) {
  const delta=((arrivedAt ? new Date(arrivedAt).getTime() : now)-new Date(expectedAt).getTime())/1000;
  if(arrivedAt) return delta>tolerance*60 ? "late" : delta < -tolerance*60 ? "early" : "on_time";
  return ended ? "not_recorded" : delta>tolerance*60 ? "overdue" : "pending";
}
