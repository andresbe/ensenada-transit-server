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
      updatedAt: location.updatedAt,
    },
    201,
  );
};

export const getAllLiveBuses = (req: Request, res: Response) => {
  const includeStale = parseIncludeStale(req.query.includeStale);
  const buses = locationsService.getLiveBuses(includeStale);

  return sendSuccess(res, { buses });
};
