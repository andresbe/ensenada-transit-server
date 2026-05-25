import { AppError } from "../../shared/errors";
import {
  LocationUpdateRequest,
  RouteVariantDirection,
  SourceType,
} from "./locations.types";

const sourceTypes = new Set<SourceType>(["driver", "user"]);
const routeVariantDirections = new Set<RouteVariantDirection>(["ida", "vuelta"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const requireString = (body: Record<string, unknown>, field: string): string => {
  const value = body[field];

  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(`${field} is required and must be a non-empty string.`, 400);
  }

  return value;
};

const requireNumber = (body: Record<string, unknown>, field: string): number => {
  const value = body[field];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(`${field} is required and must be a finite number.`, 400);
  }

  return value;
};

export const validateLocationUpdate = (body: unknown): LocationUpdateRequest => {
  if (!isPlainObject(body)) {
    throw new AppError("Request body must be a JSON object.", 400);
  }

  const sourceId = requireString(body, "sourceId");
  const sourceType = requireString(body, "sourceType");
  const busId = requireString(body, "busId");
  const routeId = requireString(body, "routeId");
  const routeVariantId = requireString(body, "routeVariantId");
  const routeVariantDirection = requireString(body, "routeVariantDirection");
  const latitude = requireNumber(body, "latitude");
  const longitude = requireNumber(body, "longitude");
  const accuracy = requireNumber(body, "accuracy");
  const speed = requireNumber(body, "speed");
  const heading = requireNumber(body, "heading");
  const timestamp = requireNumber(body, "timestamp");

  if (!sourceTypes.has(sourceType as SourceType)) {
    throw new AppError("sourceType must be either 'driver' or 'user'.", 400);
  }

  if (!routeVariantDirections.has(routeVariantDirection as RouteVariantDirection)) {
    throw new AppError("routeVariantDirection must be either 'ida' or 'vuelta'.", 400);
  }

  if (latitude < -90 || latitude > 90) {
    throw new AppError("latitude must be between -90 and 90.", 400);
  }

  if (longitude < -180 || longitude > 180) {
    throw new AppError("longitude must be between -180 and 180.", 400);
  }

  if (accuracy < 0) {
    throw new AppError("accuracy must be greater than or equal to 0.", 400);
  }

  if (heading < 0 || heading > 360) {
    throw new AppError("heading must be between 0 and 360.", 400);
  }

  if (timestamp <= 0) {
    throw new AppError("timestamp must be a positive Unix timestamp in milliseconds.", 400);
  }

  return {
    sourceId,
    sourceType: sourceType as SourceType,
    busId,
    routeId,
    routeVariantId,
    routeVariantDirection: routeVariantDirection as RouteVariantDirection,
    latitude,
    longitude,
    accuracy,
    speed,
    heading,
    timestamp,
  };
};

export const parseIncludeStale = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.includes("true");
  }

  return value === "true";
};
