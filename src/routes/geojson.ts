import { AppError } from "../shared/errors";
import { calculatePolylineDistanceMeters } from "../shared/geo/geometry";

type Coordinate = [number, number];
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Expected a JSON object.", 400);
  }
  return value as Record<string, unknown>;
};

export const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new AppError(`${field} must be a non-empty string of at most 200 characters.`, 400);
  }
  return value.trim();
};

// Join only explicitly contiguous segments: never invent a road across a gap.
export const parseRouteGeoJson = (value: unknown): { coordinates: Coordinate[]; distance: number } => {
  const segments: Coordinate[][] = [];
  const line = (raw: unknown) => {
    if (!Array.isArray(raw) || raw.length < 2) throw new AppError("Each LineString needs at least two positions.", 400);
    segments.push(raw.map((position): Coordinate => {
      if (!Array.isArray(position) || position.length < 2 || position.length > 3 ||
          !position.every((n) => typeof n === "number" && Number.isFinite(n)) ||
          Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) {
        throw new AppError("Invalid GeoJSON position; expected [longitude, latitude] with optional altitude.", 400);
      }
      return [position[0], position[1]];
    }));
  };
  const geometry = (value: unknown) => {
    const g = object(value);
    if (g.type === "LineString") line(g.coordinates);
    else if (g.type === "MultiLineString" && Array.isArray(g.coordinates)) g.coordinates.forEach(line);
    else throw new AppError("Only LineString and MultiLineString route geometries are supported.", 400);
  };
  const root = object(value);
  if (root.type === "FeatureCollection" && Array.isArray(root.features)) {
    for (const raw of root.features) {
      const feature = object(raw);
      if (feature.type !== "Feature") throw new AppError("Expected GeoJSON Feature.", 400);
      geometry(feature.geometry);
    }
  } else if (root.type === "Feature") geometry(root.geometry);
  else geometry(root);

  const coordinates: Coordinate[] = [];
  for (const segment of segments) {
    const last = coordinates[coordinates.length - 1];
    if (last && (last[0] !== segment[0][0] || last[1] !== segment[0][1])) {
      throw new AppError("Route segments must be ordered and connected end-to-start. Send ida and vuelta as separate variants.", 400);
    }
    for (let i = last ? 1 : 0; i < segment.length; i++) coordinates.push(segment[i]);
  }
  if (coordinates.length > 100000) throw new AppError("A variant cannot exceed 100000 positions.", 400);
  const distance = calculatePolylineDistanceMeters(coordinates.map(([longitude, latitude]) => ({ longitude, latitude })));
  if (!Number.isFinite(distance) || distance < 0.01 || distance > 99999999.99) {
    throw new AppError("Route must have a positive distance within the supported range.", 400);
  }
  return { coordinates, distance: Math.round(distance * 100) / 100 };
};
