import { locationsService } from "../modules/locations/locations.service";
import { LocationUpdateRequest } from "../modules/locations/locations.types";
import { routeGeometryService } from "../modules/routes/routeGeometry.service";
import { setLiveBusLocation } from "../redis/cache";
import { AppError } from "../shared/errors";

/** Common route matching, speed, direction, ETA state and cross-process publication. */
export async function ingestLocation(payload: LocationUpdateRequest) {
  await routeGeometryService.ensureRouteGeometry(payload.routeVariantId);
  const location = locationsService.updateLocation({ ...payload, provider: payload.provider ?? "ANDROID" });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const write = setLiveBusLocation(payload.busId, location);
    if (payload.provider === "TELTONIKA") {
      await Promise.race([write, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("publication_timeout")), 5000);
      })]);
    } else await write;
  } catch (error) {
    locationsService.discardUnconfirmedLocation(location);
    throw new AppError("No se pudo compartir la ubicación. Reintentando en breve.", 503);
  } finally { if (timeout) clearTimeout(timeout); }
  return location;
}
