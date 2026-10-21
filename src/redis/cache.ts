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
    // Compare and write atomically across all server processes. Duplicate samples do not renew TTL.
    await redisClient.eval(`
      local old = redis.call('GET', KEYS[1])
      if old then
        local ok, previous = pcall(cjson.decode, old)
        if ok and tonumber(previous.timestamp) >= tonumber(ARGV[2]) then return 0 end
      end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
      redis.call('SADD', KEYS[2], ARGV[4])
      return 1
    `, {keys: [busLocationKey(busId), liveBusesIndexKey()],
      arguments: [JSON.stringify(location), String(location.timestamp), String(Math.ceil(ttlSeconds)), busId]});
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

// Recheck existence in the same atomic operation that removes the index member.
export const removeMissingLiveBusIndexEntries = async (busIds: string[]): Promise<number> => {
  let removed = 0;
  for (const busId of busIds) {
    removed += Number(await redisClient.eval(`
      if redis.call('EXISTS', KEYS[1]) == 0 then
        return redis.call('SREM', KEYS[2], ARGV[1])
      end
      return 0
    `, { keys: [busLocationKey(busId), liveBusesIndexKey()], arguments: [busId] }));
  }
  return removed;
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

    const removed = await removeMissingLiveBusIndexEntries(expiredBusIds);
    if (removed > 0) console.log("[cache] Removed expired live bus ids from Redis index", { count: removed });
    return removed;
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
      const removed = await removeMissingLiveBusIndexEntries(expiredBusIds);
      if (removed > 0) console.log("[cache] Removed expired live bus ids from Redis index", { count: removed });
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
    if(!redisClient.isReady) return 0;
    const count = Number(await redisClient.eval(`
      local count = redis.call('INCR', KEYS[1])
      if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return count
    `, {keys:[key],arguments:[String(windowSeconds)]}));
    return count;
  } catch (err) {
    console.error(`[cache] Rate limit error for key "${key}":`, err);
    return 0; // fail open
  }
};

// A delayed end must never remove a newer service using the same vehicle.
export async function removeEndedSessionLocation(busId:string,sessionId:string):Promise<void> {
  if(!redisClient.isReady)return;
  try {
    await redisClient.eval(`
      local raw=redis.call('GET',KEYS[1])
      if not raw then return 0 end
      local ok,value=pcall(cjson.decode,raw)
      if not ok or value.sessionId~=ARGV[1] then return 0 end
      redis.call('DEL',KEYS[1])
      redis.call('SREM',KEYS[2],ARGV[2])
      return 1
    `,{keys:[busLocationKey(busId),liveBusesIndexKey()],arguments:[sessionId,busId]});
  }catch(error){console.error('[cache] Could not retire ended session location',error);}
}
