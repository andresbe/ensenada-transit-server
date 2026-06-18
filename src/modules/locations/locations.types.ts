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
export type TripPhase =
  | "starting"
  | "in_progress"
  | "near_end"
  | "completed"
  | "off_route"
  | "unknown";

export interface LiveBusLocation extends LocationUpdateRequest {
  updatedAt: number;
  routeProgressMeters: number | null;
  routeTotalDistanceMeters: number | null;
  progressRemainingMeters: number | null;
  progressRatio: number | null;
  progressPercent: number | null;
  snappedLatitude: number | null;
  snappedLongitude: number | null;
  distanceFromRouteMeters: number | null;
  avgSpeedMps?: number;
  isStopped?: boolean;
  directionConfidence?: Confidence;
  etaConfidence?: Confidence;
  tripPhase: TripPhase;
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
  routeProgressMeters: number | null;
  routeTotalDistanceMeters: number | null;
  progressRemainingMeters: number | null;
  progressRatio: number | null;
  progressPercent: number | null;
  snappedLatitude: number | null;
  snappedLongitude: number | null;
  distanceFromRouteMeters: number | null;
  avgSpeedMps?: number;
  isStopped?: boolean;
  directionConfidence?: Confidence;
  etaConfidence?: Confidence;
  tripPhase: TripPhase;
  isStale: boolean;
}

export interface EtaBus extends LiveBus {
  distanceToUserMeters: number;
  etaToUserSeconds: number;
  etaToUserMinutes: number;
  etaUserToDestinationSeconds?: number;
  etaUserToDestinationMinutes?: number;
  isViable: boolean;
  reason?:
    | "passed_user"
    | "opposite_direction"
    | "far_from_route"
    | "insufficient_data"
    | "insufficient_speed_data";
}
