import { Router } from "express";
import { query, getClient } from "../db";
import { authMiddleware, userAccountMiddleware, adminMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { record, text, uuid, choice, coordinate, page } from "./validation";
import { transferGuestData } from "./guestTransfer";
import { currentLine } from "../tenancy/context";

export const passengerRouter = Router();
const account = [authMiddleware, userAccountMiddleware];

passengerRouter.post(
  "/users/me/guest-data",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    await transferGuestData(req.user!.sub, text(record(req.body).guest_token, "guest_token", 4096));
    res.json({ transferred: true });
  }),
);

passengerRouter.get(
  "/alerts",
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { limit, offset } = page(req.query);
    const routeId = req.query.routeId === undefined ? null : uuid(req.query.routeId);
    const stopId = req.query.stopId === undefined ? null : uuid(req.query.stopId);
    const category =
      req.query.category === undefined
        ? null
        : choice(req.query.category, ["routes", "stops", "service", "news"], "category");
    const language = req.query.language === "en" ? "en" : "es";
    const result = await query(
      `SELECT id,route_id,stop_id,category,severity,
    CASE WHEN $1='en' THEN COALESCE(title_en,title_es) ELSE title_es END AS title,
    CASE WHEN $1='en' THEN COALESCE(description_en,description_es) ELSE description_es END AS description,
    created_at,expires_at FROM alerts WHERE (transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=alerts.transport_line_id AND l.active)) AND published AND starts_at<=NOW() AND expires_at>NOW()
    AND ($2::uuid IS NULL OR route_id=$2) AND ($3::uuid IS NULL OR stop_id=$3)
    AND ($4::text IS NULL OR category=$4) ORDER BY created_at DESC,id LIMIT $5 OFFSET $6`,
      [language, routeId, stopId, category, limit, offset],
    );
    res.json({ alerts: result.rows, limit, offset });
  }),
);

passengerRouter.post(
  "/alerts",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = record(req.body);
    const expires = new Date(text(b.expires_at, "expires_at"));
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())
      throw new AppError("Expiration must be in the future.", 400);
    if (b.published !== undefined && typeof b.published !== "boolean")
      throw new AppError("published must be boolean.", 400);
    if (currentLine() && b.route_id != null) {
      const route = await query("SELECT id FROM routes WHERE id=$1 AND active AND visible_in_app", [uuid(b.route_id)]);
      if (!route.rows.length) throw new AppError("Selecciona una ruta publicada de esta línea.", 400);
    }
    const result = await query(
      `INSERT INTO alerts(route_id,stop_id,category,severity,title_es,description_es,title_en,description_en,published,expires_at,published_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9 THEN NOW() ELSE NULL END) RETURNING *`,
      [
        b.route_id == null ? null : uuid(b.route_id),
        b.stop_id == null ? null : uuid(b.stop_id),
        choice(b.category, ["routes", "stops", "service", "news"], "category"),
        choice(b.severity, ["info", "warning", "critical"], "severity"),
        text(b.title_es, "title_es"),
        text(b.description_es, "description_es", 4000),
        b.title_en == null ? null : text(b.title_en, "title_en"),
        b.description_en == null ? null : text(b.description_en, "description_en", 4000),
        b.published ?? false,
        expires.toISOString(),
      ],
    );
    res.status(201).json({ alert: result.rows[0] });
  }),
);
passengerRouter.patch(
  "/alerts/:id",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = record(req.body);
    if (typeof b.published !== "boolean") throw new AppError("published must be boolean.", 400);
    const result = await query(
      "UPDATE alerts SET published_at=CASE WHEN $1 AND NOT published THEN NOW() ELSE published_at END,published=$1 WHERE id=$2 RETURNING *",
      [b.published, uuid(req.params.id)],
    );
    if (!result.rows.length) throw new AppError("Alert not found.", 404);
    res.json({ alert: result.rows[0] });
  }),
);

passengerRouter.get(
  "/saved-journeys",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const { limit, offset } = page(req.query);
    res.json({
      favorites: (
        await query(
          "SELECT * FROM saved_journeys WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
          [req.user!.sub, limit, offset],
        )
      ).rows,
      limit,
      offset,
    });
  }),
);
passengerRouter.post(
  "/saved-journeys",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const b = record(req.body),
      routeId = uuid(b.route_id),
      variantId = b.variant_id == null ? null : uuid(b.variant_id);
    if (
      variantId &&
      !(
        await query("SELECT id FROM route_variants WHERE id=$1 AND route_id=$2", [
          variantId,
          routeId,
        ])
      ).rows.length
    )
      throw new AppError("Variant does not belong to route.", 400);
    const hasDestination = b.destination_latitude != null || b.destination_longitude != null;
    const clientId = text(b.client_id, "client_id", 1000);
    const client = await getClient();
    try {
      await client.query("BEGIN");
      const owner = await client.query("SELECT id,is_tester FROM users WHERE id=$1 FOR UPDATE", [req.user!.sub]);
      const existing = await client.query("SELECT * FROM saved_journeys WHERE user_id=$1 AND client_id=$2", [req.user!.sub, clientId]);
      if (existing.rows.length) {
        await client.query("COMMIT");
        res.status(200).json({ favorite: existing.rows[0] });
        return;
      }
      const count = await client.query("SELECT count(*)::int AS total FROM saved_journeys WHERE user_id=$1", [req.user!.sub]);
      if (!owner.rows[0]?.is_tester && count.rows[0].total >= 3) throw new AppError("Puedes guardar hasta 3 rutas favoritas. Quita una antes de agregar otra.", 409, { code: "FAVORITES_LIMIT", limit: 3 });
    const result = await client.query(
      `INSERT INTO saved_journeys(user_id,route_id,variant_id,destination_title,destination_latitude,destination_longitude,client_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,client_id) DO UPDATE SET client_id=EXCLUDED.client_id RETURNING *`,
      [
        req.user!.sub,
        routeId,
        variantId,
        b.destination_title == null ? null : text(b.destination_title, "destination_title"),
        hasDestination ? coordinate(b.destination_latitude, "latitude") : null,
        hasDestination ? coordinate(b.destination_longitude, "longitude") : null,
        clientId,
      ],
    );
      await client.query("COMMIT");
      res.status(201).json({ favorite: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }

  }),
);
passengerRouter.delete(
  "/saved-journeys/:id",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    await query("DELETE FROM saved_journeys WHERE id=$1 AND user_id=$2", [
      uuid(req.params.id),
      req.user!.sub,
    ]);
    res.status(204).end();
  }),
);

passengerRouter.get(
  "/saved-places",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const { limit, offset } = page(req.query);
    res.json({
      places: (
        await query(
          "SELECT * FROM saved_places WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
          [req.user!.sub, limit, offset],
        )
      ).rows,
      limit,
      offset,
    });
  }),
);
passengerRouter.post(
  "/saved-places",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const b = record(req.body);
    const result = await query(
      `INSERT INTO saved_places(user_id,name,kind,latitude,longitude,client_id) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id,client_id) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude RETURNING *`,
      [
        req.user!.sub,
        text(b.name, "name"),
        choice(b.kind, ["home", "work", "custom"], "kind"),
        coordinate(b.latitude, "latitude"),
        coordinate(b.longitude, "longitude"),
        text(b.client_id, "client_id"),
      ],
    );
    res.status(201).json({ place: result.rows[0] });
  }),
);
passengerRouter.delete(
  "/saved-places/:id",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    await query("DELETE FROM saved_places WHERE id=$1 AND user_id=$2", [
      uuid(req.params.id),
      req.user!.sub,
    ]);
    res.status(204).end();
  }),
);

passengerRouter.post(
  "/support/tickets",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const b = record(req.body);
    const result = await query(
      `INSERT INTO support_tickets(user_id,message,client_id) VALUES($1,$2,$3)
    ON CONFLICT(user_id,client_id) DO UPDATE SET client_id=EXCLUDED.client_id RETURNING id,status,created_at`,
      [req.user!.sub, text(b.message, "message", 4000), text(b.client_id, "client_id")],
    );
    res.status(201).json({ ticket: result.rows[0] });
  }),
);

passengerRouter.get(
  "/trips",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const { limit, offset } = page(req.query);
    const status =
      req.query.status === undefined
        ? null
        : choice(req.query.status, ["active", "completed", "cancelled"], "status");
    res.json({
      trips: (
        await query(
          "SELECT * FROM passenger_trips WHERE user_id=$1 AND ($4::text IS NULL OR status=$4) ORDER BY started_at DESC,id LIMIT $2 OFFSET $3",
          [req.user!.sub, limit, offset, status],
        )
      ).rows,
      limit,
      offset,
    });
  }),
);
passengerRouter.post(
  "/trips",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const b = record(req.body),
      routeId = uuid(b.route_id),
      variantId = b.variant_id == null ? null : uuid(b.variant_id);
    if (
      variantId &&
      !(
        await query("SELECT id FROM route_variants WHERE id=$1 AND route_id=$2", [
          variantId,
          routeId,
        ])
      ).rows.length
    )
      throw new AppError("Variant does not belong to route.", 400);
    const clientId = text(b.client_id, "client_id"),
      busId = b.bus_id == null ? null : text(b.bus_id, "bus_id"),
      client = await getClient();
    try {
      await client.query("BEGIN");
      const owner = await client.query(
        "SELECT id FROM users WHERE id=$1 AND status='active' FOR UPDATE",
        [req.user!.sub],
      );
      if (!owner.rows.length) throw new AppError("Inactive user.", 401);
      const previous = await client.query(
        "SELECT * FROM passenger_trips WHERE user_id=$1 AND client_id=$2",
        [req.user!.sub, clientId],
      );
      if (previous.rows.length) {
        await client.query("COMMIT");
        res.status(201).json({ trip: previous.rows[0] });
        return;
      }
      const active = await client.query(
        "SELECT id FROM passenger_trips WHERE user_id=$1 AND status='active'",
        [req.user!.sub],
      );
      if (active.rows.length)
        throw new AppError("Complete your current trip before starting another.", 409);
      const result = await client.query(
        "INSERT INTO passenger_trips(user_id,route_id,variant_id,bus_id,client_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [req.user!.sub, routeId, variantId, busId, clientId],
      );
      await client.query("COMMIT");
      res.status(201).json({ trip: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);
passengerRouter.post(
  "/trips/:id/events",
  apiRateLimiter,
  ...account,
  asyncHandler(async (req, res) => {
    const b = record(req.body),
      type = choice(b.type, ["boarding", "alighting", "completed", "cancelled"], "type");
    const id = uuid(req.params.id),
      clientId = text(b.client_id, "client_id"),
      client = await getClient();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        "SELECT id,status FROM passenger_trips WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [id, req.user!.sub],
      );
      if (!owned.rows.length) throw new AppError("Trip not found.", 404);
      const previous = await client.query(
        "SELECT type FROM passenger_trip_events WHERE trip_id=$1 AND client_id=$2",
        [id, clientId],
      );
      if (previous.rows.length && previous.rows[0].type !== type)
        throw new AppError("Idempotency key already used.", 409);
      if (!previous.rows.length) {
        if (owned.rows[0].status !== "active") throw new AppError("Trip is already closed.", 409);
        await client.query(
          "INSERT INTO passenger_trip_events(trip_id,type,client_id) VALUES($1,$2,$3)",
          [id, type, clientId],
        );
        if (type === "completed" || type === "cancelled")
          await client.query("UPDATE passenger_trips SET status=$1,ended_at=NOW() WHERE id=$2", [
            type,
            id,
          ]);
      }
      await client.query("COMMIT");
      res.status(201).json({ accepted: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);
