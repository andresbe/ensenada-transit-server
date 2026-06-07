import { query } from "../db";
import {
  getCachedRoute,
  getCachedRoutes,
  getCachedVariant,
  setCachedRoute,
  setCachedRoutes,
  setCachedVariant,
} from "../redis/cache";
import { AppError } from "../shared/errors";
import { Route, RouteVariant, Stop } from "../types";

// ── Get all routes ────────────────────────────────────────────

export const getAllRoutes = async (): Promise<Route[]> => {
  const cached = await getCachedRoutes<Route[]>();
  if (cached) return cached;

  const result = await query<Route>(
    `SELECT id, name, short_name, color, text_color, active, created_at, updated_at
     FROM routes WHERE active = TRUE ORDER BY name`,
  );

  await setCachedRoutes(result.rows);
  return result.rows;
};

// ── Get route by id (with variants) ──────────────────────────

export interface RouteWithVariants extends Route {
  variants: RouteVariant[];
}

export const getRouteById = async (routeId: string): Promise<RouteWithVariants> => {
  const cached = await getCachedRoute<RouteWithVariants>(routeId);
  if (cached) return cached;

  const routeResult = await query<Route>(
    `SELECT id, name, short_name, color, text_color, active, created_at, updated_at
     FROM routes WHERE id = $1`,
    [routeId],
  );

  if (!routeResult.rowCount || routeResult.rowCount === 0) {
    throw new AppError("Route not found.", 404);
  }

  const variantsResult = await query<RouteVariant>(
    `SELECT id, route_id, name, direction, coordinates, total_distance_meters, created_at, updated_at
     FROM route_variants WHERE route_id = $1 ORDER BY direction`,
    [routeId],
  );

  const data: RouteWithVariants = {
    ...routeResult.rows[0],
    variants: variantsResult.rows,
  };

  await setCachedRoute(routeId, data);
  return data;
};

// ── Get variant (with stops) ──────────────────────────────────

export interface VariantWithStops extends RouteVariant {
  stops: Stop[];
}

export const getVariant = async (
  routeId: string,
  variantId: string,
): Promise<VariantWithStops> => {
  const cached = await getCachedVariant<VariantWithStops>(variantId);
  if (cached) return cached;

  const variantResult = await query<RouteVariant>(
    `SELECT id, route_id, name, direction, coordinates, total_distance_meters, created_at, updated_at
     FROM route_variants WHERE id = $1 AND route_id = $2`,
    [variantId, routeId],
  );

  if (!variantResult.rowCount || variantResult.rowCount === 0) {
    throw new AppError("Route variant not found.", 404);
  }

  const stopsResult = await query<Stop>(
    `SELECT id, route_id, variant_id, name, latitude, longitude, sequence, created_at, updated_at
     FROM stops WHERE variant_id = $1 ORDER BY sequence`,
    [variantId],
  );

  const data: VariantWithStops = {
    ...variantResult.rows[0],
    stops: stopsResult.rows,
  };

  await setCachedVariant(variantId, data);
  return data;
};

// ── Create route (admin) ──────────────────────────────────────

export interface CreateRouteInput {
  name: string;
  short_name: string;
  color?: string;
  text_color?: string;
}

export const createRoute = async (input: CreateRouteInput): Promise<Route> => {
  const result = await query<Route>(
    `INSERT INTO routes (name, short_name, color, text_color)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, short_name, color, text_color, active, created_at, updated_at`,
    [
      input.name,
      input.short_name,
      input.color ?? "#000000",
      input.text_color ?? "#FFFFFF",
    ],
  );
  return result.rows[0];
};

// ── Create variant (admin) ────────────────────────────────────

export interface CreateVariantInput {
  name: string;
  direction: "ida" | "vuelta";
  coordinates?: [number, number][];
  total_distance_meters?: number;
}

export const createVariant = async (
  routeId: string,
  input: CreateVariantInput,
): Promise<RouteVariant> => {
  // Verify route exists
  const routeCheck = await query<{ id: string }>(
    `SELECT id FROM routes WHERE id = $1`,
    [routeId],
  );
  if (!routeCheck.rowCount || routeCheck.rowCount === 0) {
    throw new AppError("Route not found.", 404);
  }

  const result = await query<RouteVariant>(
    `INSERT INTO route_variants (route_id, name, direction, coordinates, total_distance_meters)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, route_id, name, direction, coordinates, total_distance_meters, created_at, updated_at`,
    [
      routeId,
      input.name,
      input.direction,
      JSON.stringify(input.coordinates ?? []),
      input.total_distance_meters ?? 0,
    ],
  );
  return result.rows[0];
};
