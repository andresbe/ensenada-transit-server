import { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/errors";
import { JWTPayload } from "../types";
import { validateToken } from "./auth.service";

// Extend Express Request to carry the authenticated user payload
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

const extractBearerToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
};

// ── authMiddleware ────────────────────────────────────────────
// Verifies the JWT and attaches the payload to req.user.
export const authMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractBearerToken(req);
  if (!token) {
    return next(new AppError("Authentication token is required.", 401));
  }
  try {
    req.user = validateToken(token);
    next();
  } catch (err) {
    next(err);
  }
};

// ── adminMiddleware ───────────────────────────────────────────
// Must be used after authMiddleware.
export const adminMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user || req.user.role !== "admin") {
    return next(new AppError("Admin access required.", 403));
  }
  next();
};

// ── driverMiddleware ──────────────────────────────────────────
// Must be used after authMiddleware.
export const driverMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user || (req.user.role !== "driver" && req.user.role !== "admin")) {
    return next(new AppError("Driver access required.", 403));
  }
  next();
};
