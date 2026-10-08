// Shared by the API and operational scripts. Never disable certificate validation.
function databaseOptions(env = process.env) {
  const mode = env.DATABASE_SSL_MODE ?? (env.NODE_ENV === "production" ? "verify-full" : "disable");
  if (!["verify-full", "disable"].includes(mode)) {
    throw new Error("DATABASE_SSL_MODE must be verify-full or disable.");
  }
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    if ([...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith("ssl"))) {
      throw new Error("Remove SSL parameters from DATABASE_URL; configure DATABASE_SSL_MODE and DATABASE_SSL_CA instead.");
    }
  }
  return {
    connectionString: env.DATABASE_URL,
    ssl: mode === "verify-full"
      ? { rejectUnauthorized: true, ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}) }
      : false,
  };
}
module.exports = { databaseOptions };
