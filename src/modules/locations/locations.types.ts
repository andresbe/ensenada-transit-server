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
  accuracy: number;
  speed: number;
  heading: number;
  timestamp: number;
}

export interface StoredLocation extends LocationUpdateRequest {
  updatedAt: number;
}

export interface LiveBus {
  busId: string;
  routeId: string;
  routeVariantId: string;
  routeVariantDirection: RouteVariantDirection;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number;
  heading: number;
  updatedAt: number;
  isStale: boolean;
}
