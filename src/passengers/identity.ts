import { query } from "../db";
import { AppError } from "../shared/errors";

const isUuid = (value: string) => /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export async function canonicalRouteId(id: string) {
  if (isUuid(id)) return id;
  const result=await query("SELECT route_id FROM route_legacy_aliases WHERE legacy_id=$1",[id]);
  return result.rows[0]?.route_id as string | undefined ?? id;
}
export async function canonicalVariantId(id: string) {
  if (isUuid(id)) return id;
  const result=await query("SELECT variant_id FROM variant_legacy_aliases WHERE legacy_id=$1",[id]);
  return result.rows[0]?.variant_id as string | undefined ?? id;
}
export async function canonicalTrackingIds(routeId: string, variantId: string) {
  const variant=await canonicalVariantId(variantId);
  const route=await canonicalRouteId(routeId);
  if (isUuid(variant)) {
    const result=await query("SELECT route_id,direction FROM route_variants WHERE id=$1",[variant]);
    if(!result.rows.length || result.rows[0].route_id!==route)throw new AppError("Variant does not belong to route.",400);
    return {routeId:route,routeVariantId:variant,routeVariantDirection:result.rows[0].direction as "ida"|"vuelta"};
  }
  return {routeId:route,routeVariantId:variant};
}
