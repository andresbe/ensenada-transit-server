import { checkpointsRouter } from "./checkpoints.routes";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { driverManagementRouter } from "./drivers.routes";
import { operationsRouter } from "./operations.routes";
import { Router, json } from "express";
import bcrypt from "bcrypt";
import { authMiddleware } from "../auth/auth.middleware";
import { getActiveAdmin } from "../auth/admin.service";
import { query,getClient } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { requireLine,lineAccess } from "./access";
import { fleetRouter } from "../fleet/fleet.routes";
import { dbRoutesRouter } from "../routes/routes.routes";
import { catalogRouter } from "../passengers/catalog.routes";
import { passengerRouter } from "../passengers/passengers.routes";
import { locationsService } from "../modules/locations/locations.service";
import { validateEmail,validatePassword } from "../auth/validators";
import { record,text,uuid } from "../passengers/validation";
import { AppError } from "../shared/errors";

export const scopedLineRouter=Router({mergeParams:true});
scopedLineRouter.use(authMiddleware);
// Creating the global login and its membership is one privileged, explicitly scoped transaction.
scopedLineRouter.post("/drivers",apiRateLimiter,asyncHandler(async(req,res)=>{
  await getActiveAdmin(req.user!); const line=uuid(req.params.lineId);await lineAccess(req.user!.sub,line,true,true);
  const b=record(req.body),email=validateEmail(b.email),password=validatePassword(b.password);
  if (Buffer.byteLength(password,'utf8')>72) throw new AppError("La contraseña excede 72 bytes.",400);
  const hash=await bcrypt.hash(password,12),client=await getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM transport_lines WHERE id=$1 FOR UPDATE", [line]);
    const permission=await client.query("SELECT a.id FROM admins a JOIN transport_lines l ON l.id=$2 LEFT JOIN admin_line_memberships m ON m.admin_id=a.id AND m.line_id=l.id WHERE a.id=$1 AND a.status='active' AND a.token_version=$3 AND l.active AND (a.is_superadmin OR (m.active AND m.role='admin'))",[req.user!.sub,line,req.user!.tokenVersion]);
    if (!permission.rows.length) throw new AppError("Permiso revocado.",403);
    const driver=(await client.query("INSERT INTO conductores(correo,password,nombre_usuario) VALUES($1,$2,$3) RETURNING id,correo,nombre_usuario",[email,hash,text(b.name,"Nombre",100)])).rows[0];
    await client.query("INSERT INTO driver_line_memberships(conductor_id,line_id) VALUES($1,$2)",[driver.id,line]);
    await client.query("INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'CREATE','driver',$3)",[line,req.user!.sub,driver.id]);
    await client.query("COMMIT");res.status(201).json({driver});
  } catch(e) {await client.query("ROLLBACK");if ((e as {code?:string}).code==="23505") throw new AppError("Ya existe un conductor con ese correo.",409);throw e;} finally {client.release();}
}));
scopedLineRouter.use(driverManagementRouter);
scopedLineRouter.use(requireLine);
scopedLineRouter.use(checkpointsRouter);
scopedLineRouter.use(operationsRouter);
scopedLineRouter.get("/buses/live",asyncHandler(async(req,res)=>{
  const vehicles=(await query("SELECT tracking_id FROM fleet_vehicles WHERE archived_at IS NULL")).rows;
  const ids=new Set(vehicles.map(v=>v.tracking_id));
  const buses=await locationsService.getLiveBuses(req.query.includeStale==='true');
  res.json({buses:buses.filter(b=>ids.has(b.busId)).map(b=>b.sourceType === "user" ? {...b,sourceId:undefined} : b)});
}));
scopedLineRouter.get("/alerts",asyncHandler(async(_req,res)=>{
  res.json({alerts:(await query("SELECT a.id,a.route_id,r.name AS route_name,a.title_es AS title,a.description_es AS description,a.category,a.severity,a.published,a.created_at,a.expires_at FROM alerts a LEFT JOIN routes r ON r.id=a.route_id ORDER BY a.created_at DESC,a.id LIMIT 100")).rows});
}));
scopedLineRouter.get("/summary",asyncHandler(async(_req,res)=>{
  const [vehicles,routes,drivers]=await Promise.all([
    query("SELECT count(*)::int AS total,count(*) FILTER(WHERE operational_status='available')::int AS available FROM fleet_vehicles WHERE archived_at IS NULL"),
    query("SELECT count(*)::int AS total,count(*) FILTER(WHERE visible_in_app)::int AS published FROM routes WHERE active"),
    query("SELECT count(c.id)::int AS total FROM conductores c JOIN driver_line_memberships m ON m.conductor_id=c.id WHERE m.line_id=$1 AND m.active",[_req.params.lineId]),
  ]);res.json({vehicles:vehicles.rows[0],routes:routes.rows[0],drivers:drivers.rows[0]});
}));
scopedLineRouter.get("/reports",asyncHandler(async(_req,res)=>{
  res.json({records:(await query("SELECT ur.id,ur.type,ur.route_id,r.name AS route_name,ur.bus_id,ur.message,ur.severity,ur.status,ur.created_at,s.name AS stop_name FROM user_reports ur LEFT JOIN routes r ON r.id=ur.route_id LEFT JOIN stops s ON s.id=ur.stop_id ORDER BY ur.created_at DESC LIMIT 100")).rows});
}));
scopedLineRouter.get("/audit",asyncHandler(async(_req,res)=>{
  res.json({records:(await query("SELECT action,entity_type,entity_id,created_at FROM line_audit_log ORDER BY created_at DESC LIMIT 100")).rows});
}));
scopedLineRouter.use("/vehicles",fleetRouter);
scopedLineRouter.use("/db-routes",dbRoutesRouter);
scopedLineRouter.use(json());
scopedLineRouter.use(catalogRouter);
scopedLineRouter.use(passengerRouter);
