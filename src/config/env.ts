import dotenv from "dotenv";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });

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

const parseLocationAuthMode = (value: string | undefined): "optional" | "required" => {
  const mode = value ?? "optional";

  if (mode !== "optional" && mode !== "required") {
    throw new Error("LOCATION_UPDATE_AUTH_MODE must be either 'optional' or 'required'.");
  }

  return mode;
};

const parseHardwareAutoDirectionMode = (
  value: string | undefined,
): "off" | "shadow" | "enabled" => {
  const mode = value ?? "off";

  if (mode !== "off" && mode !== "shadow" && mode !== "enabled") {
    throw new Error(
      "HARDWARE_AUTO_DIRECTION_MODE must be 'off', 'shadow', or 'enabled'.",
    );
  }

  return mode;
};

export const env = {
  host: process.env.HOST ?? "0.0.0.0",
  port: parsePort(process.env.PORT),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  locationTtlMs: parseTtlSeconds(process.env.LOCATION_TTL_SECONDS) * 1000,
  locationUpdateAuthMode: parseLocationAuthMode(process.env.LOCATION_UPDATE_AUTH_MODE),
  hardwareAutoDirectionMode: parseHardwareAutoDirectionMode(
    process.env.HARDWARE_AUTO_DIRECTION_MODE,
  ),
};
