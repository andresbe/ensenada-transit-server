import { Router } from "express";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { locationsService } from "../modules/locations/locations.service";
import { currentLine } from "./context";
// Mounted only after requireLine or requireSuperadmin.
export const adminReadRouter = Router({mergeParams:true});
adminReadRouter.get("/buses/live",asyncHandler(async(req,res)=>{
  const vehicles=(await query(`SELECT v.tracking_id,v.economic_number,l.color AS fleet_color,s.id AS session_id,s.route_id,s.started_at,c.correo AS source_id
    FROM fleet_vehicles v JOIN driver_sessions s ON s.vehicle_id=v.id AND s.bus_id=v.tracking_id AND s.status='active'
    JOIN conductores c ON c.id=s.conductor_id AND c.id=v.assigned_driver_id
    LEFT JOIN transport_lines l ON l.id=v.transport_line_id
    WHERE v.archived_at IS NULL AND v.operational_status='available'`)).rows;
  const byId=new Map(vehicles.map(v=>[v.tracking_id,v]));
  const buses=await locationsService.getLiveBuses(req.query.includeStale==='true');
  res.json({buses:buses.filter(b=>{
    const service=byId.get(b.busId);
    return service && b.sourceType==='driver' && b.sessionId===service.session_id && b.routeId===service.route_id && b.sourceId===service.source_id && b.timestamp>=new Date(service.started_at).getTime();
  }).map(b=>({...b, economicNumber:byId.get(b.busId)?.economic_number ?? null, fleetColor:byId.get(b.busId)?.fleet_color ?? null, ...(b.sourceType === "user" ? {sourceId:undefined} : {})}))});
}));
adminReadRouter.get("/alerts",asyncHandler(async(_req,res)=>{
  res.json({alerts:(await query("SELECT a.id,a.route_id,r.name AS route_name,a.title_es AS title,a.description_es AS description,a.category,a.severity,a.published,a.created_at,a.expires_at FROM alerts a LEFT JOIN routes r ON r.id=a.route_id ORDER BY a.created_at DESC,a.id LIMIT 100")).rows});
}));
adminReadRouter.get("/summary",asyncHandler(async(_req,res)=>{
  const [vehicles,routes,drivers]=await Promise.all([
    query("SELECT count(*)::int AS total,count(*) FILTER(WHERE operational_status='available')::int AS available FROM fleet_vehicles WHERE archived_at IS NULL"),
    query("SELECT count(*)::int AS total,count(*) FILTER(WHERE visible_in_app)::int AS published FROM routes WHERE active"),
    query("SELECT count(c.id)::int AS total FROM conductores c WHERE ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=c.id AND m.line_id=$1 AND m.active))",[currentLine()?.lineId ?? null]),
  ]);res.json({vehicles:vehicles.rows[0],routes:routes.rows[0],drivers:drivers.rows[0]});
}));
adminReadRouter.get("/reports",asyncHandler(async(_req,res)=>{
  res.json({records:(await query("SELECT ur.id,ur.type,ur.route_id,r.name AS route_name,ur.bus_id,ur.message,ur.severity,ur.status,ur.created_at,s.name AS stop_name FROM user_reports ur LEFT JOIN routes r ON r.id=ur.route_id LEFT JOIN stops s ON s.id=ur.stop_id ORDER BY ur.created_at DESC LIMIT 100")).rows});
}));
adminReadRouter.get("/audit",asyncHandler(async(_req,res)=>{
  res.json({records:(await query("SELECT action,entity_type,entity_id,created_at FROM line_audit_log ORDER BY created_at DESC LIMIT 100")).rows});
}));
