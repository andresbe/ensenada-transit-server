export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface NearestPolylinePoint extends GeoPoint {
  distanceFromRouteMeters: number;
  segmentIndex: number;
  progressMeters: number;
}

const earthRadiusMeters = 6371000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const toLocalMeters = (point: GeoPoint, origin: GeoPoint) => {
  const meanLatitude = toRadians((point.latitude + origin.latitude) / 2);

  return {
    x:
      toRadians(point.longitude - origin.longitude) *
      earthRadiusMeters *
      Math.cos(meanLatitude),
    y: toRadians(point.latitude - origin.latitude) * earthRadiusMeters,
  };
};

const fromLocalMeters = (
  localPoint: { x: number; y: number },
  origin: GeoPoint,
): GeoPoint => {
  const latitude = origin.latitude + (localPoint.y / earthRadiusMeters) * (180 / Math.PI);
  const longitude =
    origin.longitude +
    (localPoint.x /
      (earthRadiusMeters * Math.cos(toRadians((latitude + origin.latitude) / 2)))) *
      (180 / Math.PI);

  return { latitude, longitude };
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

export const haversineDistanceMeters = (a: GeoPoint, b: GeoPoint): number => {
  const deltaLatitude = toRadians(b.latitude - a.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const latitudeA = toRadians(a.latitude);
  const latitudeB = toRadians(b.latitude);

  const h =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLongitude / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

export const calculatePolylineDistanceMeters = (points: GeoPoint[]): number => {
  if (points.length < 2) {
    return 0;
  }

  return points.slice(1).reduce((distance, point, index) => {
    return distance + haversineDistanceMeters(points[index], point);
  }, 0);
};

export const findNearestPointOnPolyline = (
  point: GeoPoint,
  polyline: GeoPoint[],
): NearestPolylinePoint => {
  if (polyline.length === 0) {
    throw new Error("Polyline must contain at least one point.");
  }

  if (polyline.length === 1) {
    return {
      ...polyline[0],
      distanceFromRouteMeters: haversineDistanceMeters(point, polyline[0]),
      segmentIndex: 0,
      progressMeters: 0,
    };
  }

  let best: NearestPolylinePoint | undefined;
  let progressBeforeSegment = 0;

  for (let index = 0; index < polyline.length - 1; index += 1) {
    const start = polyline[index];
    const end = polyline[index + 1];
    const segmentLengthMeters = haversineDistanceMeters(start, end);

    if (segmentLengthMeters === 0) {
      continue;
    }

    const localPoint = toLocalMeters(point, start);
    const localEnd = toLocalMeters(end, start);
    const segmentLengthSquared = localEnd.x ** 2 + localEnd.y ** 2;
    const projectedRatio = clamp(
      (localPoint.x * localEnd.x + localPoint.y * localEnd.y) / segmentLengthSquared,
      0,
      1,
    );
    const projectedLocalPoint = {
      x: localEnd.x * projectedRatio,
      y: localEnd.y * projectedRatio,
    };
    const projectedPoint = fromLocalMeters(projectedLocalPoint, start);
    const distanceFromRouteMeters = haversineDistanceMeters(point, projectedPoint);
    const progressMeters = progressBeforeSegment + segmentLengthMeters * projectedRatio;

    if (!best || distanceFromRouteMeters < best.distanceFromRouteMeters) {
      best = {
        ...projectedPoint,
        distanceFromRouteMeters,
        segmentIndex: index,
        progressMeters,
      };
    }

    progressBeforeSegment += segmentLengthMeters;
  }

  if (!best) {
    return {
      ...polyline[0],
      distanceFromRouteMeters: haversineDistanceMeters(point, polyline[0]),
      segmentIndex: 0,
      progressMeters: 0,
    };
  }

  return best;
};

export const calculateProgressAlongPolyline = (
  point: GeoPoint,
  polyline: GeoPoint[],
): number => {
  return findNearestPointOnPolyline(point, polyline).progressMeters;
};
