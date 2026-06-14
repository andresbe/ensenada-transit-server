import { env } from "../../config/env";
import { getLiveBusLocations } from "../../redis/cache";
import { haversineDistanceMeters } from "../../shared/geo/geometry";
import { routeGeometryService } from "../routes/routeGeometry.service";
import {
  Confidence,
  EtaBus,
  LiveBus,
  LiveBusLocation,
  LocationUpdateRequest,
} from "./locations.types";

const maxHistoryPointsPerBus = 10;
const maxHistoryAgeMs = 5 * 60 * 1000;
const defaultUrbanBusSpeedMps = 5.5;
const maxReasonableBusSpeedMps = 25;
const offRouteLowConfidenceThresholdMeters = 80;

const locationsByBusId = new Map<string, LiveBusLocation>();
const busLocationHistory = new Map<string, LiveBusLocation[]>();

const isLocationStale = (location: LiveBusLocation, now = Date.now()): boolean => {
  return now - location.updatedAt > env.locationTtlMs;
};

const isValidGpsSpeed = (speed: number | undefined): speed is number => {
  return speed !== undefined && speed >= 0 && speed <= maxReasonableBusSpeedMps;
};

const pruneHistory = (history: LiveBusLocation[], now: number): LiveBusLocation[] => {
  return history
    .filter((location) => now - location.updatedAt <= maxHistoryAgeMs)
    .slice(-maxHistoryPointsPerBus);
};

const calculateAverageSpeedMps = (
  currentLocation: LiveBusLocation,
  history: LiveBusLocation[],
): number => {
  if (currentLocation.routeProgressMeters === undefined) {
    return isValidGpsSpeed(currentLocation.speed)
      ? currentLocation.speed
      : defaultUrbanBusSpeedMps;
  }

  const points = [...history, currentLocation];
  const speedSamples: number[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];

    if (
      previous.routeProgressMeters === undefined ||
      current.routeProgressMeters === undefined
    ) {
      continue;
    }

    const progressDelta = current.routeProgressMeters - previous.routeProgressMeters;
    const timeDeltaSeconds = (current.updatedAt - previous.updatedAt) / 1000;

    if (progressDelta <= 0 || timeDeltaSeconds <= 0) {
      continue;
    }

    const speedMps = progressDelta / timeDeltaSeconds;

    if (speedMps <= maxReasonableBusSpeedMps) {
      speedSamples.push(speedMps);
    }
  }

  const recentSamples = speedSamples.slice(-5);

  if (recentSamples.length > 0) {
    return recentSamples.reduce((sum, speed) => sum + speed, 0) / recentSamples.length;
  }

  return isValidGpsSpeed(currentLocation.speed)
    ? currentLocation.speed
    : defaultUrbanBusSpeedMps;
};

const calculateDirectionConfidence = (
  currentLocation: LiveBusLocation,
  history: LiveBusLocation[],
): Confidence => {
  if (currentLocation.routeProgressMeters === undefined) {
    return "low";
  }

  const progressValues = [...history.slice(-3), currentLocation]
    .map((location) => location.routeProgressMeters)
    .filter((progress): progress is number => progress !== undefined);

  if (progressValues.length < 2) {
    return "medium";
  }

  const deltas = progressValues.slice(1).map((progress, index) => {
    return progress - progressValues[index];
  });
  const increasingDeltas = deltas.filter((delta) => delta > 0);
  const hasMeaningfulDecrease = deltas.some((delta) => delta < -5);

  if (hasMeaningfulDecrease || increasingDeltas.length === 0) {
    return "low";
  }

  if (progressValues.length >= 4 && increasingDeltas.length === deltas.length) {
    return "high";
  }

  return "medium";
};

const calculateEtaConfidence = (location: LiveBusLocation): Confidence => {
  if (
    location.distanceFromRouteMeters !== undefined &&
    location.distanceFromRouteMeters > offRouteLowConfidenceThresholdMeters
  ) {
    return "low";
  }

  if (location.directionConfidence === "high" && location.avgSpeedMps !== undefined) {
    return "medium";
  }

  return location.directionConfidence ?? "low";
};

const isSpeedUsableForEta = (speed: number | undefined): speed is number => {
  return speed !== undefined && speed >= 0.7 && speed <= maxReasonableBusSpeedMps;
};

const busPoint = (bus: LiveBus): { latitude: number; longitude: number } => ({
  latitude: bus.latitude,
  longitude: bus.longitude,
});

const toLiveBus = (location: LiveBusLocation, now = Date.now()): LiveBus => {
  return {
    busId: location.busId,
    sourceId: location.sourceId,
    sourceType: location.sourceType,
    routeId: location.routeId,
    routeVariantId: location.routeVariantId,
    routeVariantDirection: location.routeVariantDirection,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    speed: location.speed,
    heading: location.heading,
    timestamp: location.timestamp,
    updatedAt: location.updatedAt,
    routeProgressMeters: location.routeProgressMeters,
    snappedLatitude: location.snappedLatitude,
    snappedLongitude: location.snappedLongitude,
    distanceFromRouteMeters: location.distanceFromRouteMeters,
    avgSpeedMps: location.avgSpeedMps,
    isStopped: location.isStopped,
    directionConfidence: location.directionConfidence,
    etaConfidence: location.etaConfidence,
    isStale: isLocationStale(location, now),
  };
};

const filterStale = (buses: LiveBus[], includeStale: boolean): LiveBus[] => {
  return includeStale ? buses : buses.filter((bus) => !bus.isStale);
};

const mergeLocationsByNewestUpdate = (
  locations: LiveBusLocation[],
): LiveBusLocation[] => {
  const merged = new Map<string, LiveBusLocation>();

  for (const location of locations) {
    const current = merged.get(location.busId);

    if (!current || location.updatedAt >= current.updatedAt) {
      merged.set(location.busId, location);
    }
  }

  return Array.from(merged.values());
};

const putLocationsInMemory = (locations: LiveBusLocation[]) => {
  for (const location of locations) {
    const current = locationsByBusId.get(location.busId);

    if (!current || location.updatedAt >= current.updatedAt) {
      locationsByBusId.set(location.busId, location);
    }
  }
};

export const locationsService = {
  updateLocation(payload: LocationUpdateRequest): LiveBusLocation {
    const updatedAt = Date.now();
    const history = pruneHistory(busLocationHistory.get(payload.busId) ?? [], updatedAt);
    const routeSnap = routeGeometryService.snapPointToRoute(payload.routeVariantId, {
      latitude: payload.latitude,
      longitude: payload.longitude,
    });

    const storedLocation: LiveBusLocation = {
      ...payload,
      updatedAt,
      routeProgressMeters: routeSnap?.progressMeters,
      snappedLatitude: routeSnap?.latitude,
      snappedLongitude: routeSnap?.longitude,
      distanceFromRouteMeters: routeSnap?.distanceFromRouteMeters,
    };

    storedLocation.avgSpeedMps = calculateAverageSpeedMps(storedLocation, history);
    storedLocation.isStopped = storedLocation.avgSpeedMps < 0.7;
    storedLocation.directionConfidence = calculateDirectionConfidence(storedLocation, history);

    if (
      storedLocation.distanceFromRouteMeters !== undefined &&
      storedLocation.distanceFromRouteMeters > offRouteLowConfidenceThresholdMeters
    ) {
      storedLocation.directionConfidence = "low";
      storedLocation.etaConfidence = "low";
    } else {
      storedLocation.etaConfidence = calculateEtaConfidence(storedLocation);
    }

    locationsByBusId.set(payload.busId, storedLocation);
    busLocationHistory.set(
      payload.busId,
      pruneHistory([...history, storedLocation], updatedAt),
    );

    return storedLocation;
  },

  async hydrateFromRedis(): Promise<number> {
    const redisLocations = await getLiveBusLocations();
    putLocationsInMemory(redisLocations);
    console.log("[locations] Hydrated live buses from Redis", {
      count: redisLocations.length,
    });
    return redisLocations.length;
  },

  async getLiveBuses(includeStale = false): Promise<LiveBus[]> {
    const now = Date.now();
    const redisLocations = await getLiveBusLocations();
    putLocationsInMemory(redisLocations);

    const locations = mergeLocationsByNewestUpdate(
      Array.from(locationsByBusId.values()).concat(redisLocations),
    );
    const buses = locations.map((location) => toLiveBus(location, now));

    return filterStale(buses, includeStale);
  },

  async getLiveBusesByRouteVariant(
    routeVariantId: string,
    includeStale = false,
  ): Promise<LiveBus[]> {
    const now = Date.now();
    const redisLocations = await getLiveBusLocations();
    putLocationsInMemory(redisLocations);

    const buses = mergeLocationsByNewestUpdate(
      Array.from(locationsByBusId.values()).concat(redisLocations),
    )
      .filter((location) => location.routeVariantId === routeVariantId)
      .map((location) => toLiveBus(location, now));

    return filterStale(buses, includeStale);
  },

  async getEtaForRouteVariant(
    routeVariantId: string,
    userPoint: { latitude: number; longitude: number },
    destinationPoint: { latitude: number; longitude: number } | undefined,
    includeStale = false,
  ) {
    routeGeometryService.requireRouteGeometry(routeVariantId);

    const userSnap = routeGeometryService.snapPointToRoute(routeVariantId, userPoint);
    const destinationSnap = destinationPoint
      ? routeGeometryService.snapPointToRoute(routeVariantId, destinationPoint)
      : undefined;

    if (!userSnap) {
      return {
        routeVariantId,
        user: {
          ...userPoint,
          progressMeters: undefined,
          snappedLatitude: undefined,
          snappedLongitude: undefined,
        },
        destination: undefined,
        buses: [] as EtaBus[],
      };
    }

    const destinationIsAhead =
      destinationSnap === undefined || userSnap.progressMeters < destinationSnap.progressMeters;

    const buses = (await this.getLiveBusesByRouteVariant(routeVariantId, includeStale))
      .map((bus): EtaBus => {
        const hasProgress = bus.routeProgressMeters !== undefined;
        const busProgress = bus.routeProgressMeters ?? userSnap.progressMeters;
        const busIsFarFromRoute =
          bus.distanceFromRouteMeters !== undefined &&
          bus.distanceFromRouteMeters > offRouteLowConfidenceThresholdMeters;
        const rawDistanceToUserMeters = userSnap.progressMeters - busProgress;
        const routeDistanceToUserMeters = Math.abs(rawDistanceToUserMeters);
        const gpsDistanceToUserMeters = haversineDistanceMeters(busPoint(bus), userPoint);
        const distanceToUserMeters = !hasProgress || busIsFarFromRoute
          ? gpsDistanceToUserMeters
          : routeDistanceToUserMeters;
        const avgSpeedMps = isSpeedUsableForEta(bus.avgSpeedMps)
          ? bus.avgSpeedMps
          : defaultUrbanBusSpeedMps;
        const hasUsableSpeed = isSpeedUsableForEta(bus.avgSpeedMps);
        const etaToUserSeconds = Math.round(distanceToUserMeters / avgSpeedMps);
        const etaUserToDestinationSeconds =
          destinationSnap && destinationIsAhead
            ? Math.round((destinationSnap.progressMeters - userSnap.progressMeters) / avgSpeedMps)
            : undefined;

        let reason: EtaBus["reason"];

        if (!hasProgress) {
          reason = "insufficient_data";
        } else if (busIsFarFromRoute) {
          reason = "far_from_route";
        } else if (busProgress >= userSnap.progressMeters) {
          reason = "passed_user";
        } else if (!destinationIsAhead) {
          reason = "opposite_direction";
        } else if (!hasUsableSpeed) {
          reason = "insufficient_speed_data";
        } else if (bus.directionConfidence === "low") {
          reason = "opposite_direction";
        }

        const isViable = reason === undefined;
        const etaConfidence: Confidence = isViable ? bus.etaConfidence ?? "medium" : "low";
        const directionConfidence: Confidence = isViable
          ? bus.directionConfidence ?? "medium"
          : "low";

        return {
          ...bus,
          directionConfidence,
          etaConfidence,
          distanceToUserMeters: Math.round(distanceToUserMeters),
          etaToUserSeconds,
          etaToUserMinutes: Math.ceil(etaToUserSeconds / 60),
          etaUserToDestinationSeconds,
          etaUserToDestinationMinutes:
            etaUserToDestinationSeconds === undefined
              ? undefined
              : Math.ceil(etaUserToDestinationSeconds / 60),
          isViable,
          reason,
        };
      })
      .sort((a, b) => a.etaToUserSeconds - b.etaToUserSeconds);

    return {
      routeVariantId,
      user: {
        latitude: userPoint.latitude,
        longitude: userPoint.longitude,
        progressMeters: Math.round(userSnap.progressMeters),
        snappedLatitude: userSnap.latitude,
        snappedLongitude: userSnap.longitude,
      },
      destination:
        destinationSnap === undefined
          ? undefined
          : {
              latitude: destinationPoint?.latitude,
              longitude: destinationPoint?.longitude,
              progressMeters: Math.round(destinationSnap.progressMeters),
              snappedLatitude: destinationSnap.latitude,
              snappedLongitude: destinationSnap.longitude,
            },
      buses,
    };
  },
};
