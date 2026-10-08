import { query as dbQuery } from "../../db";
import { AppError } from "../../shared/errors";
import { publicBuses } from "../../tracking/publicBuses";
import { canonicalVariantId } from "../../passengers/identity";
import { Request, Response } from "express";
import { sendSuccess } from "../../shared/response";
import { locationsService } from "../locations/locations.service";
import { parseIncludeStale, validateEtaQuery } from "../locations/locations.validation";

export const getLiveBusesByRouteVariant = async (req: Request, res: Response) => {
  const routeVariantId = await canonicalVariantId(req.params.routeVariantId);
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
  const routeVariantId = await canonicalVariantId(req.params.routeVariantId);
  const visible=await dbQuery("SELECT v.id FROM route_variants v JOIN routes r ON r.id=v.route_id WHERE v.id::text=$1 AND r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=r.transport_line_id AND l.active))",[routeVariantId]);
  if (!visible.rows.length) throw new AppError("Route not found.",404);
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

  sendSuccess(res, { ...eta, buses: await publicBuses(eta.buses) });
};
