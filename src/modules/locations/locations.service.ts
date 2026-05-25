import { env } from "../../config/env";
import { LiveBus, LocationUpdateRequest, StoredLocation } from "./locations.types";

const locationsByBusId = new Map<string, StoredLocation>();

const isLocationStale = (location: StoredLocation, now = Date.now()): boolean => {
  return now - location.updatedAt > env.locationTtlMs;
};

const toLiveBus = (location: StoredLocation, now = Date.now()): LiveBus => {
  return {
    busId: location.busId,
    routeId: location.routeId,
    routeVariantId: location.routeVariantId,
    routeVariantDirection: location.routeVariantDirection,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    speed: location.speed,
    heading: location.heading,
    updatedAt: location.updatedAt,
    isStale: isLocationStale(location, now),
  };
};

const filterStale = (buses: LiveBus[], includeStale: boolean): LiveBus[] => {
  return includeStale ? buses : buses.filter((bus) => !bus.isStale);
};

export const locationsService = {
  updateLocation(payload: LocationUpdateRequest): StoredLocation {
    const storedLocation: StoredLocation = {
      ...payload,
      updatedAt: Date.now(),
    };

    locationsByBusId.set(payload.busId, storedLocation);
    return storedLocation;
  },

  getLiveBuses(includeStale = false): LiveBus[] {
    const now = Date.now();
    const buses = Array.from(locationsByBusId.values()).map((location) =>
      toLiveBus(location, now),
    );

    return filterStale(buses, includeStale);
  },

  getLiveBusesByRouteVariant(routeVariantId: string, includeStale = false): LiveBus[] {
    const now = Date.now();
    const buses = Array.from(locationsByBusId.values())
      .filter((location) => location.routeVariantId === routeVariantId)
      .map((location) => toLiveBus(location, now));

    return filterStale(buses, includeStale);
  },
};
