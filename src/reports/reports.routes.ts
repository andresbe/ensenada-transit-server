import { record, uuid, page, text, choice, coordinate } from "../passengers/validation";
import { Request, Response, Router } from "express";
import { authMiddleware, userAccountMiddleware } from "../auth/auth.middleware";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";
import { ReportType, UserReport } from "../types";

export const reportsRouter = Router();

const VALID_REPORT_TYPES: ReportType[] = ["crowded", "breakdown", "delay", "other", "stopIssue", "detour"];

// All reports routes require authentication
reportsRouter.use(authMiddleware, userAccountMiddleware);

// POST /reports
reportsRouter.post(
  "/",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);

    const body = record(req.body);
    // Accept the previous Spanish client while storing only stable contract values.
    const legacyTypes: Record<string,string> = {"Retraso":"delay","Mucha gente":"crowded","Problema en parada":"stopIssue","Ruta desviada":"detour"};
    const legacySeverity: Record<string,string> = {"Leve":"low","Moderado":"moderate","Alto":"high"};
    const type=choice(typeof body.type === "string" ? legacyTypes[body.type] ?? body.type : body.type,VALID_REPORT_TYPES,"type");
    const severity=choice(typeof body.severity === "string" ? legacySeverity[body.severity] ?? body.severity : body.severity ?? "moderate",["low","moderate","high"] as const,"severity");
    let routeId=body.route_id==null?null:uuid(body.route_id);
    const variantId=body.variant_id==null?null:uuid(body.variant_id);
    const stopId=body.stop_id==null?null:uuid(body.stop_id);
    const clientId=body.client_id==null?null:text(body.client_id,"client_id",100);
    const message=body.message==null?null:text(body.message,"message",2000);
    const busId=body.bus_id==null?null:text(body.bus_id,"bus_id",100);
    const latitude=body.latitude==null?null:coordinate(body.latitude,"latitude");
    const longitude=body.longitude==null?null:coordinate(body.longitude,"longitude");
    if((latitude===null)!==(longitude===null))throw new AppError("Latitude and longitude must be provided together.",400);
    for(const [table,id] of [["route_variants",variantId],["stops",stopId]] as const) {
      if(!id)continue;
      const item=(await query(`SELECT route_id${table==='stops'?',variant_id':''} FROM ${table} WHERE id=$1`,[id])).rows[0];
      if(!item || (routeId && item.route_id!==routeId) || (table==='stops' && variantId && item.variant_id!==variantId))throw new AppError("La parada o recorrido no corresponde a la ruta.",400);
      routeId=routeId??item.route_id;
    }
    if(routeId && !(await query("SELECT id FROM routes r WHERE id=$1 AND active AND visible_in_app AND (transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=r.transport_line_id AND l.active))",[routeId])).rows.length)throw new AppError("La ruta ya no está disponible.",400);
    const fields={type,route_id:routeId,variant_id:variantId,stop_id:stopId,bus_id:busId,message,severity,latitude,longitude};
    const result=await query<UserReport>(`INSERT INTO user_reports(user_id,type,route_id,variant_id,stop_id,bus_id,message,severity,latitude,longitude,client_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(user_id,client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *`,
      [req.user.sub,type,routeId,variantId,stopId,busId,message,severity,latitude,longitude,clientId]);
    if(!result.rows.length){
      const existing=(await query("SELECT * FROM user_reports WHERE user_id=$1 AND client_id=$2",[req.user.sub,clientId])).rows[0];
      if(!existing || Object.entries(fields).some(([key,value])=>String(existing[key]??'')!==String(value??'')))throw new AppError("Este identificador pertenece a otro reporte.",409);
      sendSuccess(res,{report:existing},200);return;
    }

    sendSuccess(res, { report: result.rows[0] }, 201);
  }),
);

// GET /reports/my
reportsRouter.get(
  "/my",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);

    const {limit,offset}=page(req.query);
    const result = await query<UserReport>(
      `SELECT * FROM user_reports WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.sub, limit, offset],
    );

    sendSuccess(res, { reports: result.rows });
  }),
);
