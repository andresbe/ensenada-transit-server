import { Request, Response, Router } from "express";
import { authMiddleware, driverMiddleware } from "../auth/auth.middleware";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";
import { DriverSession } from "../types";

export const driverSessionsRouter = Router();

// All driver session routes require driver or admin role
driverSessionsRouter.use(authMiddleware, driverMiddleware);

// POST /driver-sessions/start
driverSessionsRouter.post(
  "/start",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);

    const body = req.body as {
      bus_id?: unknown;
      route_id?: unknown;
      variant_id?: unknown;
    };

    if (typeof body.bus_id !== "string" || body.bus_id.trim() === "") {
      throw new AppError("bus_id is required.", 400);
    }

    // End any existing active session for this driver
    await query(
      `UPDATE driver_sessions SET status = 'ended', ended_at = NOW()
       WHERE driver_id = $1 AND status = 'active'`,
      [req.user.sub],
    );

    const result = await query<DriverSession>(
      `INSERT INTO driver_sessions (driver_id, bus_id, route_id, variant_id, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [
        req.user.sub,
        body.bus_id.trim(),
        typeof body.route_id === "string" ? body.route_id : null,
        typeof body.variant_id === "string" ? body.variant_id : null,
      ],
    );

    sendSuccess(res, { session: result.rows[0] }, 201);
  }),
);

// POST /driver-sessions/:sessionId/end
driverSessionsRouter.post(
  "/:sessionId/end",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);

    const result = await query<DriverSession>(
      `UPDATE driver_sessions
       SET status = 'ended', ended_at = NOW()
       WHERE id = $1 AND driver_id = $2 AND status = 'active'
       RETURNING *`,
      [req.params.sessionId, req.user.sub],
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AppError("Active session not found.", 404);
    }

    sendSuccess(res, { session: result.rows[0] });
  }),
);
