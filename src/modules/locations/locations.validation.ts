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

const optionalNumber = (
  body: Record<string, unknown>,
  field: string,
): number | undefined => {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(`${field} must be a finite number when provided.`, 400);
  }

  return value;
};

const validateLatitude = (latitude: number, field = "latitude") => {
  if (latitude < -90 || latitude > 90) {
    throw new AppError(`${field} must be between -90 and 90.`, 400);
  }
};

const validateLongitude = (longitude: number, field = "longitude") => {
  if (longitude < -180 || longitude > 180) {
    throw new AppError(`${field} must be between -180 and 180.`, 400);
  }
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
  const accuracy = optionalNumber(body, "accuracy");
  const speed = optionalNumber(body, "speed");
  const heading = optionalNumber(body, "heading");
  const timestamp = requireNumber(body, "timestamp");

  if (!sourceTypes.has(sourceType as SourceType)) {
    throw new AppError("sourceType must be either 'driver' or 'user'.", 400);
  }

  if (!routeVariantDirections.has(routeVariantDirection as RouteVariantDirection)) {
    throw new AppError("routeVariantDirection must be either 'ida' or 'vuelta'.", 400);
  }

  validateLatitude(latitude);
  validateLongitude(longitude);

  if (accuracy !== undefined && accuracy < 0) {
    throw new AppError("accuracy must be greater than or equal to 0.", 400);
  }

  if (speed !== undefined && speed < 0) {
    throw new AppError("speed must be greater than or equal to 0.", 400);
  }

  if (heading !== undefined && (heading < 0 || heading > 360)) {
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

const parseQueryNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    throw new AppError(`${field} must be provided only once.`, 400);
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError(`${field} must be a valid number.`, 400);
  }

  return parsed;
};

export interface EtaQuery {
  userLat: number;
  userLng: number;
  destLat?: number;
  destLng?: number;
  includeStale: boolean;
}

export const validateEtaQuery = (query: Record<string, unknown>): EtaQuery => {
  const userLat = parseQueryNumber(query.userLat, "userLat");
  const userLng = parseQueryNumber(query.userLng, "userLng");
  const destLat = parseQueryNumber(query.destLat, "destLat");
  const destLng = parseQueryNumber(query.destLng, "destLng");

  if (userLat === undefined || userLng === undefined) {
    throw new AppError("userLat and userLng are required.", 400);
  }

  if ((destLat === undefined) !== (destLng === undefined)) {
    throw new AppError("destLat and destLng must be provided together.", 400);
  }

  validateLatitude(userLat, "userLat");
  validateLongitude(userLng, "userLng");

  if (destLat !== undefined && destLng !== undefined) {
    validateLatitude(destLat, "destLat");
    validateLongitude(destLng, "destLng");
  }

  return {
    userLat,
    userLng,
    destLat,
    destLng,
    includeStale: parseIncludeStale(query.includeStale),
  };
};
