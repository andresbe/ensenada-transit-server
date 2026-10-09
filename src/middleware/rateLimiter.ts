import { NextFunction, Request, Response } from "express";
import { incrementRateLimit } from "../redis/cache";
import { validateToken } from "../auth/auth.service";
import { isTesterAccount } from "../users/tester";

interface RateLimiterOptions {
  /** Unique prefix for the Redis key (e.g. "auth", "api") */
  prefix: string;
  /** Maximum number of requests allowed within the window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

/**
 * Generic rate limiter middleware backed by Redis.
 * Falls back gracefully (allows the request) when Redis is unavailable.
 */
const countedRequests = new WeakMap<Request, Set<string>>();

export const rateLimiter = (options: RateLimiterOptions) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (countedRequests.get(req)?.has(options.prefix)) { next(); return; }
    let adminIdentifier: string | undefined;
    if(options.prefix === "api") {
      try {
        const header = req.headers.authorization;
        const identity = header?.startsWith("Bearer ") ? validateToken(header.slice(7)) : undefined;
        if (identity?.identityType === "admin" && identity.role === "admin") adminIdentifier = "admin:" + identity.sub;
        if(identity && identity.identityType !== "admin" && await isTesterAccount(identity.sub)) { next(); return; }
      } catch { /* Invalid tokens or database errors never grant tester privileges. */ }
    }
    // Use IP address as the identifier; fall back to a generic key
    const identifier = adminIdentifier ??
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";

    const count = await incrementRateLimit(
      options.prefix,
      identifier,
      options.windowSeconds,
    );

    // incrementRateLimit returns 0 on Redis error → fail open
    if (count > 0 && count > options.maxRequests) {
      res.setHeader("Retry-After", String(options.windowSeconds));
      res.status(429).json({
        error: {
          message: "Too many requests. Please try again later.",
          retryAfterSeconds: options.windowSeconds,
        },
      });
      return;
    }

    const counted = countedRequests.get(req) ?? new Set<string>();
    counted.add(options.prefix);
    countedRequests.set(req, counted);
    next();
  };
};

/** 5 requests per 60 seconds – used on auth endpoints */
export const authRateLimiter = rateLimiter({
  prefix: "auth",
  maxRequests: 5,
  windowSeconds: 60,
});

/** 100 requests per 60 seconds: verified admin identity, otherwise IP. */
export const apiRateLimiter = rateLimiter({
  prefix: "api",
  maxRequests: 100,
  windowSeconds: 60,
});
