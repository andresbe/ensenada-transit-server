import { Request, Response, Router } from "express";
import { authMiddleware, adminMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { sendSuccess } from "../shared/response";
import { AppError } from "../shared/errors";
import {
  createRoute,
  createVariant,
  getAllRoutes,
  getRouteById,
  getVariant,
} from "./routes.service";

export const dbRoutesRouter = Router();

// GET /routes
dbRoutesRouter.get(
  "/",
  apiRateLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const routes = await getAllRoutes();
    sendSuccess(res, { routes });
  }),
);

// GET /routes/:routeId
dbRoutesRouter.get(
  "/:routeId",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const route = await getRouteById(req.params.routeId);
    sendSuccess(res, { route });
  }),
);

// GET /routes/:routeId/variants/:variantId
dbRoutesRouter.get(
  "/:routeId/variants/:variantId",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const variant = await getVariant(req.params.routeId, req.params.variantId);
    sendSuccess(res, { variant });
  }),
);

// POST /routes  (admin only)
dbRoutesRouter.post(
  "/",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      name?: unknown;
      short_name?: unknown;
      color?: unknown;
      text_color?: unknown;
    };

    if (typeof body.name !== "string" || body.name.trim() === "") {
      throw new AppError("name is required.", 400);
    }
    if (typeof body.short_name !== "string" || body.short_name.trim() === "") {
      throw new AppError("short_name is required.", 400);
    }

    const route = await createRoute({
      name: body.name.trim(),
      short_name: body.short_name.trim(),
      color: typeof body.color === "string" ? body.color : undefined,
      text_color: typeof body.text_color === "string" ? body.text_color : undefined,
    });

    sendSuccess(res, { route }, 201);
  }),
);

// POST /routes/:routeId/variants  (admin only)
dbRoutesRouter.post(
  "/:routeId/variants",
  apiRateLimiter,
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      name?: unknown;
      direction?: unknown;
      coordinates?: unknown;
      total_distance_meters?: unknown;
    };

    if (typeof body.name !== "string" || body.name.trim() === "") {
      throw new AppError("name is required.", 400);
    }
    if (body.direction !== "ida" && body.direction !== "vuelta") {
      throw new AppError("direction must be 'ida' or 'vuelta'.", 400);
    }

    const variant = await createVariant(req.params.routeId, {
      name: body.name.trim(),
      direction: body.direction,
      coordinates: Array.isArray(body.coordinates)
        ? (body.coordinates as [number, number][])
        : undefined,
      total_distance_meters:
        typeof body.total_distance_meters === "number"
          ? body.total_distance_meters
          : undefined,
    });

    sendSuccess(res, { variant }, 201);
  }),
);
