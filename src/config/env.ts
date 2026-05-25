import dotenv from "dotenv";

dotenv.config();

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? 3000);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer.");
  }

  return port;
};

const parseTtlSeconds = (value: string | undefined): number => {
  const ttl = Number(value ?? 90);

  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("LOCATION_TTL_SECONDS must be a positive number.");
  }

  return ttl;
};

export const env = {
  port: parsePort(process.env.PORT),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  locationTtlMs: parseTtlSeconds(process.env.LOCATION_TTL_SECONDS) * 1000,
};
