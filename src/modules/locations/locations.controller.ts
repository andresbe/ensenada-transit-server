import { Request, Response } from "express";
import { sendSuccess } from "../../shared/response";
import { locationsService } from "./locations.service";
import { parseIncludeStale, validateLocationUpdate } from "./locations.validation";

export const updateLocation = (req: Request, res: Response) => {
  const payload = validateLocationUpdate(req.body);
  const location = locationsService.updateLocation(payload);

  return sendSuccess(
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
};

export const getAllLiveBuses = async (req: Request, res: Response) => {
  const includeStale = parseIncludeStale(req.query.includeStale);
  const buses = await locationsService.getLiveBuses(includeStale);

  sendSuccess(res, { buses });
};
