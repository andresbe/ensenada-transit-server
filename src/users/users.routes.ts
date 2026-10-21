import { Request, Response, Router } from "express";
import { authMiddleware, userAccountMiddleware } from "../auth/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { sendSuccess } from "../shared/response";
import { AppError } from "../shared/errors";
import { getPreferences, getUserById, updateAccount } from "./users.service";
import { readAvatar, saveProfile } from "./profile.service";

export const usersRouter = Router();

usersRouter.patch("/me/profile", apiRateLimiter, authMiddleware, userAccountMiddleware, asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  sendSuccess(res, { user: await saveProfile(req.user!.sub, req.body) });
}));
usersRouter.get("/me/avatar", apiRateLimiter, authMiddleware, userAccountMiddleware, asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  sendSuccess(res, { avatar: await readAvatar(req.user!.sub) });
}));

// GET /users/me
usersRouter.get(
  "/me",
  apiRateLimiter,
  authMiddleware,
  userAccountMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const user = await getUserById(req.user.sub);
    const preferences = await getPreferences(req.user.sub);
    sendSuccess(res, { user, preferences });
  }),
);

// PATCH /users/me
usersRouter.patch(
  "/me",
  apiRateLimiter,
  authMiddleware,
  userAccountMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new AppError("Unauthorized.", 401);
    const { user, preferences } = await updateAccount(req.user.sub, req.body);

    sendSuccess(res, { user, preferences });
  }),
);
