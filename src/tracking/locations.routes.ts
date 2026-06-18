/**
 * Tracking module – maintains full backward compatibility with the original
 * in-memory location service while also persisting bus locations to Redis.
 */
import { Request, Response, Router } from "express";
import { setLiveBusLocation } from "../redis/cache";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";
import { locationsService } from "../modules/locations/locations.service";
import { LocationUpdateRequest } from "../modules/locations/locations.types";
import {
  parseIncludeStale,
  validateLocationUpdate,
} from "../modules/locations/locations.validation";
import {
  getRecentLocationUpdates,
  recordLocationUpdateReceived,
  recordLocationUpdateServerError,
  recordLocationUpdateSuccess,
  recordLocationUpdateValidationError,
} from "./locationDiagnostics";

export const trackingRouter = Router();

// GET /locations/debug/recent
trackingRouter.get(
  "/locations/debug/recent",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const debugToken = process.env.LOCATION_DEBUG_TOKEN;

    if (debugToken && req.header("x-debug-token") !== debugToken) {
      throw new AppError("Invalid or missing debug token.", 403);
    }

    const updates = getRecentLocationUpdates();
    sendSuccess(res, {
      count: updates.length,
      updates,
    });
  }),
);

// POST /locations/update
trackingRouter.post(
  "/locations/update",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const startMs = Date.now();
    let payload: LocationUpdateRequest;

    try {
      payload = validateLocationUpdate(req.body);
    } catch (error) {
      const statusCode = error instanceof AppError ? error.statusCode : 400;
      recordLocationUpdateValidationError(req, error, statusCode);
      throw error;
    }

    const diagnosticContext = recordLocationUpdateReceived(req, payload);

    try {
      const location = locationsService.updateLocation(payload);

      // Persist to Redis for cross-process sharing in the background.
      // The driver update response must not wait on Redis availability.
      void setLiveBusLocation(payload.busId, location).catch((err) =>
        console.error("[tracking] Redis setLiveBusLocation error:", err),
      );

      recordLocationUpdateSuccess(
        payload,
        location,
        diagnosticContext,
        Date.now() - startMs,
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
          routeTotalDistanceMeters: location.routeTotalDistanceMeters,
          progressRemainingMeters: location.progressRemainingMeters,
          progressRatio: location.progressRatio,
          progressPercent: location.progressPercent,
          snappedLatitude: location.snappedLatitude,
          snappedLongitude: location.snappedLongitude,
          distanceFromRouteMeters: location.distanceFromRouteMeters,
          avgSpeedMps: location.avgSpeedMps,
          directionConfidence: location.directionConfidence,
          etaConfidence: location.etaConfidence,
          tripPhase: location.tripPhase,
        },
        201,
      );
    } catch (error) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      recordLocationUpdateServerError(req, error, statusCode);
      throw error;
    }
  }),
);

// GET /buses/live
trackingRouter.get(
  "/buses/live",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const includeStale = parseIncludeStale(req.query.includeStale);
    const buses = await locationsService.getLiveBuses(includeStale);
    sendSuccess(res, { buses });
  }),
);

// GET /routes/:routeId/live
trackingRouter.get(
  "/routes/:routeId/live",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const includeStale = parseIncludeStale(req.query.includeStale);
    const allBuses = await locationsService.getLiveBuses(includeStale);
    const buses = allBuses.filter((b) => {
      return b.routeId === req.params.routeId || b.routeVariantId === req.params.routeId;
    });
    sendSuccess(res, { routeId: req.params.routeId, buses });
  }),
);
