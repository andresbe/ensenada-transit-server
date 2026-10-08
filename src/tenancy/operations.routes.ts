import { trackingHealth } from "../driver-sessions/trackingHealth";
import { Router } from "express";
import { query, getClient } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { uuid } from "../passengers/validation";
import { currentLine } from "./context";

export const operationsRouter = Router({ mergeParams: true });

function pagination(input: Record<string, unknown>) {
  const page = Number(input.page ?? 1), limit = Number(input.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("Paginación inválida.", 400);
  return { page, limit, offset: (page - 1) * limit };
}
operationsRouter.get("/drivers", apiRateLimiter, asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query);
  const active = req.query.status ?? "all";
  if (!["all", "active", "suspended"].includes(String(active))) throw new AppError("Estado inválido.", 400);
  const params = [currentLine()!.lineId, "%" + String(req.query.q ?? "").trim().slice(0,100) + "%", active === "all" ? null : active === "active"];
  const from = "FROM conductores c JOIN driver_line_memberships m ON m.conductor_id=c.id LEFT JOIN fleet_vehicles v ON v.assigned_driver_id=c.id AND v.archived_at IS NULL WHERE m.line_id=$1 AND (c.nombre_usuario ILIKE $2 OR c.correo ILIKE $2) AND ($3::boolean IS NULL OR m.active=$3)";
  const [rows, count] = await Promise.all([
    query("SELECT c.id,c.correo,c.nombre_usuario,c.revision,m.active,v.economic_number,v.id AS vehicle_id " + from + " ORDER BY c.nombre_usuario,c.id LIMIT $4 OFFSET $5", [...params, limit, offset]),
    query("SELECT count(*)::int AS total " + from, params),
  ]);
  res.json({ drivers: rows.rows, total: count.rows[0].total, page, limit });
}));
const tripFrom = "FROM driver_sessions s LEFT JOIN fleet_vehicles v ON v.id=s.vehicle_id LEFT JOIN conductores c ON c.id=s.conductor_id LEFT JOIN routes r ON r.id=s.route_id LEFT JOIN route_variants rv ON rv.id=s.variant_id";
const tripColumns = "s.last_heartbeat_at,s.last_gps_at,s.tracking_diagnostics,s.id,s.bus_id,s.vehicle_id,s.conductor_id,s.route_id,s.variant_id,s.status,s.started_at,s.ended_at,v.economic_number,c.nombre_usuario AS driver_name,r.name AS route_name,rv.direction,EXTRACT(EPOCH FROM (COALESCE(s.ended_at,now())-s.started_at))::int AS duration_seconds";
operationsRouter.get("/trips", apiRateLimiter, asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query);
  const params: unknown[] = [], clauses: string[] = [];
  const add = (expression: string, value: unknown) => { params.push(value); clauses.push(expression.replace("?", "$" + params.length)); };
  for (const [key, column] of [["vehicle_id","s.vehicle_id"],["driver_id","s.conductor_id"],["route_id","s.route_id"]]) {
    if (req.query[key]) add(column + "=?", uuid(req.query[key], key));
  }
  if (req.query.status) {
    if (!["active","ended"].includes(String(req.query.status))) throw new AppError("Estado inválido.",400);
    add("s.status=?", req.query.status);
  }
  const dates: Record<string, string> = {};
  for (const key of ["from","to"]) {
    if (!req.query[key]) continue;
    const value = String(req.query[key]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new AppError("Fecha inválida.",400);
    dates[key] = value;
    add(key === "from" ? "s.started_at >= (?::date::timestamp AT TIME ZONE 'America/Tijuana')" : "s.started_at < ((?::date + 1)::timestamp AT TIME ZONE 'America/Tijuana')", value);
  }
  if (dates.from && dates.to && dates.from > dates.to) throw new AppError("El inicio debe ser anterior al fin.",400);
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const [rows,count] = await Promise.all([
    query("SELECT " + tripColumns + " " + tripFrom + where + " ORDER BY s.started_at DESC,s.id DESC LIMIT $" + (params.length+1) + " OFFSET $" + (params.length+2), [...params,limit,offset]),
    query("SELECT count(*)::int AS total " + tripFrom + where, params),
  ]);
  res.json({ records: rows.rows.map(row => ({...row,tracking_health:trackingHealth({status:row.status,started_at:row.started_at,last_heartbeat_at:row.last_heartbeat_at,last_gps_at:row.last_gps_at})})), total: count.rows[0].total, page, limit });
}));
operationsRouter.get("/trips/options", apiRateLimiter, asyncHandler(async (_req,res) => {
  const routes=await query("SELECT r.id,r.name FROM routes r WHERE r.active OR EXISTS(SELECT 1 FROM driver_sessions s WHERE s.route_id=r.id) ORDER BY r.name,r.id");
  res.json({routes:routes.rows});
}));
operationsRouter.get("/trips/:id", apiRateLimiter, asyncHandler(async (req,res) => {
  const result = await query("SELECT " + tripColumns + " " + tripFrom + " WHERE s.id=$1", [uuid(req.params.id)]);
  if (!result.rows[0]) throw new AppError("Viaje no encontrado.",404);
  res.json({ trip: {...result.rows[0],tracking_health:trackingHealth({status:result.rows[0].status,started_at:result.rows[0].started_at,last_heartbeat_at:result.rows[0].last_heartbeat_at,last_gps_at:result.rows[0].last_gps_at})} });
}));
operationsRouter.get("/vehicles/:id/history", apiRateLimiter, asyncHandler(async (req,res) => {
  const id=uuid(req.params.id), { page,limit,offset }=pagination(req.query);
  if (!(await query("SELECT id FROM fleet_vehicles WHERE id=$1",[id])).rows.length) throw new AppError("Camión no encontrado.",404);
  const [rows,count]=await Promise.all([
    query("SELECT h.id,h.created_at,h.action,h.operational_status,c.nombre_usuario AS driver_name,r.name AS route_name,a.display_name AS admin_name FROM fleet_assignment_history h LEFT JOIN conductores c ON c.id=h.conductor_id LEFT JOIN routes r ON r.id=h.route_id LEFT JOIN admins a ON a.id=h.admin_id WHERE h.vehicle_id=$1 ORDER BY h.created_at DESC,h.id LIMIT $2 OFFSET $3",[id,limit,offset]),
    query("SELECT count(*)::int AS total FROM fleet_assignment_history WHERE vehicle_id=$1",[id]),
  ]);
  res.json({ records:rows.rows,total:count.rows[0].total,page,limit });
}));
operationsRouter.post("/vehicles/:id/restore", apiRateLimiter, asyncHandler(async (req,res) => {
  const id=uuid(req.params.id),client=await getClient();
  try {
    await client.query("BEGIN");
    const vehicle=(await client.query("SELECT id,revision,archived_at FROM fleet_vehicles WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if (!vehicle || !vehicle.archived_at) throw new AppError("Camión dado de baja no encontrado.",404);
    if (vehicle.revision!==req.body?.revision) throw new AppError("El camión cambió. Actualiza la lista.",409);
    await client.query("UPDATE fleet_vehicles SET archived_at=NULL,assigned_driver_id=NULL,assigned_route_id=NULL,operational_status='out_of_service',revision=revision+1,updated_at=now() WHERE id=$1",[id]);
    await client.query("INSERT INTO fleet_assignment_history(vehicle_id,admin_id,action,operational_status) VALUES($1,$2,'restore','out_of_service')",[id,req.user!.sub]);
    await client.query("COMMIT");res.json({restored:true});
  } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
}));
