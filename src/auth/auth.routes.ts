import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { authRateLimiter } from "../middleware/rateLimiter";
import {
  guestHandler,
  loginHandler,
  refreshHandler,
  registerHandler,
  socialHandler,
} from "./auth.controller";

export const authRouter = Router();

authRouter.post("/register", authRateLimiter, asyncHandler(registerHandler));
authRouter.post("/login",    authRateLimiter, asyncHandler(loginHandler));
authRouter.post("/social",   authRateLimiter, asyncHandler(socialHandler));
authRouter.post("/guest",    authRateLimiter, asyncHandler(guestHandler));
authRouter.post("/refresh",  authRateLimiter, asyncHandler(refreshHandler));
