import { platformOperationsRouter } from "./platformOperations.routes";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { Router } from "express";
import bcrypt from "bcrypt";
import { authMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { query,getClient } from "../db";
import { requireSuperadmin } from "./access";
import { record,text,uuid,choice } from "../passengers/validation";
import { AppError } from "../shared/errors";
import { validateEmail,validatePassword } from "../auth/validators";
export const platformRouter=Router();
platformRouter.use(authMiddleware,requireSuperadmin,apiRateLimiter);
platformRouter.get("/admins",asyncHandler(async(_req,res)=>{
  const result = await query(
    "SELECT id,email,display_name,status,is_superadmin,created_at FROM admins ORDER BY created_at DESC,id DESC LIMIT 200"
  );
  res.json({admins:result.rows});
}));
platformRouter.post("/admins",asyncHandler(async(req,res)=>{
  const b=record(req.body),email=validateEmail(b.email),password=validatePassword(b.password);
  if (Buffer.byteLength(password,"utf8")>72) throw new AppError("La contraseña excede 72 bytes.",400);
  const hash=await bcrypt.hash(password,12);
  const result=await query("INSERT INTO admins(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name",[email,hash,text(b.name,"Nombre",100)]);
  res.status(201).json({admin:result.rows[0]});
}));
platformRouter.get("/unassigned",asyncHandler(async(_req,res)=>{
  const [routes,vehicles,drivers]=await Promise.all([
    query("SELECT id,name FROM routes WHERE transport_line_id IS NULL AND active ORDER BY name"),
    query("SELECT id,economic_number AS name FROM fleet_vehicles WHERE transport_line_id IS NULL AND archived_at IS NULL ORDER BY economic_number"),
    query("SELECT id,nombre_usuario AS name FROM conductores c WHERE NOT EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=c.id) ORDER BY nombre_usuario"),
  ]);res.json({routes:routes.rows,vehicles:vehicles.rows,drivers:drivers.rows});
}));
platformRouter.post("/assign",asyncHandler(async(req,res)=>{
  const b=record(req.body),id=uuid(b.id),line=uuid(b.line_id),kind=choice(b.kind,["routes","vehicles","drivers"] as const,"Tipo");
  const client=await getClient();
  try {
    await client.query("BEGIN");
    if (!(await client.query("SELECT id FROM transport_lines WHERE id=$1 AND active FOR SHARE",[line])).rows.length) throw new AppError("Línea no disponible.",400);
    if (kind==='drivers') {
      await client.query("INSERT INTO driver_line_memberships(conductor_id,line_id) VALUES($1,$2) ON CONFLICT(conductor_id,line_id) DO UPDATE SET active=true",[id,line]);
    } else {
      const table=kind==='routes'?'routes':'fleet_vehicles';
      const previous=(await client.query(`SELECT * FROM ${table} WHERE id=$1 AND transport_line_id IS NULL FOR UPDATE`,[id])).rows[0];
      if (!previous) throw new AppError("Registro no encontrado o ya asignado.",409);
      if ((kind==='routes' && !previous.active) || (kind==='vehicles' && previous.archived_at)) {
        throw new AppError("El registro fue dado de baja y no se puede asignar.",409);
      }
      const active=kind==='routes' ? await client.query("SELECT id FROM driver_sessions WHERE route_id=$1 AND status='active'",[id]) : await client.query("SELECT id FROM driver_sessions WHERE bus_id=$1 AND status='active'",[previous.tracking_id]);
      if (active.rows.length) throw new AppError("Finaliza los recorridos activos antes de asignar la línea.",409);
      await client.query(`UPDATE ${table} SET transport_line_id=$2 WHERE id=$1`,[id,line]);
      if (kind==='routes') {
        await client.query("UPDATE alerts SET transport_line_id=$2 WHERE route_id=$1 AND transport_line_id IS NULL",[id,line]);
        await client.query("UPDATE driver_sessions s SET transport_line_id=$2 WHERE s.route_id=$1 AND s.transport_line_id IS NULL AND (s.vehicle_id IS NULL OR EXISTS(SELECT 1 FROM fleet_vehicles v WHERE v.id=s.vehicle_id AND v.transport_line_id=$2))",[id,line]);
      } else {
        await client.query("UPDATE driver_sessions s SET vehicle_id=$1,transport_line_id=$2 WHERE s.bus_id=$3 AND s.transport_line_id IS NULL AND (s.route_id IS NULL OR EXISTS(SELECT 1 FROM routes r WHERE r.id=s.route_id AND r.transport_line_id=$2))",[id,line,previous.tracking_id]);
      }
    }
    await client.query("INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'ASSIGN',$3,$4)",[line,req.user!.sub,kind,id]);
    await client.query("COMMIT");res.json({assigned:true});
  } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
}));

platformRouter.use(platformOperationsRouter);
