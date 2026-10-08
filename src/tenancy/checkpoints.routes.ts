import { Router } from "express";
import { getClient, query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { uuid } from "../passengers/validation";
import { currentLine } from "./context";
import { checkpointPlan } from "../driver-sessions/checkpointRules";
import { sessionCheckins } from "../driver-sessions/checkpoints.service";

export const checkpointsRouter=Router({mergeParams:true});
checkpointsRouter.use(apiRateLimiter);
checkpointsRouter.get("/routes/:routeId/checkpoints",asyncHandler(async(req,res)=>{
  const routeId=uuid(req.params.routeId);
  const route=(await query("SELECT id,name,color,checkpoint_revision FROM routes WHERE id=$1 AND active",[routeId])).rows[0];
  if(!route)throw new AppError("Ruta no encontrada.",404);
  const variants=(await query("SELECT id,name,direction,coordinates FROM route_variants WHERE route_id=$1 ORDER BY direction",[routeId])).rows;
  const stops=(await query("SELECT id,variant_id,name,latitude::float8,longitude::float8,sequence FROM stops WHERE route_id=$1 ORDER BY variant_id,sequence,id",[routeId])).rows;
  const checkpoints=(await query("SELECT * FROM route_checkpoints WHERE route_id=$1",[routeId])).rows;
  res.json({route,variants,stops,checkpoints,revision:route.checkpoint_revision});
}));
checkpointsRouter.put("/routes/:routeId/checkpoints",asyncHandler(async(req,res)=>{
  const routeId=uuid(req.params.routeId),plan=checkpointPlan(req.body),line=currentLine(),db=await getClient();
  try {
    await db.query("BEGIN");
    const route=(await db.query("SELECT checkpoint_revision,transport_line_id FROM routes WHERE id=$1 AND active FOR UPDATE",[routeId])).rows[0];
    if(!route)throw new AppError("Ruta no encontrada.",404);
    if(route.checkpoint_revision!==plan.revision)throw new AppError("Los check-ins cambiaron. Cierra y vuelve a abrir para actualizarlos.",409);
    const stops=(await db.query("SELECT id,variant_id,sequence FROM stops WHERE route_id=$1 ORDER BY variant_id,sequence,id",[routeId])).rows;
    if(plan.checkpoints.some(p=>!stops.some(s=>s.id===p.stop_id)))throw new AppError("Selecciona paradas pertenecientes a esta ruta.",400);
    const previous=new Map<string,number>();
    for(const stop of stops) {
      const p=plan.checkpoints.find(c=>c.stop_id===stop.id);if(!p)continue;
      if(previous.has(stop.variant_id)&&p.target_minutes<=previous.get(stop.variant_id)!)throw new AppError("Los minutos objetivo deben aumentar según el orden de las paradas en cada recorrido.",400);
      previous.set(stop.variant_id,p.target_minutes);
    }
    await db.query("DELETE FROM route_checkpoints WHERE route_id=$1 AND NOT(stop_id=ANY($2::uuid[]))",[routeId,plan.checkpoints.map(p=>p.stop_id)]);
    for(const p of plan.checkpoints) {
      const stop=stops.find(s=>s.id===p.stop_id)!;
      await db.query(`INSERT INTO route_checkpoints(route_id,variant_id,transport_line_id,stop_id,target_minutes,tolerance_minutes,radius_meters,name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (variant_id,stop_id) DO UPDATE SET
          target_minutes=EXCLUDED.target_minutes,tolerance_minutes=EXCLUDED.tolerance_minutes,radius_meters=EXCLUDED.radius_meters,
          name=CASE WHEN $9::boolean THEN EXCLUDED.name ELSE route_checkpoints.name END`,
        [routeId,stop.variant_id,line?.lineId ?? route.transport_line_id,p.stop_id,p.target_minutes,p.tolerance_minutes,p.radius_meters,p.name??null,p.name!==undefined]);
    }
    await db.query("UPDATE routes SET checkpoint_revision=checkpoint_revision+1 WHERE id=$1",[routeId]);
    await db.query("COMMIT");res.json({revision:plan.revision+1});
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
}));
checkpointsRouter.get("/trips/:id/checkins",asyncHandler(async(req,res)=>{
  const id=uuid(req.params.id);
  if(!(await query("SELECT id FROM driver_sessions WHERE id=$1",[id])).rows.length)throw new AppError("Viaje no encontrado.",404);
  res.json({checkins:await sessionCheckins({query},id),serverNow:Date.now()});
}));
