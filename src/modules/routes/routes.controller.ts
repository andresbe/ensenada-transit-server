import { Request, Response } from "express";
import { sendSuccess } from "../../shared/response";
import { locationsService } from "../locations/locations.service";
import { parseIncludeStale, validateEtaQuery } from "../locations/locations.validation";

export const getLiveBusesByRouteVariant = (req: Request, res: Response) => {
  const { routeVariantId } = req.params;
  const includeStale = parseIncludeStale(req.query.includeStale);
  const buses = locationsService.getLiveBusesByRouteVariant(routeVariantId, includeStale);

  return sendSuccess(res, {
    routeVariantId,
    buses,
  });
};

export const getRouteEta = (req: Request, res: Response) => {
  const { routeVariantId } = req.params;
  const query = validateEtaQuery(req.query);
  const eta = locationsService.getEtaForRouteVariant(
    routeVariantId,
    {
      latitude: query.userLat,
      longitude: query.userLng,
    },
    query.destLat === undefined || query.destLng === undefined
      ? undefined
      : {
          latitude: query.destLat,
          longitude: query.destLng,
        },
    query.includeStale,
  );

  return sendSuccess(res, eta);
};
