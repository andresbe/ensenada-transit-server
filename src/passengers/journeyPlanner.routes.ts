import { Router } from "express";
import { query } from "../db";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { asyncHandler } from "../middleware/errorHandler";
import { sendSuccess } from "../shared/response";
import { locationsService } from "../modules/locations/locations.service";
import { parsePlanInput, recommendRoutes, type PlanVariant } from "./journeyPlanner";

export const journeyPlannerRouter = Router();
journeyPlannerRouter.post("/journeys/plan", apiRateLimiter, asyncHandler(async (req, res) => {
  const input = parsePlanInput(req.body);
  const [result, live] = await Promise.all([
    query<PlanVariant>(`SELECT v.id,v.route_id,v.name,v.direction,v.coordinates,r.name AS route_name,r.short_name,r.color,r.operating_hours,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'latitude',s.latitude,'longitude',s.longitude,'sequence',s.sequence) ORDER BY s.sequence)
        FROM stops s WHERE s.variant_id=v.id AND s.route_id=r.id),'[]') AS stops
      FROM route_variants v JOIN routes r ON r.id=v.route_id
      WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=r.transport_line_id AND l.active))
      `, []),
    locationsService.getLiveBuses(false).then(buses => ({ buses, available: true })).catch(() => ({ buses: [], available: false })),
  ]);
  res.setHeader("Cache-Control", "no-store");
  sendSuccess(res, { plans: recommendRoutes(input, result.rows, live.buses), liveAvailable: live.available, maxWalkingMeters: input.maxWalkingMeters, generatedAt: new Date().toISOString() });
}));
