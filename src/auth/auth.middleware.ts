import { currentLine } from "../tenancy/context";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/errors";
import { JWTPayload } from "../types";
import { validateToken } from "./auth.service";
import { getActiveAdmin } from "./admin.service";
import { query } from "../db";

// Extend Express Request to carry the authenticated user payload
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

export const extractBearerToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
};

async function checkDriverVersion(user: JWTPayload) {
  if (user.role !== "driver" || !user.sub.includes("@")) return;
  const result = await query("SELECT token_version FROM conductores WHERE correo=$1", [user.sub]);
  if (!result.rows[0] || (result.rows[0].token_version ?? 0) !== (user.tokenVersion ?? 0)) throw new AppError("La sesión del conductor expiró. Inicia sesión nuevamente.", 401);
}

// ── authMiddleware ────────────────────────────────────────────
// Verifies the JWT and attaches the payload to req.user.
export const authMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractBearerToken(req);
  if (!token) {
    return next(new AppError("Authentication token is required.", 401));
  }
  try {
    req.user = validateToken(token);
    void checkDriverVersion(req.user).then(() => next()).catch(next);
  } catch (err) {
    next(err);
  }
};

// ── optionalAuthMiddleware ────────────────────────────────────
// Attaches req.user when a bearer token is present, but allows anonymous requests.
export const optionalAuthMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractBearerToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    req.user = validateToken(token);
    void checkDriverVersion(req.user).then(() => next()).catch(next);
  } catch (err) {
    next(err);
  }
};

// ── adminMiddleware ───────────────────────────────────────────
// Must be used after authMiddleware.
export const adminMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user || req.user.role !== "admin" || req.user.identityType !== "admin") {
    return next(new AppError("Admin access required.", 403));
  }
  getActiveAdmin(req.user).then(admin => {
    if (!currentLine() && !admin.is_superadmin) throw new AppError("Selecciona una línea autorizada para esta operación.",403);
    next();
  }).catch(next);
};

// User-owned records have foreign keys to users, never to admins.
export const userAccountMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.user?.identityType === "admin") {
    return next(new AppError("This endpoint requires a user account, not an admin account.", 403));
  }
  if (!req.user || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(req.user.sub)) {
    return next(new AppError("This endpoint requires a passenger account.", 403));
  }
  query<{status:string}>("SELECT status FROM users WHERE id=$1", [req.user.sub])
    .then(result => {
      if (result.rows[0]?.status !== "active") return next(new AppError("User not found or inactive.",401));
      next();
    }).catch(next);
};

// ── driverMiddleware ──────────────────────────────────────────
// Must be used after authMiddleware.
export const driverMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.user?.identityType === "admin") {
    return next(new AppError("Driver sessions require a user account.", 403));
  }
  if (!req.user || (req.user.role !== "driver" && req.user.role !== "admin")) {
    return next(new AppError("Driver access required.", 403));
  }
  next();
};
