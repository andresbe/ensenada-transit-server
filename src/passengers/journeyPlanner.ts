import { findNearestPointOnPolyline, haversineDistanceMeters, type GeoPoint } from "../shared/geo/geometry";
import { AppError } from "../shared/errors";
import type { LiveBus } from "../modules/locations/locations.types";

export type PlanStop = GeoPoint & { id: string; name: string; sequence: number };
// Planning assumption, not a measured user speed or a pedestrian-routing result.
const walkingSpeedMetersPerSecond = 1.2;
export function walkingMinutes(distanceMeters: number) {
  return Math.ceil(distanceMeters / walkingSpeedMetersPerSecond / 60);
}
export type PlanVariant = {
  route_id: string; id: string; name: string; direction: "ida" | "vuelta";
  route_name: string; short_name: string; color: string;
  coordinates: [number, number][]; stops: PlanStop[];
  operating_hours?: { start: string; end: string } | null;
};
export function parsePlanInput(body: unknown) {
  const b = body as Record<string, unknown> | null;
  const point = (value: unknown): GeoPoint => {
    const p = value as GeoPoint | null;
    if (!p || typeof p.latitude !== "number" || typeof p.longitude !== "number" || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) throw new AppError("Valid origin and destination coordinates are required.", 400);
    return { latitude: p.latitude, longitude: p.longitude };
  };
  if (!b || (b.maxWalkingMeters !== undefined && b.maxWalkingMeters !== 800 && b.maxWalkingMeters !== 1500)) throw new AppError("Walking limit must be 800 or 1500 meters.", 400);
  return { origin: point(b.origin), destination: point(b.destination), maxWalkingMeters: (b.maxWalkingMeters ?? 800) as number };
}
function operating(hours: PlanVariant["operating_hours"], now: number) {
  if (!hours) return true;
  if (!/^\d{2}:\d{2}$/.test(hours.start) || !/^\d{2}:\d{2}$/.test(hours.end)) return false;
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tijuana", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
  return hours.start <= hours.end ? local >= hours.start && local <= hours.end : local >= hours.start || local <= hours.end;
}

export function planDirectRoutes(input: ReturnType<typeof parsePlanInput>, variants: PlanVariant[], buses: LiveBus[], now = Date.now()) {
  const candidates = variants.flatMap(variant => {
    if (!operating(variant.operating_hours, now) || variant.coordinates.length < 2) return [];
    const geometry = variant.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }));
    const stops = variant.stops.map(s => ({ ...s, latitude: Number(s.latitude), longitude: Number(s.longitude), sequence: Number(s.sequence) }));
    const near = (p: GeoPoint) => stops.map(stop => ({ stop, distance: haversineDistanceMeters(p, stop) }))
      .filter(s => s.distance <= input.maxWalkingMeters).sort((a, b) => a.distance - b.distance).slice(0, 12)
      .map(s => ({ ...s, projection: findNearestPointOnPolyline(s.stop, geometry) }))
      .filter(s => s.projection.distanceFromRouteMeters <= 100);
    const boards = near(input.origin), exits = near(input.destination);
    const pairs = boards.flatMap(board => exits.filter(exit => exit.stop.id !== board.stop.id && exit.stop.sequence > board.stop.sequence && exit.projection.progressMeters > board.projection.progressMeters + 20)
      .map(exit => ({ board, exit, ride: exit.projection.progressMeters - board.projection.progressMeters, score: board.distance + exit.distance + (exit.projection.progressMeters - board.projection.progressMeters) * 0.05 })));
    const best = pairs.sort((a, b) => a.score - b.score)[0];
    if (!best) return [];
    const live = buses.filter(bus => bus.routeId === variant.route_id && bus.routeVariantId === variant.id && !bus.isStale && now - bus.timestamp <= 60000 && bus.timestamp <= now + 10000);
    const arrivals = live.filter(bus => ["medium", "high"].includes(bus.directionConfidence ?? "") && !bus.isStopped && typeof bus.avgSpeedMps === "number" && bus.avgSpeedMps >= 1 && bus.avgSpeedMps <= 35)
      .map(bus => ({ bus, projection: findNearestPointOnPolyline(bus, geometry) }))
      .filter(({ projection }) => projection.distanceFromRouteMeters <= 100 && projection.progressMeters <= best.board.projection.progressMeters)
      .map(({ bus, projection }) => ({ busId: bus.busId, minutes: Math.max(1, Math.ceil((best.board.projection.progressMeters - projection.progressMeters) / bus.avgSpeedMps! / 60)) }))
      .sort((a, b) => a.minutes - b.minutes);
    return [{
      id: variant.id, routeId: variant.route_id, variantId: variant.id, direction: variant.direction,
      routeName: variant.route_name, shortName: variant.short_name, variantName: variant.name, color: variant.color,
      boardingStop: best.board.stop, exitStop: best.exit.stop,
      originWalkMeters: Math.ceil(best.board.distance), destinationWalkMeters: Math.ceil(best.exit.distance),
      rideDistanceMeters: Math.round(best.ride), walkingDistanceType: "straight_line" as const,
      activeBuses: live.length, arrival: arrivals[0] ?? null, scheduleKnown: !!variant.operating_hours, score: best.score,
    }];
  }).sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return candidates.filter(plan => { if (seen.has(plan.routeId)) return false; seen.add(plan.routeId); return true; }).slice(0, 5).map(({ score, ...plan }) => plan);
}

// Geometry matches describe coverage, never an unregistered boarding location.
export function recommendRoutes(input: ReturnType<typeof parsePlanInput>, variants: PlanVariant[], buses: LiveBus[], now = Date.now()) {
  const candidates = variants.map(variant => {
    if (!operating(variant.operating_hours, now) || variant.coordinates.length < 2) return [];
    if (!variant.coordinates.every(p => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) return [];
    const geometry = variant.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }));
    const destination = findNearestPointOnPolyline(input.destination, geometry);
    if (destination.distanceFromRouteMeters > input.maxWalkingMeters) return [];
    const origin = findNearestPointOnPolyline(input.origin, geometry);
    const direct = planDirectRoutes(input, [variant], buses, now)[0];
    const proximity = {
      destinationRouteDistanceMeters: Math.ceil(destination.distanceFromRouteMeters),
      closestDestinationPoint: { latitude: destination.latitude, longitude: destination.longitude },
      destinationWalkMinutes: walkingMinutes(direct?.destinationWalkMeters ?? destination.distanceFromRouteMeters),
      originWalkMinutes: direct ? walkingMinutes(direct.originWalkMeters) : null,
      walkingTimeBasis: "straight_line_estimate" as const,
      walkingSpeedMetersPerSecond,
    };
    if (direct) return [{ ...direct, ...proximity, matchType: "direct" as const, reason: null }];
    const reason = origin.distanceFromRouteMeters > input.maxWalkingMeters ? "origin_far" as const
      : destination.progressMeters <= origin.progressMeters + 20 ? "direction_unconfirmed" as const : "stops_unconfirmed" as const;
    return [{
      id: variant.id, routeId: variant.route_id, variantId: variant.id, direction: variant.direction,
      routeName: variant.route_name, shortName: variant.short_name, variantName: variant.name, color: variant.color,
      ...proximity, matchType: "near_destination" as const, reason,
      boardingStop: null, exitStop: null, originWalkMeters: null, destinationWalkMeters: null, rideDistanceMeters: null,
      walkingDistanceType: "straight_line" as const, arrival: null, scheduleKnown: !!variant.operating_hours,
      activeBuses: buses.filter(bus => bus.routeId === variant.route_id && bus.routeVariantId === variant.id && !bus.isStale && now - bus.timestamp <= 60000 && bus.timestamp <= now + 10000).length,
    }];
  }).flat();
  candidates.sort((a, b) => Number(b.matchType === "direct") - Number(a.matchType === "direct")
    || a.destinationRouteDistanceMeters - b.destinationRouteDistanceMeters
    || (a.originWalkMeters ?? Infinity) - (b.originWalkMeters ?? Infinity)
    || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return candidates.filter(plan => { if (seen.has(plan.routeId)) return false; seen.add(plan.routeId); return true; }).slice(0, 5);
}
