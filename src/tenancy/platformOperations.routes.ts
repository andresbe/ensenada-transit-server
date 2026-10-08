import { Router, json } from "express";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { AppError } from "../shared/errors";
import { uuid } from "../passengers/validation";
import { getAllRoutes, getRouteById, getVariant } from "../routes/routes.service";
import { dbRoutesRouter } from "../routes/routes.routes";
import { fleetRouter } from "../fleet/fleet.routes";
import { passengerRouter } from "../passengers/passengers.routes";
import { requireLine } from "./access";
import { operationsRouter } from "./operations.routes";
import { adminReadRouter } from "./adminRead.routes";
import { checkpointsRouter } from "./checkpoints.routes";
import { platformDriversRouter } from "./platformDrivers.routes";

// Private platform scope. The parent requires a live superadmin account for every request.
export const platformOperationsRouter = Router();
platformOperationsRouter.use(json({limit:"10mb"}));
platformOperationsRouter.get("/db-routes", asyncHandler(async (_req,res) => {
  res.json({routes:await getAllRoutes(true)});
}));
platformOperationsRouter.get("/db-routes/:id", asyncHandler(async (req,res) => {
  res.json({route:await getRouteById(uuid(req.params.id),true)});
}));
platformOperationsRouter.get("/db-routes/:id/variants/:variantId", asyncHandler(async (req,res) => {
  res.json({variant:await getVariant(uuid(req.params.id),uuid(req.params.variantId),true)});
}));
platformOperationsRouter.get("/catalog", asyncHandler(async (_req,res) => {
  const [routes,variants]=await Promise.all([
    getAllRoutes(true),query("SELECT v.* FROM route_variants v JOIN routes r ON r.id=v.route_id WHERE r.active"),
  ]);
  res.json({routes,variants:variants.rows});
}));
platformOperationsRouter.use(platformDriversRouter);
// Route/checkpoint/alert writes reuse the existing line rules and audit context.
// The line comes from the record, never from an administrator membership.
platformOperationsRouter.use(asyncHandler(async(req,res,next)=>{
  if (["GET","HEAD"].includes(req.method)) return next();
  let lineId: string | null = null;
  const routeMatch=req.path.match(/^\/(?:db-routes|routes)\/([^/]+)/);
  const alertMatch=req.path.match(/^\/alerts\/([^/]+)/);
  const vehicleMatch=req.path.match(/^\/vehicles\/([^/]+)/);
  if (routeMatch && routeMatch[1]!=="import") {
    const row=(await query("SELECT transport_line_id FROM routes WHERE id=$1",[uuid(routeMatch[1])])).rows[0];
    if(!row)throw new AppError("Ruta no encontrada.",404);
    lineId=row.transport_line_id;
  } else if(req.path==="/db-routes/import" || req.path==="/db-routes") {
    lineId=uuid(req.body?.transport_line_id,"Línea de la ruta");
  } else if(alertMatch) {
    const row=(await query("SELECT transport_line_id FROM alerts WHERE id=$1",[uuid(alertMatch[1])])).rows[0];
    if(!row)throw new AppError("Alerta no encontrada.",404);
    lineId=row.transport_line_id;
  } else if(req.path==="/alerts" && req.body?.route_id) {
    const row=(await query("SELECT transport_line_id FROM routes WHERE id=$1 AND active AND visible_in_app",[uuid(req.body.route_id)])).rows[0];
    if(!row)throw new AppError("Selecciona una ruta publicada.",400);
    lineId=row.transport_line_id;
  } else if(vehicleMatch) {
    const row=(await query("SELECT transport_line_id FROM fleet_vehicles WHERE id=$1",[uuid(vehicleMatch[1])])).rows[0];
    if(!row)throw new AppError("Camión no encontrado.",404);
    lineId=row.transport_line_id;
  } else if(req.path==="/vehicles") {
    lineId=uuid(req.body?.transport_line_id,"Línea del camión");
  }
  if(!lineId) return next();
  const previous=req.params;
  req.params={...req.params,lineId};
  requireLine(req,res,(error)=>{req.params=previous;next(error);});
}));
platformOperationsRouter.use(adminReadRouter);
platformOperationsRouter.use(operationsRouter);
platformOperationsRouter.use(checkpointsRouter);
platformOperationsRouter.use("/vehicles",fleetRouter);
platformOperationsRouter.use("/db-routes",dbRoutesRouter);
// Expose only administrative alert mutations, not the passenger account router.
platformOperationsRouter.use((req,res,next)=>{
  if (/^\/alerts(?:\/[^/]+)?$/.test(req.path) && ["POST","PATCH"].includes(req.method)) return passengerRouter(req,res,next);
  next();
});
