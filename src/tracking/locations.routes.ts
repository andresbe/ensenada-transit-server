/**
 * Tracking module – maintains full backward compatibility with the original
 * in-memory location service while also persisting bus locations to Redis.
 */
import { Request, Response, Router } from "express";
import { setBusLocation } from "../redis/cache";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { sendSuccess } from "../shared/response";
import { locationsService } from "../modules/locations/locations.service";
import {
  parseIncludeStale,
  validateLocationUpdate,
} from "../modules/locations/locations.validation";

export const trackingRouter = Router();

// POST /locations/update
trackingRouter.post(
  "/locations/update",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = validateLocationUpdate(req.body);
    const location = locationsService.updateLocation(payload);

    // Persist to Redis for cross-process sharing (best-effort)
    await setBusLocation(payload.busId, location).catch((err) =>
      console.error("[tracking] Redis setBusLocation error:", err),
    );

    sendSuccess(
      res,
      {
        busId: location.busId,
        routeId: location.routeId,
        routeVariantId: location.routeVariantId,
        routeVariantDirection: location.routeVariantDirection,
        updatedAt: location.updatedAt,
        routeProgressMeters: location.routeProgressMeters,
        snappedLatitude: location.snappedLatitude,
        snappedLongitude: location.snappedLongitude,
        distanceFromRouteMeters: location.distanceFromRouteMeters,
        avgSpeedMps: location.avgSpeedMps,
        directionConfidence: location.directionConfidence,
        etaConfidence: location.etaConfidence,
      },
      201,
    );
  }),
);

// GET /buses/live
trackingRouter.get(
  "/buses/live",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const includeStale = parseIncludeStale(req.query.includeStale);
    const buses = locationsService.getLiveBuses(includeStale);
    sendSuccess(res, { buses });
  }),
);

// GET /routes/:routeId/live
trackingRouter.get(
  "/routes/:routeId/live",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const includeStale = parseIncludeStale(req.query.includeStale);
    // Filter by routeId (not routeVariantId) across all variants
    const allBuses = locationsService.getLiveBuses(includeStale);
    const buses = allBuses.filter((b) => b.routeId === req.params.routeId);
    sendSuccess(res, { routeId: req.params.routeId, buses });
  }),
);
