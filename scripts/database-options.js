// Shared by the API and migrations. Public connections validate certificates.
function databaseOptions(env = process.env) {
  const url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : undefined;
  const railwayPrivate = Boolean(url?.hostname.endsWith(".railway.internal"));
  const mode = env.DATABASE_SSL_MODE ?? (env.NODE_ENV === "production"
    ? railwayPrivate && !env.DATABASE_SSL_CA ? "require" : "verify-full"
    : "disable");
  if (!["verify-full", "require", "disable"].includes(mode)) {
    throw new Error("DATABASE_SSL_MODE must be verify-full, require or disable.");
  }
  if (mode === "require" && !railwayPrivate) {
    throw new Error("DATABASE_SSL_MODE=require is restricted to *.railway.internal; use verify-full for public connections.");
  }
  if (mode === "require" && env.DATABASE_SSL_CA) {
    throw new Error("Use DATABASE_SSL_MODE=verify-full with DATABASE_SSL_CA.");
  }
  if (env.DATABASE_URL) {
    if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith("ssl"))) {
      throw new Error("Remove SSL parameters from DATABASE_URL; configure DATABASE_SSL_MODE and DATABASE_SSL_CA instead.");
    }
  }
  return {
    connectionString: env.DATABASE_URL,
    ssl: mode === "verify-full"
      ? { rejectUnauthorized: true, ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}) }
      : mode === "require" ? { rejectUnauthorized: false } : false,
  };
}
module.exports = { databaseOptions };
