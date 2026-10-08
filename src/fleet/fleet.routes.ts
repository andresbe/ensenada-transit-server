import { currentLine } from "../tenancy/context";
import { Router } from "express";
import { authMiddleware, adminMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { query } from "../db";
import { sendSuccess } from "../shared/response";
import { AppError } from "../shared/errors";
import { getVehicle, saveVehicle, archiveVehicle, vehicleColumns, vehicleJoins } from "./fleet.service";

export const fleetRouter = Router();
fleetRouter.use(authMiddleware, adminMiddleware, apiRateLimiter);
fleetRouter.get("/options", asyncHandler(async (_req,res) => {
  const [lines,drivers,routes] = await Promise.all([
    query("SELECT id,name FROM transport_lines WHERE active=true ORDER BY display_order,name"),
    query("SELECT c.id,c.nombre_usuario AS name,ARRAY(SELECT m.line_id FROM driver_line_memberships m WHERE m.conductor_id=c.id AND m.active) AS line_ids FROM conductores c WHERE ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=c.id AND m.line_id=$1 AND m.active)) ORDER BY c.nombre_usuario", [currentLine()?.lineId ?? null]),
    query("SELECT id,name,transport_line_id FROM routes WHERE active=true ORDER BY name"),
  ]);
  sendSuccess(res, {lines:lines.rows, drivers:drivers.rows, routes:routes.rows});
}));
fleetRouter.get("/", asyncHandler(async (req,res) => {
  const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("Paginación inválida.", 400);
  const search = String(req.query.q ?? "").trim().slice(0,100);
  const archived = req.query.archived === "true";
  const where = `WHERE (v.archived_at IS NOT NULL)=$1 AND
    (v.economic_number ILIKE $2 OR COALESCE(v.plate,'') ILIKE $2 OR COALESCE(c.nombre_usuario,'') ILIKE $2)`;
  const params = [archived, "%"+search+"%"];
  const [rows,count] = await Promise.all([
    query(`SELECT ${vehicleColumns} ${vehicleJoins} ${where} ORDER BY v.economic_number,v.id LIMIT $3 OFFSET $4`, [...params,limit,(page-1)*limit]),
    query(`SELECT count(*)::int AS total ${vehicleJoins} ${where}`, params),
  ]);
  sendSuccess(res, {vehicles:rows.rows, total:count.rows[0].total, page, limit});
}));
fleetRouter.get("/:id", asyncHandler(async (req,res) => { sendSuccess(res, {vehicle:await getVehicle(req.params.id)}); }));
fleetRouter.post("/", asyncHandler(async (req,res) => { sendSuccess(res, {vehicle:await saveVehicle(null,req.body,req.user!.sub)}, 201); }));
fleetRouter.put("/:id", asyncHandler(async (req,res) => { sendSuccess(res, {vehicle:await saveVehicle(req.params.id,req.body,req.user!.sub)}); }));
fleetRouter.delete("/:id", asyncHandler(async (req,res) => {
  await archiveVehicle(req.params.id,req.body?.revision,req.user!.sub); res.status(204).end();
}));
