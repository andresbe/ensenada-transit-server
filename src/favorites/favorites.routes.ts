import { Request, Response, Router } from "express";
import { authMiddleware } from "../auth/auth.middleware";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";

export const favoritesRouter = Router();

// All favorites routes require authentication
favoritesRouter.use(authMiddleware);

// ── Favorite routes ───────────────────────────────────────────

// GET /favorites/routes
favoritesRouter.get(
  "/routes",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const result = await query(
      `SELECT r.id, r.name, r.short_name, r.color, r.text_color, r.active, fr.created_at AS favorited_at
       FROM favorite_routes fr
       JOIN routes r ON r.id = fr.route_id
       WHERE fr.user_id = $1
       ORDER BY fr.created_at DESC`,
      [req.user.sub],
    );
    sendSuccess(res, { routes: result.rows });
  }),
);

// POST /favorites/routes
favoritesRouter.post(
  "/routes",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const body = req.body as { route_id?: unknown };
    if (typeof body.route_id !== "string" || body.route_id.trim() === "") {
      throw new AppError("route_id is required.", 400);
    }
    await query(
      `INSERT INTO favorite_routes (user_id, route_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.sub, body.route_id],
    );
    sendSuccess(res, { message: "Route added to favorites." }, 201);
  }),
);

// DELETE /favorites/routes/:routeId
favoritesRouter.delete(
  "/routes/:routeId",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    await query(
      `DELETE FROM favorite_routes WHERE user_id = $1 AND route_id = $2`,
      [req.user.sub, req.params.routeId],
    );
    sendSuccess(res, { message: "Route removed from favorites." });
  }),
);

// ── Favorite stops ────────────────────────────────────────────

// GET /favorites/stops
favoritesRouter.get(
  "/stops",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const result = await query(
      `SELECT s.id, s.name, s.latitude, s.longitude, s.sequence, s.route_id, s.variant_id,
              fs.created_at AS favorited_at
       FROM favorite_stops fs
       JOIN stops s ON s.id = fs.stop_id
       WHERE fs.user_id = $1
       ORDER BY fs.created_at DESC`,
      [req.user.sub],
    );
    sendSuccess(res, { stops: result.rows });
  }),
);

// POST /favorites/stops
favoritesRouter.post(
  "/stops",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const body = req.body as { stop_id?: unknown };
    if (typeof body.stop_id !== "string" || body.stop_id.trim() === "") {
      throw new AppError("stop_id is required.", 400);
    }
    await query(
      `INSERT INTO favorite_stops (user_id, stop_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.sub, body.stop_id],
    );
    sendSuccess(res, { message: "Stop added to favorites." }, 201);
  }),
);

// DELETE /favorites/stops/:stopId
favoritesRouter.delete(
  "/stops/:stopId",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    await query(
      `DELETE FROM favorite_stops WHERE user_id = $1 AND stop_id = $2`,
      [req.user.sub, req.params.stopId],
    );
    sendSuccess(res, { message: "Stop removed from favorites." });
  }),
);
