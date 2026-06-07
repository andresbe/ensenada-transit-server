import { Request, Response, Router } from "express";
import { authMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { sendSuccess } from "../shared/response";
import { AppError } from "../shared/errors";
import { getUserById, updatePreferences, updateUser } from "./users.service";

export const usersRouter = Router();

// GET /users/me
usersRouter.get(
  "/me",
  apiRateLimiter,
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const user = await getUserById(req.user.sub);
    sendSuccess(res, { user });
  }),
);

// PATCH /users/me
usersRouter.patch(
  "/me",
  apiRateLimiter,
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const body = req.body as {
      display_name?: unknown;
      photo_url?: unknown;
      preferences?: {
        language?: unknown;
        push_notifications_enabled?: unknown;
        favorite_route_alerts?: unknown;
      };
    };

    const userUpdate = {
      display_name: typeof body.display_name === "string" ? body.display_name : undefined,
      photo_url: typeof body.photo_url === "string" ? body.photo_url : undefined,
    };

    const user = await updateUser(req.user.sub, userUpdate);

    let preferences;
    if (body.preferences && typeof body.preferences === "object") {
      const p = body.preferences;
      preferences = await updatePreferences(req.user.sub, {
        language: typeof p.language === "string" ? p.language : undefined,
        push_notifications_enabled:
          typeof p.push_notifications_enabled === "boolean"
            ? p.push_notifications_enabled
            : undefined,
        favorite_route_alerts:
          typeof p.favorite_route_alerts === "boolean"
            ? p.favorite_route_alerts
            : undefined,
      });
    }

    sendSuccess(res, { user, preferences });
  }),
);
