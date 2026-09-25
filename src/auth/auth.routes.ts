import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { authRateLimiter } from "../middleware/rateLimiter";
import { authMiddleware } from "./auth.middleware";
import {
  conductorLoginHandler,
  adminLoginHandler,
  adminMeHandler,
  guestHandler,
  loginHandler,
  refreshHandler,
  registerHandler,
  socialHandler,
} from "./auth.controller";

export const authRouter = Router();

authRouter.post("/admin-login", authRateLimiter, asyncHandler(adminLoginHandler));
authRouter.get("/admin/me", authMiddleware, asyncHandler(adminMeHandler));

authRouter.post("/register", authRateLimiter, asyncHandler(registerHandler));
authRouter.post("/login",    authRateLimiter, asyncHandler(loginHandler));
authRouter.post("/driver-login", authRateLimiter, asyncHandler(conductorLoginHandler));
authRouter.post("/social",   authRateLimiter, asyncHandler(socialHandler));
authRouter.post("/guest",    authRateLimiter, asyncHandler(guestHandler));
authRouter.post("/refresh",  authRateLimiter, asyncHandler(refreshHandler));
