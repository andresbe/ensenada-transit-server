import { Request, Response } from "express";
import { sendSuccess } from "../../shared/response";
import { locationsService } from "../locations/locations.service";
import { parseIncludeStale, validateEtaQuery } from "../locations/locations.validation";

export const getLiveBusesByRouteVariant = async (req: Request, res: Response) => {
  const { routeVariantId } = req.params;
  const includeStale = parseIncludeStale(req.query.includeStale);
  const buses = await locationsService.getLiveBusesByRouteVariant(
    routeVariantId,
    includeStale,
  );

  sendSuccess(res, {
    routeVariantId,
    buses,
  });
};

export const getRouteEta = async (req: Request, res: Response) => {
  const { routeVariantId } = req.params;
  const query = validateEtaQuery(req.query);
  const eta = await locationsService.getEtaForRouteVariant(
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

  sendSuccess(res, eta);
};
