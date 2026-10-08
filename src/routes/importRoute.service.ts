import { getClient } from "../db";
import { invalidateRoutesCache } from "../redis/cache";
import { AppError } from "../shared/errors";
import { Route, RouteVariant } from "../types";
import { object, parseRouteGeoJson, requiredText } from "./geojson";

export const importRoute = async (input: unknown) => {
  const body = object(input);
  const name = requiredText(body.name, "name");
  const shortName = requiredText(body.short_name, "short_name");
  const color = (value: unknown, fallback: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new AppError("Colors must use #RRGGBB.", 400);
    return value;
  };
  const routeColor = color(body.color, "#000000");
  const textColor = color(body.text_color, "#FFFFFF");
  if (!Array.isArray(body.variants) || body.variants.length < 1 || body.variants.length > 2) {
    throw new AppError("variants must contain one or two entries (ida and/or vuelta).", 400);
  }
  if (body.visible_in_app !== undefined && typeof body.visible_in_app !== "boolean") throw new AppError("visible_in_app must be boolean.", 400);
  const directions = new Set<string>();
  const variants = body.variants.map((raw) => {
    const v = object(raw);
    if (v.direction !== "ida" && v.direction !== "vuelta") throw new AppError("direction must be ida or vuelta.", 400);
    if (directions.has(v.direction)) throw new AppError("Duplicate variant direction.", 400);
    directions.add(v.direction);
    return {
      name: v.name === undefined ? `${name} ${v.direction}` : requiredText(v.name, "variant.name"),
      direction: v.direction,
      ...parseRouteGeoJson(v.geojson),
      stops: parseStops(v.stops),
    };
  });

  const client = await getClient();
  let route: Route;
  const saved: RouteVariant[] = [];
  try {
    await client.query("BEGIN");
    const result = await client.query<Route>(
      "INSERT INTO routes (name, short_name, color, text_color, visible_in_app) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [name, shortName, routeColor, textColor, body.visible_in_app ?? false],
    );
    route = result.rows[0];
    for (const variant of variants) {
      const result = await client.query<RouteVariant>(
        `INSERT INTO route_variants (route_id, name, direction, coordinates, total_distance_meters)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [route.id, variant.name, variant.direction, JSON.stringify(variant.coordinates), variant.distance],
      );
      const savedVariant = result.rows[0];
      for (const [sequence, stop] of variant.stops.entries()) {
        await client.query(
          "INSERT INTO stops (route_id, variant_id, name, longitude, latitude, sequence) VALUES ($1,$2,$3,$4,$5,$6)",
          [route.id, savedVariant.id, stop.name, stop.longitude, stop.latitude, sequence],
        );
      }
      saved.push(savedVariant);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await invalidateRoutesCache();
  return { ...route, variants: saved };
};

function parseStops(raw: unknown) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 500) throw new AppError("Maximum 500 stops per variant.", 400);
  return raw.map((value) => {
    const stop = object(value);
    const name = requiredText(stop.name, "stop.name");
    const longitude = stop.longitude, latitude = stop.latitude;
    if (typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
        typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
      throw new AppError("Invalid stop coordinates.", 400);
    }
    return { name, longitude, latitude };
  });
}
