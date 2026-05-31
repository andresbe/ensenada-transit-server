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
      snappedLatitude: location.snappedLatitude,
      snappedLongitude: location.snappedLongitude,
      distanceFromRouteMeters: location.distanceFromRouteMeters,
      avgSpeedMps: location.avgSpeedMps,
      directionConfidence: location.directionConfidence,
      etaConfidence: location.etaConfidence,
    },
    201,
  );
};

export const getAllLiveBuses = (req: Request, res: Response) => {
  const includeStale = parseIncludeStale(req.query.includeStale);
  const buses = locationsService.getLiveBuses(includeStale);

  return sendSuccess(res, { buses });
};
