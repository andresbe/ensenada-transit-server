import { env } from "../config/env";
import { LiveBusLocation } from "../modules/locations/locations.types";
import redisClient from "./client";

// ── Generic helpers ───────────────────────────────────────────

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  try {
    const raw = await redisClient.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`[cache] GET error for key "${key}":`, err);
    return null;
  }
};

export const cacheSet = async (
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> => {
  try {
    await redisClient.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.error(`[cache] SET error for key "${key}":`, err);
  }
};

export const cacheDel = async (key: string): Promise<void> => {
  try {
    await redisClient.del(key);
  } catch (err) {
    console.error(`[cache] DEL error for key "${key}":`, err);
  }
};

// ── Domain-specific cache keys & TTLs ────────────────────────

const TTL = {
  ROUTES: 300,       // 5 min
  ROUTE: 300,        // 5 min
  VARIANT: 600,      // 10 min
};

export const routesCacheKey = () => "routes:all";
export const routeCacheKey = (routeId: string) => `routes:${routeId}`;
export const variantCacheKey = (variantId: string) => `variants:${variantId}`;
export const busLocationKey = (busId: string) => `bus:location:${busId}`;
export const liveBusesKey = () => "buses:live";
export const liveBusesIndexKey = () => "buses:live:index";
export const routeLiveBusesKey = (routeId: string) => `buses:live:route:${routeId}`;
export const rateLimitKey = (prefix: string, identifier: string) =>
  `ratelimit:${prefix}:${identifier}`;

// ── Routes cache ──────────────────────────────────────────────

export const getCachedRoutes = <T>() => cacheGet<T>(routesCacheKey());
export const setCachedRoutes = (data: unknown) =>
  cacheSet(routesCacheKey(), data, TTL.ROUTES);
export const invalidateRoutesCache = () => cacheDel(routesCacheKey());

export const getCachedRoute = <T>(routeId: string) =>
  cacheGet<T>(routeCacheKey(routeId));
export const setCachedRoute = (routeId: string, data: unknown) =>
  cacheSet(routeCacheKey(routeId), data, TTL.ROUTE);
export const invalidateRouteCache = (routeId: string) =>
  cacheDel(routeCacheKey(routeId));

export const getCachedVariant = <T>(variantId: string) =>
  cacheGet<T>(variantCacheKey(variantId));
export const setCachedVariant = (variantId: string, data: unknown) =>
  cacheSet(variantCacheKey(variantId), data, TTL.VARIANT);
export const invalidateVariantCache = (variantId: string) =>
  cacheDel(variantCacheKey(variantId));

// ── Bus location cache ────────────────────────────────────────

export const getBusLocation = <T>(busId: string) =>
  cacheGet<T>(busLocationKey(busId));
export const setBusLocation = (busId: string, data: unknown, ttlSeconds = env.locationTtlMs / 1000) =>
  cacheSet(busLocationKey(busId), data, ttlSeconds);

export const setLiveBusLocation = async (
  busId: string,
  location: LiveBusLocation,
  ttlSeconds = env.locationTtlMs / 1000,
): Promise<void> => {
  try {
    await Promise.all([
      redisClient.set(busLocationKey(busId), JSON.stringify(location), { EX: ttlSeconds }),
      redisClient.sAdd(liveBusesIndexKey(), busId),
    ]);
    console.log("[cache] Live bus location written to Redis", { busId, ttlSeconds });
  } catch (err) {
    console.error("[cache] Redis setLiveBusLocation error:", err);
  }
};

export const getLiveBusLocation = <T = LiveBusLocation>(busId: string) =>
  cacheGet<T>(busLocationKey(busId));

export const removeLiveBusLocation = async (busId: string): Promise<void> => {
  try {
    await Promise.all([
      redisClient.del(busLocationKey(busId)),
      redisClient.sRem(liveBusesIndexKey(), busId),
    ]);
  } catch (err) {
    console.error("[cache] Redis removeLiveBusLocation error:", err);
  }
};

export const cleanupLiveBusIndex = async (): Promise<number> => {
  try {
    const busIds = await redisClient.sMembers(liveBusesIndexKey());
    const expiredBusIds: string[] = [];

    await Promise.all(
      busIds.map(async (busId) => {
        const exists = await redisClient.exists(busLocationKey(busId));
        if (!exists) {
          expiredBusIds.push(busId);
        }
      }),
    );

    if (expiredBusIds.length > 0) {
      await redisClient.sRem(liveBusesIndexKey(), expiredBusIds);
      console.log("[cache] Removed expired live bus ids from Redis index", {
        count: expiredBusIds.length,
      });
    }

    return expiredBusIds.length;
  } catch (err) {
    console.error("[cache] Redis cleanupLiveBusIndex error:", err);
    return 0;
  }
};

export const getLiveBusLocations = async (): Promise<LiveBusLocation[]> => {
  try {
    const busIds = await redisClient.sMembers(liveBusesIndexKey());

    if (busIds.length === 0) {
      return [];
    }

    const locations: LiveBusLocation[] = [];
    const expiredBusIds: string[] = [];

    await Promise.all(
      busIds.map(async (busId) => {
        const location = await getLiveBusLocation<LiveBusLocation>(busId);

        if (!location) {
          expiredBusIds.push(busId);
          return;
        }

        locations.push(location);
      }),
    );

    if (expiredBusIds.length > 0) {
      await redisClient.sRem(liveBusesIndexKey(), expiredBusIds);
      console.log("[cache] Removed expired live bus ids from Redis index", {
        count: expiredBusIds.length,
      });
    }

    return locations;
  } catch (err) {
    console.error("[cache] Redis getLiveBusLocations error:", err);
    return [];
  }
};

// ── Rate limiting ─────────────────────────────────────────────

export const incrementRateLimit = async (
  prefix: string,
  identifier: string,
  windowSeconds: number,
): Promise<number> => {
  const key = rateLimitKey(prefix, identifier);
  try {
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, windowSeconds);
    }
    return count;
  } catch (err) {
    console.error(`[cache] Rate limit error for key "${key}":`, err);
    return 0; // fail open
  }
};
