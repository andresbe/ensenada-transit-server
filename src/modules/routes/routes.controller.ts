import { Request, Response } from "express";
import { sendSuccess } from "../../shared/response";
import { locationsService } from "../locations/locations.service";
import { parseIncludeStale } from "../locations/locations.validation";

export const getLiveBusesByRouteVariant = (req: Request, res: Response) => {
  const { routeVariantId } = req.params;
  const includeStale = parseIncludeStale(req.query.includeStale);
  const buses = locationsService.getLiveBusesByRouteVariant(routeVariantId, includeStale);

  return sendSuccess(res, {
    routeVariantId,
    buses,
  });
};
