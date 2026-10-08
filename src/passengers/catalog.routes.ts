import { currentLine } from "../tenancy/context";
import { locationsService } from "../modules/locations/locations.service";
import { Router } from "express";
import { query, getClient } from "../db";
import { authMiddleware, adminMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { record, text, uuid, coordinate } from "./validation";
import { invalidateRoutesCache, invalidateRouteCache, invalidateVariantCache } from "../redis/cache";

export const catalogRouter = Router();

catalogRouter.post(
  "/physical-stops",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = record(req.body);
    const result = await query(
      "INSERT INTO physical_stops(name,latitude,longitude) VALUES($1,$2,$3) RETURNING *",
      [
        text(b.name, "name"),
        coordinate(b.latitude, "latitude"),
        coordinate(b.longitude, "longitude"),
      ],
    );
    res.status(201).json({ stop: result.rows[0] });
  }),
);

catalogRouter.post(
  "/catalog/aliases",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = record(req.body),
      legacy = text(b.legacy_id, "legacy_id", 100);
    if (b.kind !== "route" && b.kind !== "variant")
      throw new AppError("kind must be route or variant.", 400);
    const table = b.kind === "route" ? "route_legacy_aliases" : "variant_legacy_aliases";
    const column = b.kind === "route" ? "route_id" : "variant_id";
    const result = await query(
      `INSERT INTO ${table}(legacy_id,${column}) VALUES($1,$2)
    ON CONFLICT(legacy_id) DO UPDATE SET ${column}=EXCLUDED.${column} RETURNING *`,
      [legacy, uuid(b.id)],
    );
    await invalidateRoutesCache();
    res.status(201).json({ alias: result.rows[0] });
  }),
);

catalogRouter.get(
  "/transport-lines/stats",
  apiRateLimiter,
  asyncHandler(async (_req, res) => {
    const [live, result] = await Promise.all([
      locationsService.getLiveBuses(false),
      query("SELECT r.id,r.transport_line_id FROM routes r WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines tl WHERE tl.id=r.transport_line_id AND tl.active))"),
    ]);
    const counts = new Map<string, number>();
    for (const bus of live) {
      const line = result.rows.find((r) => r.id === bus.routeId)?.transport_line_id;
      if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    res.json({
      lines: Array.from(new Set(result.rows.map((r) => r.transport_line_id).filter(Boolean))).map(
        (id) => ({ id, active_buses: counts.get(id) ?? 0, occupancy: null }),
      ),
      updated_at: new Date().toISOString(),
    });
  }),
);

// Atomic snapshot avoids N+1 requests and partial catalogs during updates.
catalogRouter.get(
  "/catalog",
  apiRateLimiter,
  asyncHandler(async (_req, res) => {
    const result = await query(`SELECT
    COALESCE((SELECT jsonb_agg(r ORDER BY r.display_order,r.name) FROM routes r WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines tl WHERE tl.id=r.transport_line_id AND tl.active))),'[]') AS routes,
    COALESCE((SELECT jsonb_agg(v) FROM route_variants v JOIN routes r ON r.id=v.route_id WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines tl WHERE tl.id=r.transport_line_id AND tl.active))),'[]') AS variants,
    COALESCE((SELECT jsonb_agg(s ORDER BY s.sequence) FROM stops s JOIN routes r ON r.id=s.route_id WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines tl WHERE tl.id=r.transport_line_id AND tl.active))),'[]') AS stops,
    COALESCE((SELECT jsonb_agg(l ORDER BY l.display_order,l.name) FROM transport_lines l WHERE l.active),'[]') AS lines,
    COALESCE((SELECT jsonb_object_agg(legacy_id,route_id) FROM route_legacy_aliases a JOIN routes r ON r.id=a.route_id WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines tl WHERE tl.id=r.transport_line_id AND tl.active))),'{}') AS route_aliases,
    COALESCE((SELECT jsonb_object_agg(legacy_id,variant_id) FROM variant_legacy_aliases a JOIN route_variants v ON v.id=a.variant_id JOIN routes r ON r.id=v.route_id WHERE r.active AND r.visible_in_app),'{}') AS variant_aliases`);
    res.json({ ...result.rows[0], schema_version: 1, fetched_at: new Date().toISOString() });
  }),
);

catalogRouter.get(
  "/transport-lines",
  apiRateLimiter,
  asyncHandler(async (_req, res) => {
    res.json({
      lines: (await query("SELECT * FROM transport_lines WHERE active ORDER BY display_order,name"))
        .rows,
    });
  }),
);

catalogRouter.post(
  "/transport-lines",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const body = record(req.body);
    const color = text(body.color ?? "#2563FF", "color", 7);
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new AppError("Invalid color.", 400);
    const result = await query(
      "INSERT INTO transport_lines(name,short_code,color) VALUES($1,$2,$3) RETURNING *",
      [text(body.name, "name"), body.short_code === undefined ? "" : text(body.short_code, "short_code", 12), color],
    );
    res.status(201).json({ line: result.rows[0] });
  }),
);

catalogRouter.patch(
  "/db-routes/:routeId/metadata",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const body = record(req.body);
    const id = uuid(req.params.routeId);
    if (body.visible_in_app === true) {
      const geometry = await query("SELECT v.id FROM route_variants v JOIN routes r ON r.id=v.route_id WHERE r.id=$1 AND r.active AND jsonb_typeof(v.coordinates)='array' AND jsonb_array_length(v.coordinates)>=2 LIMIT 1", [id]);
      if (!geometry.rows.length) throw new AppError("Carga un recorrido antes de publicar.", 400);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    const put = (name: string, value: unknown) => {
      values.push(value);
      fields.push(`${name}=$${values.length}`);
    };
    if (currentLine() && body.transport_line_id !== undefined && body.transport_line_id !== currentLine()!.lineId) throw new AppError("No se puede cambiar la línea de esta ruta.",403);
    if (body.transport_line_id !== undefined)
      put(
        "transport_line_id",
        body.transport_line_id === null ? null : uuid(body.transport_line_id),
      );
    if (body.estimated_cycle_minutes !== undefined) {
      const value = body.estimated_cycle_minutes;
      if (
        value !== null &&
        (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1440)
      )
        throw new AppError("Invalid cycle duration.", 400);
      put("estimated_cycle_minutes", value);
    }
    for (const name of ["active", "visible_in_app"] as const)
      if (body[name] !== undefined) {
        if (typeof body[name] !== "boolean") throw new AppError(`Invalid ${name}.`, 400);
        put(name, body[name]);
      }
    if (body.operating_hours !== undefined) {
      if (body.operating_hours === null) put("operating_hours", null);
      else {
        const hours = record(body.operating_hours);
        const valid = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
        if (!valid(hours.start) || !valid(hours.end))
          throw new AppError("Invalid operating hours.", 400);
        put("operating_hours", JSON.stringify({ start: hours.start, end: hours.end }));
      }
    }
    if (body.service_days !== undefined) {
      if (
        !Array.isArray(body.service_days) ||
        !body.service_days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      )
        throw new AppError("Invalid service days.", 400);
      put("service_days", [...new Set(body.service_days)]);
    }
    if (body.neighborhood_names !== undefined) {
      if (!Array.isArray(body.neighborhood_names) || body.neighborhood_names.length > 100)
        throw new AppError("Invalid neighborhoods.", 400);
      put(
        "neighborhood_names",
        body.neighborhood_names.map((v) => text(v, "neighborhood")),
      );
    }
    if (body.display_order !== undefined) {
      if (!Number.isInteger(body.display_order)) throw new AppError("Invalid display order.", 400);
      put("display_order", body.display_order);
    }
    if (!fields.length) throw new AppError("No supported fields.", 400);
    values.push(id);
    const result = await query(
      `UPDATE routes SET ${fields.join(",")} WHERE id=$${values.length} RETURNING *`,
      values,
    );
    if (!result.rows.length) throw new AppError("Route not found.", 404);
    await Promise.all([invalidateRoutesCache(),invalidateRouteCache(id)]);
    res.json({ route: result.rows[0] });
  }),
);

catalogRouter.post(
  "/db-routes/:routeId/variants/:variantId/stops",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const routeId = uuid(req.params.routeId),
      variantId = uuid(req.params.variantId),
      body = record(req.body);
    if (!Array.isArray(body.stops) || body.stops.length > 500)
      throw new AppError("stops must contain at most 500 entries.", 400);
    const stops = body.stops.map((raw) => {
      const s = record(raw);
      return {
        name: text(s.name, "name"),
        latitude: coordinate(s.latitude, "latitude"),
        longitude: coordinate(s.longitude, "longitude"),
        id: s.id === undefined ? null : uuid(s.id),
        physicalId: s.physical_stop_id === undefined ? null : uuid(s.physical_stop_id),
      };
    });
    const client = await getClient();
    try {
      await client.query("BEGIN");
      if (
        !(
          await client.query(
            "SELECT id FROM route_variants WHERE id=$1 AND route_id=$2 FOR UPDATE",
            [variantId, routeId],
          )
        ).rows.length
      )
        throw new AppError("Variant not found.", 404);
      const saved = [];
      for (let sequence = 0; sequence < stops.length; sequence++) {
        const s = stops[sequence];
        const result = s.id
          ? await client.query(
              "UPDATE stops SET name=$1,latitude=$2,longitude=$3,sequence=$4,physical_stop_id=$5 WHERE id=$6 AND variant_id=$7 RETURNING *",
              [s.name, s.latitude, s.longitude, sequence, s.physicalId, s.id, variantId],
            )
          : await client.query(
              "INSERT INTO stops(route_id,variant_id,name,latitude,longitude,sequence,physical_stop_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
              [routeId, variantId, s.name, s.latitude, s.longitude, sequence, s.physicalId],
            );
        if (!result.rows.length) throw new AppError("Stop does not belong to variant.", 400);
        saved.push(result.rows[0]);
      }
      await client.query("COMMIT");
      await Promise.all([invalidateRoutesCache(),invalidateRouteCache(routeId),invalidateVariantCache(variantId)]);
      res.status(201).json({ stops: saved });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

catalogRouter.get(
  "/stops",
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const lat = coordinate(Number(req.query.lat), "latitude"),
      lng = coordinate(Number(req.query.lng), "longitude");
    const radius = req.query.radius === undefined ? 1000 : Number(req.query.radius);
    if (!Number.isFinite(radius) || radius <= 0 || radius > 25000)
      throw new AppError("radius must be 1-25000 meters.", 400);
    const result = await query(
      `SELECT * FROM (SELECT s.*, 6371000*2*asin(sqrt(LEAST(1,power(sin(radians(latitude::float8-$1)/2),2)+cos(radians($1))*cos(radians(latitude::float8))*power(sin(radians(longitude::float8-$2)/2),2)))) AS distance_meters FROM stops s JOIN routes r ON r.id=s.route_id WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines tl WHERE tl.id=r.transport_line_id AND tl.active))) nearby WHERE distance_meters<=$3 ORDER BY distance_meters LIMIT 100`,
      [lat, lng, radius],
    );
    res.json({ stops: result.rows });
  }),
);

// Public discovery uses boarding stops, never a bus's current location.
catalogRouter.get("/nearby-routes", apiRateLimiter, asyncHandler(async (req, res) => {
  if (typeof req.query.lat !== "string" || !req.query.lat.trim() || typeof req.query.lng !== "string" || !req.query.lng.trim())
    throw new AppError("lat and lng are required.", 400);
  const lat = coordinate(Number(req.query.lat), "latitude");
  const lng = coordinate(Number(req.query.lng), "longitude");
  const radius = req.query.radius === undefined ? 2000 : Number(req.query.radius);
  if (!Number.isFinite(radius) || radius < 1 || radius > 5000) throw new AppError("radius must be 1-5000 meters.", 400);
  const result = await query(`
    WITH distances AS (
      SELECT s.route_id, s.id AS stop_id, s.name AS stop_name,
        6371000*2*asin(sqrt(LEAST(1,power(sin(radians(s.latitude::float8-$1)/2),2)
        +cos(radians($1))*cos(radians(s.latitude::float8))*power(sin(radians(s.longitude::float8-$2)/2),2)))) AS distance_meters
      FROM stops s JOIN routes r ON r.id=s.route_id
      WHERE r.active AND r.visible_in_app AND (r.transport_line_id IS NULL OR EXISTS(
        SELECT 1 FROM transport_lines tl WHERE tl.id=r.transport_line_id AND tl.active))
    ), nearest AS (
      SELECT DISTINCT ON (route_id) * FROM distances WHERE distance_meters <= $3
      ORDER BY route_id, distance_meters, stop_id
    ) SELECT *, CEIL(distance_meters/72)::int AS walking_minutes
      FROM nearest ORDER BY distance_meters, route_id LIMIT 50
  `, [lat, lng, radius]);
  res.json({ routes: result.rows, radius_meters: radius, distance_basis: "straight_line" });
}));
