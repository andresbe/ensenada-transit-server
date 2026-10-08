import { timingSafeEqual } from "node:crypto";

export function localSimulationAllowed(environment: NodeJS.ProcessEnv, address: string | undefined, token: string | undefined) {
  if (environment.NODE_ENV !== "development" || environment.LOCAL_SIMULATION_ENABLED !== "true"
    || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")) return false;
  try {
    const db = new URL(environment.DATABASE_URL ?? "");
    const redis = new URL(environment.REDIS_URL ?? "");
    if (db.hostname !== "127.0.0.1" || db.port !== "55432" || db.pathname !== "/transit_local"
      || redis.hostname !== "127.0.0.1" || redis.port !== "56379") return false;
  } catch { return false; }
  const expected = environment.LOCATION_DEBUG_TOKEN;
  if (!expected || !token || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const a = Buffer.from(expected), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
