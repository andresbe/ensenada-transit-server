import { Request, Response, Router } from "express";
import { authMiddleware } from "../auth/auth.middleware";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";
import { ReportType, UserReport } from "../types";

export const reportsRouter = Router();

const VALID_REPORT_TYPES: ReportType[] = ["crowded", "breakdown", "delay", "other"];

// All reports routes require authentication
reportsRouter.use(authMiddleware);

// POST /reports
reportsRouter.post(
  "/",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);

    const body = req.body as {
      type?: unknown;
      route_id?: unknown;
      variant_id?: unknown;
      bus_id?: unknown;
      message?: unknown;
      latitude?: unknown;
      longitude?: unknown;
    };

    if (!VALID_REPORT_TYPES.includes(body.type as ReportType)) {
      throw new AppError(
        `type must be one of: ${VALID_REPORT_TYPES.join(", ")}.`,
        400,
      );
    }

    const result = await query<UserReport>(
      `INSERT INTO user_reports (user_id, type, route_id, variant_id, bus_id, message, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.user.sub,
        body.type,
        typeof body.route_id === "string" ? body.route_id : null,
        typeof body.variant_id === "string" ? body.variant_id : null,
        typeof body.bus_id === "string" ? body.bus_id : null,
        typeof body.message === "string" ? body.message : null,
        typeof body.latitude === "number" ? body.latitude : null,
        typeof body.longitude === "number" ? body.longitude : null,
      ],
    );

    sendSuccess(res, { report: result.rows[0] }, 201);
  }),
);

// GET /reports/my
reportsRouter.get(
  "/my",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);

    const result = await query<UserReport>(
      `SELECT * FROM user_reports WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.sub],
    );

    sendSuccess(res, { reports: result.rows });
  }),
);
