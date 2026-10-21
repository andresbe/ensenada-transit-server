import { saveJourney } from "../passengers/savedJourneys.service";
import { visibleRouteSql } from "../passengers/visibility";
import { uuid, record } from "../passengers/validation";
import { Request, Response, Router } from "express";
import { authMiddleware, userAccountMiddleware } from "../auth/auth.middleware";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";

export const favoritesRouter = Router();

// All favorites routes require authentication
favoritesRouter.use(authMiddleware, userAccountMiddleware);

// ── Favorite routes ───────────────────────────────────────────

// GET /favorites/routes
favoritesRouter.get(
  "/routes",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const result = await query(
      `SELECT DISTINCT ON (r.id) r.id, r.name, r.short_name, r.color, r.text_color, r.active, fr.created_at AS favorited_at
       FROM saved_journeys fr
       JOIN routes r ON r.id = fr.route_id
       WHERE fr.user_id = $1 AND ${visibleRouteSql("r")}
       ORDER BY r.id, fr.created_at DESC`,
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
    const routeId=uuid(record(req.body).route_id);
    await saveJourney(req.user!.sub,{route_id:routeId,client_id:"legacy-route:"+routeId},true);
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
      `DELETE FROM saved_journeys WHERE user_id = $1 AND route_id = $2`,
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
       JOIN stops s ON s.id = fs.stop_id JOIN routes r ON r.id=s.route_id
       WHERE fs.user_id = $1 AND ${visibleRouteSql("r")}
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
    const result = await query(
      `INSERT INTO favorite_stops (user_id, stop_id) SELECT $1,s.id FROM stops s JOIN routes r ON r.id=s.route_id WHERE s.id=$2 AND ${visibleRouteSql("r")} ON CONFLICT(user_id,stop_id) DO UPDATE SET stop_id=EXCLUDED.stop_id RETURNING stop_id`,
      [req.user.sub, body.stop_id],
    );
    if (!result.rows.length) throw new AppError("Stop not found.",404);
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
