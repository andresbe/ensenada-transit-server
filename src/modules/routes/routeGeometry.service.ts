import fs from "fs";
import path from "path";
import {
  calculatePolylineDistanceMeters,
  findNearestPointOnPolyline,
  GeoPoint,
  NearestPolylinePoint,
} from "../../shared/geo/geometry";
import { AppError } from "../../shared/errors";

interface GeoJsonLineString {
  type: "LineString";
  coordinates: number[][];
}

interface GeoJsonFeature {
  type: "Feature";
  geometry?: GeoJsonLineString | { type: string; coordinates?: unknown };
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

interface RouteGeometry {
  routeVariantId: string;
  segments: GeoPoint[][];
  segmentStartProgressMeters: number[];
  totalDistanceMeters: number;
}

export interface RouteSnapResult extends NearestPolylinePoint {
  segmentGroupIndex: number;
}

const supportedRouteVariantIds = [
  "acapulco_ida",
  "acapulco_vuelta",
  "ruta_violeta_ida",
  "ruta_violeta_vuelta",
  "libramiento_norte_rojo_ida",
  "libramiento_norte_rojo_vuelta",
  "aguilas_89_ida",
  "aguilas_89_vuelta",
  "amp_indeco_ida",
  "amp_indeco_vuelta",
];

const routeGeometries = new Map<string, RouteGeometry>();

const geoJsonDirectory = path.join(process.cwd(), "src", "data", "geojson");

const isCoordinate = (value: unknown): value is number[] => {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
};

const toPoint = ([longitude, latitude]: number[]): GeoPoint => ({ latitude, longitude });

const loadRouteGeometry = (routeVariantId: string): RouteGeometry | undefined => {
  const filePath = path.join(geoJsonDirectory, `${routeVariantId}.geojson`);

  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as GeoJsonFeatureCollection;

  if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error(`${routeVariantId}.geojson must be a FeatureCollection.`);
  }

  const segments = parsed.features
    .filter((feature) => feature.geometry?.type === "LineString")
    .map((feature) => {
      const geometry = feature.geometry as GeoJsonLineString;
      return geometry.coordinates.filter(isCoordinate).map(toPoint);
    })
    .filter((points) => points.length > 0);

  const segmentStartProgressMeters: number[] = [];
  let totalDistanceMeters = 0;

  for (const segment of segments) {
    segmentStartProgressMeters.push(totalDistanceMeters);
    totalDistanceMeters += calculatePolylineDistanceMeters(segment);
  }

  return {
    routeVariantId,
    segments,
    segmentStartProgressMeters,
    totalDistanceMeters,
  };
};

const loadAllRouteGeometries = () => {
  for (const routeVariantId of supportedRouteVariantIds) {
    const geometry = loadRouteGeometry(routeVariantId);

    if (geometry) {
      routeGeometries.set(routeVariantId, geometry);
    }
  }
};

loadAllRouteGeometries();

export const routeGeometryService = {
  getRouteGeometry(routeVariantId: string): RouteGeometry | undefined {
    return routeGeometries.get(routeVariantId);
  },

  requireRouteGeometry(routeVariantId: string): RouteGeometry {
    const routeGeometry = routeGeometries.get(routeVariantId);

    if (!routeGeometry) {
      throw new AppError(`No route geometry found for routeVariantId '${routeVariantId}'.`, 404);
    }

    return routeGeometry;
  },

  snapPointToRoute(routeVariantId: string, point: GeoPoint): RouteSnapResult | undefined {
    const routeGeometry = routeGeometries.get(routeVariantId);

    if (!routeGeometry) {
      return undefined;
    }

    let bestSnap: RouteSnapResult | undefined;

    routeGeometry.segments.forEach((segment, segmentGroupIndex) => {
      const snap = findNearestPointOnPolyline(point, segment);
      const progressMeters =
        routeGeometry.segmentStartProgressMeters[segmentGroupIndex] + snap.progressMeters;

      if (!bestSnap || snap.distanceFromRouteMeters < bestSnap.distanceFromRouteMeters) {
        bestSnap = {
          ...snap,
          progressMeters,
          segmentGroupIndex,
        };
      }
    });

    return bestSnap;
  },
};
