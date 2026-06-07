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
  BUS_LOCATION: 90,  // 1.5 min (matches LOCATION_TTL_SECONDS default)
};

export const routesCacheKey = () => "routes:all";
export const routeCacheKey = (routeId: string) => `routes:${routeId}`;
export const variantCacheKey = (variantId: string) => `variants:${variantId}`;
export const busLocationKey = (busId: string) => `bus:location:${busId}`;
export const liveBusesKey = () => "buses:live";
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
export const setBusLocation = (busId: string, data: unknown, ttlSeconds = TTL.BUS_LOCATION) =>
  cacheSet(busLocationKey(busId), data, ttlSeconds);

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
