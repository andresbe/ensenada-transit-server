import { createHash } from "crypto";
import { parseRouteGeoJson } from "../routes/geojson";
import {
  findNearestPointOnPolyline,
  GeoPoint,
  haversineDistanceMeters,
} from "../shared/geo/geometry";
import type {
  Confidence,
  RouteVariantDirection,
} from "../modules/locations/locations.types";

export interface HardwareDirectionVariant {
  id: string;
  routeId: string;
  direction: RouteVariantDirection;
  points: GeoPoint[];
  totalDistanceMeters: number;
  updatedAt: string;
}

export interface HardwareDirectionVariantInput {
  id: string;
  routeId: string;
  direction: RouteVariantDirection;
  coordinates: unknown;
  updatedAt: string | Date;
}

export interface HardwareDirectionObservation extends GeoPoint {
  timestamp: number;
  speedMps?: number;
  heading?: number;
  satellites?: number;
  hdop?: number;
}

export interface HardwareDirectionContext {
  assignmentId: string;
  routeId: string;
  assignedRouteVariantId: string;
  geometryFingerprint: string;
}

export interface HardwareDirectionAnchor extends GeoPoint {
  timestamp: number;
  progressByVariant: Record<string, number>;
}

export interface HardwareDirectionState extends HardwareDirectionContext {
  detectedRouteVariantId?: string;
  candidateRouteVariantId?: string;
  consecutiveEvidenceCount: number;
  candidateStartedAt?: number;
  candidateLastEvidenceAt?: number;
  candidateDisplacementMeters: number;
  strongEvidenceCount: number;
  terminalEvidence: boolean;
  lastConfirmedAt?: number;
  lastObservationAt?: number;
  motionAnchor?: HardwareDirectionAnchor;
  detectionConfidence: Confidence;
  lastReason: string;
}

export interface HardwareDirectionConfig {
  minDisplacementMeters: number;
  minProgressMeters: number;
  maxRouteDistanceMeters: number;
  strongRouteDistanceMeters: number;
  routeDistanceAdvantageMeters: number;
  maxBearingErrorDegrees: number;
  maxJumpSpeedMps: number;
  maxObservationGapSeconds: number;
  stationarySpeedMps: number;
  stationaryDriftMeters: number;
  initialEvidenceCount: number;
  initialDistanceMeters: number;
  switchEvidenceCount: number;
  switchDistanceMeters: number;
  terminalSwitchDistanceMeters: number;
  minEvidenceDurationSeconds: number;
  minSwitchDurationSeconds: number;
  terminalRadiusMeters: number;
  candidateEvidenceGapSeconds: number;
  minStrongEvidenceCount: number;
  minScoreMargin: number;
  maxHdop: number;
}

export const defaultHardwareDirectionConfig: HardwareDirectionConfig = {
  minDisplacementMeters: 15,
  minProgressMeters: 10,
  maxRouteDistanceMeters: 100,
  strongRouteDistanceMeters: 45,
  routeDistanceAdvantageMeters: 30,
  maxBearingErrorDegrees: 70,
  maxJumpSpeedMps: 45,
  maxObservationGapSeconds: 600,
  stationarySpeedMps: 0.7,
  stationaryDriftMeters: 45,
  initialEvidenceCount: 3,
  initialDistanceMeters: 60,
  switchEvidenceCount: 5,
  switchDistanceMeters: 300,
  terminalSwitchDistanceMeters: 60,
  minEvidenceDurationSeconds: 20,
  minSwitchDurationSeconds: 90,
  terminalRadiusMeters: 200,
  candidateEvidenceGapSeconds: 300,
  minStrongEvidenceCount: 3,
  minScoreMargin: 2,
  maxHdop: 5,
};

const numericSetting = (
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
};

const integerSetting = (
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = numericSetting(source, name, fallback, minimum, maximum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
};

export function hardwareDirectionConfigFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): HardwareDirectionConfig {
  const config: HardwareDirectionConfig = {
    ...defaultHardwareDirectionConfig,
    minDisplacementMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_MIN_DISPLACEMENT_METERS",
      defaultHardwareDirectionConfig.minDisplacementMeters,
      5,
      100,
    ),
    minProgressMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_MIN_PROGRESS_METERS",
      defaultHardwareDirectionConfig.minProgressMeters,
      3,
      100,
    ),
    maxRouteDistanceMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_MAX_ROUTE_DISTANCE_METERS",
      defaultHardwareDirectionConfig.maxRouteDistanceMeters,
      20,
      500,
    ),
    strongRouteDistanceMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_STRONG_ROUTE_DISTANCE_METERS",
      defaultHardwareDirectionConfig.strongRouteDistanceMeters,
      5,
      250,
    ),
    routeDistanceAdvantageMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_ROUTE_ADVANTAGE_METERS",
      defaultHardwareDirectionConfig.routeDistanceAdvantageMeters,
      5,
      250,
    ),
    maxBearingErrorDegrees: numericSetting(
      source,
      "HARDWARE_DIRECTION_MAX_BEARING_ERROR_DEGREES",
      defaultHardwareDirectionConfig.maxBearingErrorDegrees,
      20,
      120,
    ),
    maxJumpSpeedMps: numericSetting(
      source,
      "HARDWARE_DIRECTION_MAX_JUMP_SPEED_MPS",
      defaultHardwareDirectionConfig.maxJumpSpeedMps,
      15,
      100,
    ),
    maxObservationGapSeconds: numericSetting(
      source,
      "HARDWARE_DIRECTION_MAX_OBSERVATION_GAP_SECONDS",
      defaultHardwareDirectionConfig.maxObservationGapSeconds,
      60,
      3600,
    ),
    stationarySpeedMps: numericSetting(
      source,
      "HARDWARE_DIRECTION_STATIONARY_SPEED_MPS",
      defaultHardwareDirectionConfig.stationarySpeedMps,
      0,
      3,
    ),
    stationaryDriftMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_STATIONARY_DRIFT_METERS",
      defaultHardwareDirectionConfig.stationaryDriftMeters,
      10,
      150,
    ),
    initialEvidenceCount: integerSetting(
      source,
      "HARDWARE_DIRECTION_INITIAL_OBSERVATIONS",
      defaultHardwareDirectionConfig.initialEvidenceCount,
      2,
      10,
    ),
    initialDistanceMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_INITIAL_DISTANCE_METERS",
      defaultHardwareDirectionConfig.initialDistanceMeters,
      20,
      1000,
    ),
    switchEvidenceCount: integerSetting(
      source,
      "HARDWARE_DIRECTION_SWITCH_OBSERVATIONS",
      defaultHardwareDirectionConfig.switchEvidenceCount,
      3,
      12,
    ),
    switchDistanceMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_SWITCH_DISTANCE_METERS",
      defaultHardwareDirectionConfig.switchDistanceMeters,
      50,
      2000,
    ),
    terminalSwitchDistanceMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_TERMINAL_SWITCH_DISTANCE_METERS",
      defaultHardwareDirectionConfig.terminalSwitchDistanceMeters,
      20,
      1000,
    ),
    minEvidenceDurationSeconds: numericSetting(
      source,
      "HARDWARE_DIRECTION_MIN_EVIDENCE_DURATION_SECONDS",
      defaultHardwareDirectionConfig.minEvidenceDurationSeconds,
      0,
      600,
    ),
    minSwitchDurationSeconds: numericSetting(
      source,
      "HARDWARE_DIRECTION_MIN_SWITCH_DURATION_SECONDS",
      defaultHardwareDirectionConfig.minSwitchDurationSeconds,
      0,
      1200,
    ),
    terminalRadiusMeters: numericSetting(
      source,
      "HARDWARE_DIRECTION_TERMINAL_RADIUS_METERS",
      defaultHardwareDirectionConfig.terminalRadiusMeters,
      50,
      1000,
    ),
    candidateEvidenceGapSeconds: numericSetting(
      source,
      "HARDWARE_DIRECTION_CANDIDATE_GAP_SECONDS",
      defaultHardwareDirectionConfig.candidateEvidenceGapSeconds,
      30,
      1800,
    ),
    minStrongEvidenceCount: integerSetting(
      source,
      "HARDWARE_DIRECTION_MIN_STRONG_OBSERVATIONS",
      defaultHardwareDirectionConfig.minStrongEvidenceCount,
      1,
      12,
    ),
    minScoreMargin: integerSetting(
      source,
      "HARDWARE_DIRECTION_MIN_SCORE_MARGIN",
      defaultHardwareDirectionConfig.minScoreMargin,
      0,
      8,
    ),
    maxHdop: numericSetting(
      source,
      "HARDWARE_DIRECTION_MAX_HDOP",
      defaultHardwareDirectionConfig.maxHdop,
      1,
      20,
    ),
  };
  if (config.strongRouteDistanceMeters > config.maxRouteDistanceMeters) {
    throw new Error(
      "HARDWARE_DIRECTION_STRONG_ROUTE_DISTANCE_METERS cannot exceed HARDWARE_DIRECTION_MAX_ROUTE_DISTANCE_METERS.",
    );
  }
  if (config.minStrongEvidenceCount > config.switchEvidenceCount) {
    throw new Error(
      "HARDWARE_DIRECTION_MIN_STRONG_OBSERVATIONS cannot exceed HARDWARE_DIRECTION_SWITCH_OBSERVATIONS.",
    );
  }
  return config;
}

export function createHardwareDirectionVariant(
  input: HardwareDirectionVariantInput,
): HardwareDirectionVariant {
  const parsed = parseRouteGeoJson({
    type: "LineString",
    coordinates: input.coordinates,
  });
  const points = parsed.coordinates.map(([longitude, latitude]) => ({
    latitude,
    longitude,
  }));
  return {
    id: input.id,
    routeId: input.routeId,
    direction: input.direction,
    points,
    totalDistanceMeters: parsed.distance,
    updatedAt: new Date(input.updatedAt).toISOString(),
  };
}

export function hardwareDirectionGeometryFingerprint(
  variants: HardwareDirectionVariant[],
): string {
  const canonical = [...variants]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((variant) => ({
      id: variant.id,
      routeId: variant.routeId,
      direction: variant.direction,
      points: variant.points,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;
const normalizedBearing = (value: number) => ((value % 360) + 360) % 360;

export function bearingDegrees(from: GeoPoint, to: GeoPoint): number {
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x = Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);
  return normalizedBearing(degrees(Math.atan2(y, x)));
}

export function bearingDifferenceDegrees(left: number, right: number): number {
  const difference = Math.abs(normalizedBearing(left) - normalizedBearing(right));
  return Math.min(difference, 360 - difference);
}

export interface HardwareDirectionVariantMetrics {
  routeVariantId: string;
  direction: RouteVariantDirection;
  progressMeters: number;
  progressDeltaMeters: number | null;
  distanceFromRouteMeters: number;
  expectedBearing: number;
  bearingErrorDegrees: number | null;
  score: number;
  supportsMovement: boolean;
  strongEvidence: boolean;
}

export interface HardwareDirectionEvaluation {
  state: HardwareDirectionState;
  acceptedObservation: boolean;
  switched: boolean;
  reason: string;
  movementBearing?: number;
  displacementMeters?: number;
  elapsedSeconds?: number;
  metrics: Record<string, HardwareDirectionVariantMetrics>;
}

export function initialHardwareDirectionState(
  context: HardwareDirectionContext,
  reason = "state_initialized",
): HardwareDirectionState {
  return {
    ...context,
    consecutiveEvidenceCount: 0,
    candidateDisplacementMeters: 0,
    strongEvidenceCount: 0,
    terminalEvidence: false,
    detectionConfidence: "low",
    lastReason: reason,
  };
}

const copyState = (state: HardwareDirectionState): HardwareDirectionState => ({
  ...state,
  motionAnchor: state.motionAnchor
    ? {
        ...state.motionAnchor,
        progressByVariant: { ...state.motionAnchor.progressByVariant },
      }
    : undefined,
});

const sameContext = (
  state: HardwareDirectionState,
  context: HardwareDirectionContext,
) => state.assignmentId === context.assignmentId &&
  state.routeId === context.routeId &&
  state.assignedRouteVariantId === context.assignedRouteVariantId &&
  state.geometryFingerprint === context.geometryFingerprint;

const validCoordinate = (observation: HardwareDirectionObservation) =>
  Number.isFinite(observation.latitude) &&
  Number.isFinite(observation.longitude) &&
  Math.abs(observation.latitude) <= 90 &&
  Math.abs(observation.longitude) <= 180 &&
  !(observation.latitude === 0 && observation.longitude === 0) &&
  Number.isFinite(observation.timestamp) && observation.timestamp > 0;

const clearCandidate = (state: HardwareDirectionState) => {
  delete state.candidateRouteVariantId;
  delete state.candidateStartedAt;
  delete state.candidateLastEvidenceAt;
  state.consecutiveEvidenceCount = 0;
  state.candidateDisplacementMeters = 0;
  state.strongEvidenceCount = 0;
  state.terminalEvidence = false;
};

const anchorFromObservation = (
  observation: HardwareDirectionObservation,
  metrics: Record<string, HardwareDirectionVariantMetrics>,
): HardwareDirectionAnchor => ({
  latitude: observation.latitude,
  longitude: observation.longitude,
  timestamp: observation.timestamp,
  progressByVariant: Object.fromEntries(
    Object.values(metrics).map((metric) => [metric.routeVariantId, metric.progressMeters]),
  ),
});

const segmentBearing = (
  variant: HardwareDirectionVariant,
  segmentIndex: number,
): number => {
  const start = variant.points[Math.min(segmentIndex, variant.points.length - 2)];
  const end = variant.points[Math.min(segmentIndex + 1, variant.points.length - 1)];
  return bearingDegrees(start, end);
};

export function evaluateHardwareDirection(
  context: HardwareDirectionContext,
  variants: HardwareDirectionVariant[],
  previousState: HardwareDirectionState | undefined,
  observation: HardwareDirectionObservation,
  config: HardwareDirectionConfig = defaultHardwareDirectionConfig,
): HardwareDirectionEvaluation {
  const resetReason = previousState && !sameContext(previousState, context)
    ? previousState.assignmentId !== context.assignmentId ||
      previousState.assignedRouteVariantId !== context.assignedRouteVariantId
      ? "assignment_changed"
      : "geometry_changed"
    : undefined;
  const state = previousState && !resetReason
    ? copyState(previousState)
    : initialHardwareDirectionState(context, resetReason ?? "state_initialized");

  if (!validCoordinate(observation)) {
    return {
      state,
      acceptedObservation: false,
      switched: false,
      reason: "invalid_observation",
      metrics: {},
    };
  }
  if (state.lastObservationAt !== undefined && observation.timestamp <= state.lastObservationAt) {
    return {
      state,
      acceptedObservation: false,
      switched: false,
      reason: observation.timestamp === state.lastObservationAt ? "duplicate" : "out_of_order",
      metrics: {},
    };
  }

  const anchor = state.motionAnchor;
  const movementBearing = anchor ? bearingDegrees(anchor, observation) : undefined;
  const metrics: Record<string, HardwareDirectionVariantMetrics> = {};
  for (const variant of variants) {
    const snap = findNearestPointOnPolyline(observation, variant.points);
    const progressDelta = anchor?.progressByVariant[variant.id] === undefined
      ? null
      : snap.progressMeters - anchor.progressByVariant[variant.id];
    const expectedBearing = segmentBearing(variant, snap.segmentIndex);
    metrics[variant.id] = {
      routeVariantId: variant.id,
      direction: variant.direction,
      progressMeters: snap.progressMeters,
      progressDeltaMeters: progressDelta,
      distanceFromRouteMeters: snap.distanceFromRouteMeters,
      expectedBearing,
      bearingErrorDegrees: movementBearing === undefined
        ? null
        : bearingDifferenceDegrees(movementBearing, expectedBearing),
      score: 0,
      supportsMovement: false,
      strongEvidence: false,
    };
  }

  state.lastObservationAt = observation.timestamp;
  if (!anchor) {
    state.motionAnchor = anchorFromObservation(observation, metrics);
    state.lastReason = resetReason ?? "baseline_observation";
    return {
      state,
      acceptedObservation: true,
      switched: false,
      reason: state.lastReason,
      metrics,
    };
  }

  const elapsedSeconds = (observation.timestamp - anchor.timestamp) / 1000;
  const displacementMeters = haversineDistanceMeters(anchor, observation);
  if (elapsedSeconds > config.maxObservationGapSeconds) {
    clearCandidate(state);
    state.motionAnchor = anchorFromObservation(observation, metrics);
    state.detectionConfidence = "low";
    state.lastReason = "signal_gap_rebaseline";
    return {
      state,
      acceptedObservation: true,
      switched: false,
      reason: state.lastReason,
      movementBearing,
      displacementMeters,
      elapsedSeconds,
      metrics,
    };
  }

  if (elapsedSeconds <= 0 || displacementMeters / elapsedSeconds > config.maxJumpSpeedMps) {
    state.detectionConfidence = state.detectedRouteVariantId ? "medium" : "low";
    state.lastReason = "unrealistic_jump";
    return {
      state,
      acceptedObservation: true,
      switched: false,
      reason: state.lastReason,
      movementBearing,
      displacementMeters,
      elapsedSeconds,
      metrics,
    };
  }

  const stationaryByDevice = observation.speedMps !== undefined &&
    observation.speedMps <= config.stationarySpeedMps &&
    displacementMeters < config.stationaryDriftMeters;
  if (displacementMeters < config.minDisplacementMeters || stationaryByDevice) {
    if (
      state.candidateLastEvidenceAt !== undefined &&
      observation.timestamp - state.candidateLastEvidenceAt >
        config.candidateEvidenceGapSeconds * 1000
    ) clearCandidate(state);
    state.detectionConfidence = state.detectedRouteVariantId ? "medium" : "low";
    state.lastReason = stationaryByDevice ? "stationary" : "insufficient_displacement";
    return {
      state,
      acceptedObservation: true,
      switched: false,
      reason: state.lastReason,
      movementBearing,
      displacementMeters,
      elapsedSeconds,
      metrics,
    };
  }

  const poorQuality =
    (observation.satellites !== undefined && observation.satellites < 3) ||
    (observation.hdop !== undefined && observation.hdop > config.maxHdop);
  if (poorQuality) {
    state.detectionConfidence = "low";
    state.lastReason = "poor_gps_quality";
    return {
      state,
      acceptedObservation: true,
      switched: false,
      reason: state.lastReason,
      movementBearing,
      displacementMeters,
      elapsedSeconds,
      metrics,
    };
  }

  for (const metric of Object.values(metrics)) {
    const progressDelta = metric.progressDeltaMeters ?? 0;
    const bearingError = metric.bearingErrorDegrees ?? 180;
    const plausibleProgress = progressDelta <= Math.max(displacementMeters * 3, 250);
    metric.supportsMovement =
      metric.distanceFromRouteMeters <= config.maxRouteDistanceMeters &&
      progressDelta >= config.minProgressMeters &&
      plausibleProgress &&
      bearingError <= config.maxBearingErrorDegrees;
    if (!metric.supportsMovement) continue;
    metric.score += progressDelta >= config.minProgressMeters ? 2 : 0;
    metric.score += bearingError <= 45 ? 2 : 1;
    metric.score += metric.distanceFromRouteMeters <= config.strongRouteDistanceMeters ? 2 : 1;
    const efficiency = progressDelta / Math.max(displacementMeters, 1);
    if (efficiency >= 0.25 && efficiency <= 2.5) metric.score += 1;
    if (
      observation.heading !== undefined &&
      observation.speedMps !== undefined &&
      observation.speedMps > 1.5
    ) {
      const headingError = bearingDifferenceDegrees(observation.heading, metric.expectedBearing);
      if (headingError <= 60) metric.score += 1;
      else if (headingError >= 120) metric.score -= 1;
    }
    if (observation.satellites !== undefined && observation.satellites < 5) metric.score -= 1;
  }

  const metricValues = Object.values(metrics);
  for (const metric of metricValues) {
    const opposite = metricValues.find((candidate) => candidate.routeVariantId !== metric.routeVariantId);
    metric.strongEvidence = metric.supportsMovement && (
      !opposite?.supportsMovement ||
      metric.distanceFromRouteMeters + config.routeDistanceAdvantageMeters <=
        opposite.distanceFromRouteMeters ||
      (metric.progressDeltaMeters !== null &&
        opposite?.progressDeltaMeters !== null &&
        metric.progressDeltaMeters >= config.minProgressMeters &&
        (opposite?.progressDeltaMeters ?? 0) <= -config.minProgressMeters)
    );
  }

  const supported = metricValues
    .filter((metric) => metric.supportsMovement)
    .sort((left, right) => right.score - left.score);
  const support = supported.length === 1 ||
    (supported.length > 1 && supported[0].score - supported[1].score >= config.minScoreMargin)
    ? supported[0]
    : undefined;

  if (!support) {
    if (
      state.candidateLastEvidenceAt !== undefined &&
      observation.timestamp - state.candidateLastEvidenceAt >
        config.candidateEvidenceGapSeconds * 1000
    ) clearCandidate(state);
    state.motionAnchor = anchorFromObservation(observation, metrics);
    state.detectionConfidence = state.detectedRouteVariantId ? "medium" : "low";
    state.lastReason = supported.length > 1 ? "ambiguous_shared_segment" : "no_direction_support";
    return {
      state,
      acceptedObservation: true,
      switched: false,
      reason: state.lastReason,
      movementBearing,
      displacementMeters,
      elapsedSeconds,
      metrics,
    };
  }

  if (support.routeVariantId === state.detectedRouteVariantId) {
    clearCandidate(state);
    state.motionAnchor = anchorFromObservation(observation, metrics);
    state.detectionConfidence = support.strongEvidence ? "high" : "medium";
    state.lastReason = "confirmed_direction_supported";
    return {
      state,
      acceptedObservation: true,
      switched: false,
      reason: state.lastReason,
      movementBearing,
      displacementMeters,
      elapsedSeconds,
      metrics,
    };
  }

  const sameCandidate = state.candidateRouteVariantId === support.routeVariantId &&
    state.candidateLastEvidenceAt !== undefined &&
    observation.timestamp - state.candidateLastEvidenceAt <=
      config.candidateEvidenceGapSeconds * 1000;
  if (!sameCandidate) {
    clearCandidate(state);
    state.candidateRouteVariantId = support.routeVariantId;
    state.candidateStartedAt = observation.timestamp;
  }
  state.candidateLastEvidenceAt = observation.timestamp;
  state.consecutiveEvidenceCount += 1;
  state.candidateDisplacementMeters += displacementMeters;
  if (support.strongEvidence) state.strongEvidenceCount += 1;

  const detectedVariant = variants.find(
    (variant) => variant.id === state.detectedRouteVariantId,
  );
  const detectedAnchorProgress = detectedVariant
    ? anchor.progressByVariant[detectedVariant.id]
    : undefined;
  const nearDetectedEnd = detectedVariant !== undefined &&
    detectedAnchorProgress !== undefined &&
    detectedVariant.totalDistanceMeters - detectedAnchorProgress <= config.terminalRadiusMeters;
  const candidateAnchorProgress = anchor.progressByVariant[support.routeVariantId];
  const nearCandidateStart = candidateAnchorProgress !== undefined &&
    candidateAnchorProgress <= config.terminalRadiusMeters;
  state.terminalEvidence = state.terminalEvidence || (nearDetectedEnd && nearCandidateStart);

  const evidenceDurationSeconds = state.candidateStartedAt === undefined
    ? 0
    : (observation.timestamp - state.candidateStartedAt) / 1000;
  const initialReady = !state.detectedRouteVariantId &&
    state.consecutiveEvidenceCount >= config.initialEvidenceCount &&
    state.candidateDisplacementMeters >= config.initialDistanceMeters &&
    evidenceDurationSeconds >= config.minEvidenceDurationSeconds &&
    state.strongEvidenceCount >= Math.min(2, config.initialEvidenceCount);
  const terminalSwitchReady = Boolean(state.detectedRouteVariantId) &&
    state.terminalEvidence &&
    state.consecutiveEvidenceCount >= config.initialEvidenceCount &&
    state.candidateDisplacementMeters >= config.terminalSwitchDistanceMeters &&
    evidenceDurationSeconds >= config.minEvidenceDurationSeconds;
  const geometricSwitchReady = Boolean(state.detectedRouteVariantId) &&
    state.consecutiveEvidenceCount >= config.switchEvidenceCount &&
    state.candidateDisplacementMeters >= config.switchDistanceMeters &&
    evidenceDurationSeconds >= config.minSwitchDurationSeconds &&
    state.strongEvidenceCount >= config.minStrongEvidenceCount;

  const confirm = initialReady || terminalSwitchReady || geometricSwitchReady;
  let reason = "candidate_evidence";
  let switched = false;
  if (confirm) {
    switched = Boolean(state.detectedRouteVariantId) &&
      state.detectedRouteVariantId !== support.routeVariantId;
    state.detectedRouteVariantId = support.routeVariantId;
    state.lastConfirmedAt = observation.timestamp;
    state.detectionConfidence = "high";
    reason = initialReady
      ? "initial_direction_confirmed"
      : terminalSwitchReady
        ? "direction_switched_terminal"
        : "direction_switched_geometric";
    clearCandidate(state);
  } else {
    state.detectionConfidence = state.detectedRouteVariantId ? "medium" : "low";
  }
  state.motionAnchor = anchorFromObservation(observation, metrics);
  state.lastReason = reason;
  return {
    state,
    acceptedObservation: true,
    switched,
    reason,
    movementBearing,
    displacementMeters,
    elapsedSeconds,
    metrics,
  };
}
