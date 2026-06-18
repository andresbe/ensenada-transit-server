import fs from "fs/promises";
import path from "path";
import { Request } from "express";
import { routeGeometryService } from "../modules/routes/routeGeometry.service";
import { LiveBusLocation, LocationUpdateRequest } from "../modules/locations/locations.types";

type RawPayload = Record<string, unknown>;

interface CadenceState {
  receivedAtMs: number;
  source?: string;
  routeVariantId?: string;
}

export interface LocationDiagnosticContext {
  receivedAt: string;
  receivedAtMs: number;
  serverTimestamp: number;
  source?: string;
  driverId?: unknown;
  previousReceivedAt?: string;
  gapSeconds?: number;
  previousSource?: string;
  previousRouteVariantId?: string;
  sourceChanged: boolean;
  routeVariantChanged: boolean;
  routeTotalDistanceMeters?: number;
}

export interface LocationDebugSummary {
  receivedAt: string;
  busId?: string;
  routeId?: string;
  routeVariantId?: string;
  routeVariantDirection?: string;
  source?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  clientTimestamp?: number;
  gapSeconds?: number;
  routeProgressMeters?: number | null;
  routeTotalDistanceMeters?: number | null;
  progressRemainingMeters?: number | null;
  progressRatio?: number | null;
  progressPercent?: number | null;
  distanceFromRouteMeters?: number | null;
  directionConfidence?: string;
  etaConfidence?: string;
  tripPhase?: string;
  shouldSwitchVariant?: unknown;
  nextRouteVariantId?: unknown;
  nextRouteVariantDirection?: unknown;
}

const cadenceByBusId = new Map<string, CadenceState>();
const recentUpdates: LocationDebugSummary[] = [];
const maxRecentUpdates = 200;

const toIso = (timestampMs: number): string => new Date(timestampMs).toISOString();

const asObject = (value: unknown): RawPayload => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawPayload)
    : {};
};

const asString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const asNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const getSource = (body: RawPayload, payload?: LocationUpdateRequest): string | undefined => {
  return asString(body.source) ?? asString(body.appState) ?? payload?.sourceType;
};

const getRequestIp = (req: Request): string | undefined => {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim() !== "") {
    return forwardedFor.split(",")[0]?.trim();
  }

  return req.ip || req.socket.remoteAddress;
};

const getUserAgent = (req: Request): string | undefined => {
  const userAgent = req.headers["user-agent"];
  return typeof userAgent === "string" ? userAgent : undefined;
};

const writeJsonLine = (entry: Record<string, unknown>) => {
  const locationLogFile = process.env.LOCATION_LOG_FILE;

  if (!locationLogFile) {
    return;
  }

  const filePath = path.resolve(process.cwd(), locationLogFile);
  const line = `${JSON.stringify(entry)}\n`;

  fs.mkdir(path.dirname(filePath), { recursive: true })
    .then(() => fs.appendFile(filePath, line, "utf8"))
    .catch((error) => {
      console.error("[location-diagnostics] Failed to append location log file:", error);
    });
};

export const logLocationDiagnostic = (entry: Record<string, unknown>) => {
  const normalizedEntry = {
    loggedAt: new Date().toISOString(),
    ...entry,
  };
  const line = JSON.stringify(normalizedEntry);

  if (entry.event === "location_update_warning") {
    console.warn(line);
  } else if (
    entry.event === "location_update_validation_error" ||
    entry.event === "location_update_server_error"
  ) {
    console.error(line);
  } else {
    console.log(line);
  }

  writeJsonLine(normalizedEntry);
};

const pushRecentUpdate = (summary: LocationDebugSummary) => {
  recentUpdates.push(summary);

  if (recentUpdates.length > maxRecentUpdates) {
    recentUpdates.splice(0, recentUpdates.length - maxRecentUpdates);
  }
};

const logWarning = (
  warningType: string,
  payload: LocationUpdateRequest,
  context: LocationDiagnosticContext,
  extra: Record<string, unknown> = {},
) => {
  logLocationDiagnostic({
    event: "location_update_warning",
    warningType,
    busId: payload.busId,
    routeId: payload.routeId,
    routeVariantId: payload.routeVariantId,
    source: context.source,
    ...extra,
  });
};

export const recordLocationUpdateReceived = (
  req: Request,
  payload: LocationUpdateRequest,
): LocationDiagnosticContext => {
  const body = asObject(req.body);
  const receivedAtMs = Date.now();
  const receivedAt = toIso(receivedAtMs);
  const previous = cadenceByBusId.get(payload.busId);
  const source = getSource(body, payload);
  const previousSource = previous?.source;
  const previousRouteVariantId = previous?.routeVariantId;
  const gapSeconds =
    previous === undefined ? undefined : (receivedAtMs - previous.receivedAtMs) / 1000;
  const sourceChanged =
    previousSource !== undefined && source !== undefined && previousSource !== source;
  const routeVariantChanged =
    previousRouteVariantId !== undefined &&
    previousRouteVariantId !== payload.routeVariantId;
  const routeTotalDistanceMeters = routeGeometryService.getRouteGeometry(
    payload.routeVariantId,
  )?.totalDistanceMeters;
  const context: LocationDiagnosticContext = {
    receivedAt,
    receivedAtMs,
    serverTimestamp: receivedAtMs,
    source,
    driverId: body.driverId,
    previousReceivedAt: previous ? toIso(previous.receivedAtMs) : undefined,
    gapSeconds,
    previousSource,
    previousRouteVariantId,
    sourceChanged,
    routeVariantChanged,
    routeTotalDistanceMeters,
  };

  logLocationDiagnostic({
    event: "location_update_received",
    receivedAt,
    source,
    sourceId: payload.sourceId,
    driverId: body.driverId,
    sourceType: payload.sourceType,
    busId: payload.busId,
    routeId: payload.routeId,
    routeVariantId: payload.routeVariantId,
    routeVariantDirection: payload.routeVariantDirection,
    latitude: payload.latitude,
    longitude: payload.longitude,
    accuracy: payload.accuracy,
    speed: payload.speed,
    heading: payload.heading,
    clientTimestamp: payload.timestamp,
    serverTimestamp: receivedAtMs,
    clientServerSkewMs: receivedAtMs - payload.timestamp,
    requestIp: getRequestIp(req),
    userAgent: getUserAgent(req),
    previousReceivedAt: context.previousReceivedAt,
    gapSeconds,
    previousSource,
    previousRouteVariantId,
    sourceChanged,
    routeVariantChanged,
  });

  if (!previous) {
    logWarning("first_update_for_bus", payload, context);
  }

  if (gapSeconds !== undefined && gapSeconds > 30) {
    logWarning("gap_gt_30_seconds", payload, context, { gapSeconds });
  }

  if (gapSeconds !== undefined && gapSeconds > 60) {
    logWarning("gap_gt_60_seconds", payload, context, { gapSeconds });
  }

  if (gapSeconds !== undefined && gapSeconds > 120) {
    logWarning("gap_gt_120_seconds", payload, context, { gapSeconds });
  }

  if (payload.accuracy === undefined) {
    logWarning("accuracy_missing", payload, context);
  } else if (payload.accuracy > 100) {
    logWarning("accuracy_gt_100_meters", payload, context, {
      accuracy: payload.accuracy,
    });
  }

  if (payload.speed === undefined) {
    logWarning("speed_missing", payload, context, { speed: payload.speed });
  }

  if (payload.heading === undefined) {
    logWarning("heading_missing", payload, context, { heading: payload.heading });
  }

  if (sourceChanged) {
    logWarning("source_changed", payload, context, {
      previousSource,
      source,
    });
  }

  if (routeVariantChanged) {
    logWarning("route_variant_changed", payload, context, {
      previousRouteVariantId,
      routeVariantId: payload.routeVariantId,
    });
  }

  cadenceByBusId.set(payload.busId, {
    receivedAtMs,
    source,
    routeVariantId: payload.routeVariantId,
  });

  return context;
};

export const recordLocationUpdateSuccess = (
  payload: LocationUpdateRequest,
  location: LiveBusLocation,
  context: LocationDiagnosticContext,
  elapsedMs: number,
) => {
  const summary: LocationDebugSummary = {
    receivedAt: context.receivedAt,
    busId: payload.busId,
    routeId: payload.routeId,
    routeVariantId: payload.routeVariantId,
    routeVariantDirection: payload.routeVariantDirection,
    source: context.source,
    latitude: payload.latitude,
    longitude: payload.longitude,
    accuracy: payload.accuracy,
    speed: payload.speed,
    heading: payload.heading,
    clientTimestamp: payload.timestamp,
    gapSeconds: context.gapSeconds,
    routeProgressMeters: location.routeProgressMeters,
    routeTotalDistanceMeters: location.routeTotalDistanceMeters,
    progressRemainingMeters: location.progressRemainingMeters,
    progressRatio: location.progressRatio,
    progressPercent: location.progressPercent,
    distanceFromRouteMeters: location.distanceFromRouteMeters,
    directionConfidence: location.directionConfidence,
    etaConfidence: location.etaConfidence,
    tripPhase: location.tripPhase,
    shouldSwitchVariant: undefined,
    nextRouteVariantId: undefined,
    nextRouteVariantDirection: undefined,
  };

  pushRecentUpdate(summary);

  logLocationDiagnostic({
    event: "location_update_success",
    busId: payload.busId,
    routeId: payload.routeId,
    routeVariantId: payload.routeVariantId,
    routeVariantDirection: payload.routeVariantDirection,
    source: context.source,
    elapsedMs,
    gapSeconds: context.gapSeconds,
    routeProgressMeters: location.routeProgressMeters,
    routeTotalDistanceMeters: location.routeTotalDistanceMeters,
    progressRemainingMeters: location.progressRemainingMeters,
    progressRatio: location.progressRatio,
    progressPercent: location.progressPercent,
    distanceFromRouteMeters: location.distanceFromRouteMeters,
    directionConfidence: location.directionConfidence,
    etaConfidence: location.etaConfidence,
    tripPhase: location.tripPhase,
    shouldSwitchVariant: undefined,
    nextRouteVariantId: undefined,
    nextRouteVariantDirection: undefined,
  });
};

export const recordLocationUpdateValidationError = (
  req: Request,
  error: unknown,
  statusCode: number,
) => {
  const body = asObject(req.body);

  logLocationDiagnostic({
    event: "location_update_validation_error",
    busId: asString(body.busId),
    routeId: asString(body.routeId),
    source: getSource(body),
    statusCode,
    errorMessage: error instanceof Error ? error.message : "Validation error",
    payloadKeys: Object.keys(body),
  });
};

export const recordLocationUpdateServerError = (
  req: Request,
  error: unknown,
  statusCode: number,
) => {
  const body = asObject(req.body);
  const errorMessage = error instanceof Error ? error.message : "Internal server error";

  logLocationDiagnostic({
    event: "location_update_server_error",
    busId: asString(body.busId),
    routeId: asString(body.routeId),
    source: getSource(body),
    statusCode,
    errorMessage,
    stack:
      process.env.NODE_ENV === "development" && error instanceof Error
        ? error.stack
        : undefined,
  });
};

export const getRecentLocationUpdates = (): LocationDebugSummary[] => {
  return [...recentUpdates];
};
