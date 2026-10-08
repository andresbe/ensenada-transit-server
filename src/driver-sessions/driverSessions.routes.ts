import { parseTrackingHeartbeat } from "./trackingHealth";
import { sessionCheckins } from "./checkpoints.service";
import { locationsService } from "../modules/locations/locations.service";
import { Router } from "express";
import { authMiddleware, driverMiddleware } from "../auth/auth.middleware";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";
import { uuid } from "../passengers/validation";
import { driverIdentity, startSession } from "./driverSessions.service";

export const driverSessionsRouter = Router();
driverSessionsRouter.use(authMiddleware,driverMiddleware,apiRateLimiter);
driverSessionsRouter.get("/current/checkpoints",asyncHandler(async(req,res)=>{
  const identity=await driverIdentity({query},req.user!.sub);
  const session=(await query("SELECT id,bus_id,started_at FROM driver_sessions WHERE status='active' AND (conductor_id=$1 OR driver_id=$2) ORDER BY started_at DESC LIMIT 1",[identity.conductorId,identity.userId])).rows[0];
  if(!session){res.json({session:null,run:null,checkins:[],next:null,serverNow:Date.now()});return;}
  const checkins=await sessionCheckins({query},session.id);
  const run=(await query("SELECT cr.id,cr.variant_id,cr.direction,cr.started_at,(cr.plan_revision=r.checkpoint_revision) AS plan_current FROM driver_checkpoint_runs cr JOIN driver_sessions ds ON ds.id=cr.session_id JOIN routes r ON r.id=ds.route_id WHERE cr.session_id=$1 AND cr.ended_at IS NULL",[session.id])).rows[0]??null;
  const next=checkins.find(p=>!p.run_ended_at&&!p.arrived_at);
  let estimateSeconds:number|null=null;
  if(next && run?.plan_current) {
    const live=(await locationsService.getLiveBuses(false)).find(bus=>bus.busId===session.bus_id&&bus.sourceId===req.user!.sub&&bus.routeVariantId===next.variant_id);
    const speed=live?.avgSpeedMps ?? live?.speed;
    if(live && Date.now()-live.timestamp<=120000 && live.routeProgressMeters!==null && (live.distanceFromRouteMeters??Infinity)<=100 && typeof speed==="number" && speed>=1 && speed<=35) {
      const remaining=Number(next.progress_meters)-live.routeProgressMeters;
      if(remaining>=0)estimateSeconds=Math.ceil(remaining/speed);
    }
  }
  const now=Date.now();
  res.json({session,run,checkins,next:next ? {...next,estimate_seconds:estimateSeconds,projected_arrival_at:estimateSeconds===null?null:new Date(now+estimateSeconds*1000).toISOString(),pace_status:estimateSeconds===null?null:(now+estimateSeconds*1000>new Date(next.expected_at).getTime()+Number(next.tolerance_minutes)*60000?"late":"on_time")} : null,serverNow:now});
}));
driverSessionsRouter.get("/catalog",asyncHandler(async(req,res)=>{
  const identity=await driverIdentity({query},req.user!.sub);
  const vehicles=await query(`SELECT v.id,v.tracking_id AS bus_id,v.economic_number,v.assigned_route_id,v.transport_line_id,l.name AS line_name
    FROM fleet_vehicles v JOIN transport_lines l ON l.id=v.transport_line_id
    JOIN driver_line_memberships m ON m.line_id=l.id AND m.conductor_id=v.assigned_driver_id
    WHERE v.assigned_driver_id=$1 AND v.archived_at IS NULL AND v.operational_status='available' AND l.active AND m.active`,[identity.conductorId]);
  const routes=await query(`SELECT r.id,r.name,r.transport_line_id,
    (SELECT jsonb_agg(jsonb_build_object('id',rv.id,'name',rv.name,'direction',rv.direction,'coordinates',rv.coordinates))
      FROM route_variants rv WHERE rv.route_id=r.id AND jsonb_typeof(rv.coordinates)='array' AND jsonb_array_length(rv.coordinates)>=2) AS variants
    FROM routes r WHERE r.active AND EXISTS(SELECT 1 FROM fleet_vehicles v
      JOIN transport_lines l ON l.id=v.transport_line_id JOIN driver_line_memberships m ON m.line_id=l.id AND m.conductor_id=v.assigned_driver_id
      WHERE v.assigned_driver_id=$1 AND v.archived_at IS NULL AND v.operational_status='available' AND l.active AND m.active
      AND v.transport_line_id=r.transport_line_id AND (v.assigned_route_id IS NULL OR v.assigned_route_id=r.id)) ORDER BY r.name`,[identity.conductorId]);
  sendSuccess(res,{vehicles:vehicles.rows,routes:routes.rows.filter(r=>Array.isArray(r.variants)&&r.variants.length)});
}));
driverSessionsRouter.get("/vehicles",asyncHandler(async(req,res)=>{
  const identity=await driverIdentity({query},req.user!.sub);
  const result=await query(`SELECT v.id,tracking_id AS bus_id,economic_number,plate,capacity,assigned_route_id,transport_line_id
    FROM fleet_vehicles v WHERE assigned_driver_id=$1 AND archived_at IS NULL AND operational_status='available' AND (transport_line_id IS NULL OR EXISTS(SELECT 1 FROM driver_line_memberships m JOIN transport_lines l ON l.id=m.line_id WHERE m.conductor_id=$1 AND m.line_id=v.transport_line_id AND m.active AND l.active))
    ORDER BY economic_number`,[identity.conductorId]);
  sendSuccess(res,{vehicles:result.rows});
}));
driverSessionsRouter.post("/start",asyncHandler(async(req,res)=>{
  sendSuccess(res,{session:await startSession(req.user!.sub,req.body)},201);
}));
driverSessionsRouter.post("/:sessionId/end",asyncHandler(async(req,res)=>{
  const identity=await driverIdentity({query},req.user!.sub);
  const result=await query(`UPDATE driver_sessions SET status='ended',ended_at=now()
    WHERE id=$1 AND (driver_id=$2 OR conductor_id=$3) AND status='active' RETURNING *`,
    [uuid(req.params.sessionId),identity.userId,identity.conductorId]);
  if (!result.rows.length) throw new AppError("Active session not found.",404);
  sendSuccess(res,{session:result.rows[0]});
}));

driverSessionsRouter.post("/heartbeat",asyncHandler(async(req,res)=>{
  const data=parseTrackingHeartbeat(req.body),identity=await driverIdentity({query},req.user!.sub);
  const result=await query(`UPDATE driver_sessions s SET last_heartbeat_at=now(),
    last_gps_at=GREATEST(last_gps_at,to_timestamp($4::double precision/1000)),tracking_diagnostics=$5::jsonb,
    tracking_samples=COALESCE((SELECT jsonb_agg(p ORDER BY (p->>'timestamp')::double precision) FROM (
      SELECT DISTINCT ON ((p->>'timestamp')::double precision) p FROM jsonb_array_elements(s.tracking_samples || $6::jsonb) p
      ORDER BY (p->>'timestamp')::double precision DESC LIMIT 1440) latest),'[]'::jsonb)
    WHERE bus_id=$1 AND status='active' AND (conductor_id=$2 OR driver_id=$3) RETURNING id`,
    [data.busId,identity.conductorId,identity.userId,data.gpsTimestamp,JSON.stringify(data.diagnostics),JSON.stringify(data.samples)]);
  if(!result.rows.length)throw new AppError("No active assigned session.",409);
  sendSuccess(res,{receivedAt:Date.now(),accepted:data.samples.length});
}));
