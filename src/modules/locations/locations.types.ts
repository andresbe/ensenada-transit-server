export type SourceType = "driver" | "user";

export type RouteVariantDirection = "ida" | "vuelta";

export interface LocationUpdateRequest {
  sourceId: string;
  sourceType: SourceType;
  busId: string;
  routeId: string;
  routeVariantId: string;
  routeVariantDirection: RouteVariantDirection;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
}

export type Confidence = "high" | "medium" | "low";

export interface LiveBusLocation extends LocationUpdateRequest {
  updatedAt: number;
  routeProgressMeters?: number;
  snappedLatitude?: number;
  snappedLongitude?: number;
  distanceFromRouteMeters?: number;
  avgSpeedMps?: number;
  isStopped?: boolean;
  directionConfidence?: Confidence;
  etaConfidence?: Confidence;
}

export interface LiveBus {
  busId: string;
  sourceId: string;
  sourceType: SourceType;
  routeId: string;
  routeVariantId: string;
  routeVariantDirection: RouteVariantDirection;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
  updatedAt: number;
  routeProgressMeters?: number;
  snappedLatitude?: number;
  snappedLongitude?: number;
  distanceFromRouteMeters?: number;
  avgSpeedMps?: number;
  isStopped?: boolean;
  directionConfidence?: Confidence;
  etaConfidence?: Confidence;
  isStale: boolean;
}

export interface EtaBus extends LiveBus {
  distanceToUserMeters: number;
  etaToUserSeconds: number;
  etaToUserMinutes: number;
  etaUserToDestinationSeconds?: number;
  etaUserToDestinationMinutes?: number;
  isViable: boolean;
}
