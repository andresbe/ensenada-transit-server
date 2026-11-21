import type { PoolClient } from "pg";
import { query } from "../db";
import type { RouteVariantDirection } from "../modules/locations/locations.types";
import {
  createHardwareDirectionVariant,
  evaluateHardwareDirection,
  HardwareDirectionConfig,
  HardwareDirectionEvaluation,
  HardwareDirectionObservation,
  HardwareDirectionState,
  HardwareDirectionVariant,
  hardwareDirectionConfigFromEnv,
  hardwareDirectionGeometryFingerprint,
} from "./hardwareDirection";

export type HardwareAutoDirectionMode = "off" | "shadow" | "enabled";

export interface HardwareDirectionAssignment {
  deviceId: string;
  assignmentId: string;
  routeId: string;
  assignedRouteVariantId: string;
  assignedDirection: RouteVariantDirection;
}

export interface HardwareDirectionDecision extends HardwareDirectionEvaluation {
  assignedRouteVariantId: string;
  detectedRouteVariantId?: string;
  candidateRouteVariantId?: string;
  effectiveRouteVariantId: string;
  effectiveDirection: RouteVariantDirection;
  detectionConfidence: HardwareDirectionState["detectionConfidence"];
}

export interface HardwareDirectionSession {
  available: boolean;
  unavailableReason?: string;
  observe(observation: HardwareDirectionObservation): HardwareDirectionDecision;
  persist(): Promise<void>;
}

let shadowRuntimeAvailable = true;

export function isHardwareDirectionShadowAvailable(): boolean {
  return shadowRuntimeAvailable;
}

export function disableHardwareDirectionShadow(): void {
  shadowRuntimeAvailable = false;
}

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const dateMillis = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const milliseconds = new Date(value as string | Date).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

const numeric = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const progressRecord = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, Number(raw)] as const)
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
  );
};

const stateFromRow = (row: Record<string, any>): HardwareDirectionState => {
  const anchorAt = dateMillis(row.motion_anchor_at);
  const anchorLatitude = Number(row.motion_anchor_latitude);
  const anchorLongitude = Number(row.motion_anchor_longitude);
  const hasAnchor = anchorAt !== undefined &&
    Number.isFinite(anchorLatitude) && Number.isFinite(anchorLongitude);
  return {
    assignmentId: row.assignment_id,
    routeId: row.route_id,
    assignedRouteVariantId: row.assigned_route_variant_id,
    geometryFingerprint: row.geometry_fingerprint,
    detectedRouteVariantId: row.detected_route_variant_id ?? undefined,
    candidateRouteVariantId: row.candidate_route_variant_id ?? undefined,
    consecutiveEvidenceCount: numeric(row.consecutive_evidence_count),
    candidateStartedAt: dateMillis(row.candidate_started_at),
    candidateLastEvidenceAt: dateMillis(row.candidate_last_evidence_at),
    candidateDisplacementMeters: numeric(row.candidate_displacement_meters),
    strongEvidenceCount: numeric(row.strong_evidence_count),
    terminalEvidence: row.terminal_evidence === true,
    lastConfirmedAt: dateMillis(row.last_confirmed_at),
    lastObservationAt: dateMillis(row.last_observation_at),
    motionAnchor: hasAnchor
      ? {
          timestamp: anchorAt,
          latitude: anchorLatitude,
          longitude: anchorLongitude,
          progressByVariant: progressRecord(row.motion_anchor_progress),
        }
      : undefined,
    detectionConfidence: ["low", "medium", "high"].includes(row.detection_confidence)
      ? row.detection_confidence
      : "low",
    lastReason: typeof row.last_reason === "string" ? row.last_reason : "state_loaded",
  };
};

const dateOrNull = (value: number | undefined) =>
  value === undefined ? null : new Date(value);

const fallbackEvaluation = (
  state: HardwareDirectionState,
  reason: string,
): HardwareDirectionEvaluation => ({
  state,
  acceptedObservation: false,
  switched: false,
  reason,
  metrics: {},
});

export async function createHardwareDirectionSession(
  client: PoolClient | Queryable,
  assignment: HardwareDirectionAssignment,
  mode: HardwareAutoDirectionMode,
  config: HardwareDirectionConfig = hardwareDirectionConfigFromEnv(),
): Promise<HardwareDirectionSession> {
  const variantRows = (await client.query(
    `SELECT id::text,route_id::text,direction,coordinates,updated_at
     FROM route_variants WHERE route_id=$1 AND direction IN ('ida','vuelta')
     ORDER BY direction,id`,
    [assignment.routeId],
  )).rows;
  let variants: HardwareDirectionVariant[] = [];
  try {
    variants = variantRows.map((row) => createHardwareDirectionVariant({
      id: row.id,
      routeId: row.route_id,
      direction: row.direction,
      coordinates: row.coordinates,
      updatedAt: row.updated_at,
    }));
  } catch {
    variants = [];
  }
  const directionCounts = variants.reduce(
    (counts, variant) => ({ ...counts, [variant.direction]: counts[variant.direction] + 1 }),
    { ida: 0, vuelta: 0 },
  );
  const assignedVariant = variants.find(
    (variant) => variant.id === assignment.assignedRouteVariantId,
  );
  const unavailableReason = variants.length !== 2 ||
    directionCounts.ida !== 1 || directionCounts.vuelta !== 1
    ? "route_variant_pair_ambiguous"
    : !assignedVariant || assignedVariant.direction !== assignment.assignedDirection
      ? "assigned_variant_not_in_pair"
      : undefined;

  if (unavailableReason) {
    const state: HardwareDirectionState = {
      assignmentId: assignment.assignmentId,
      routeId: assignment.routeId,
      assignedRouteVariantId: assignment.assignedRouteVariantId,
      geometryFingerprint: "0".repeat(64),
      consecutiveEvidenceCount: 0,
      candidateDisplacementMeters: 0,
      strongEvidenceCount: 0,
      terminalEvidence: false,
      detectionConfidence: "low",
      lastReason: unavailableReason,
    };
    return {
      available: false,
      unavailableReason,
      observe: () => ({
        ...fallbackEvaluation(state, unavailableReason),
        assignedRouteVariantId: assignment.assignedRouteVariantId,
        effectiveRouteVariantId: assignment.assignedRouteVariantId,
        effectiveDirection: assignment.assignedDirection,
        detectionConfidence: "low",
      }),
      persist: async () => {},
    };
  }

  const geometryFingerprint = hardwareDirectionGeometryFingerprint(variants);
  const stored = (await client.query(
    "SELECT * FROM device_direction_state WHERE device_id=$1 FOR UPDATE",
    [assignment.deviceId],
  )).rows[0];
  let state = stored ? stateFromRow(stored) : undefined;
  let dirty = false;
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));

  return {
    available: true,
    observe(observation) {
      const evaluation = evaluateHardwareDirection(
        {
          assignmentId: assignment.assignmentId,
          routeId: assignment.routeId,
          assignedRouteVariantId: assignment.assignedRouteVariantId,
          geometryFingerprint,
        },
        variants,
        state,
        observation,
        config,
      );
      state = evaluation.state;
      dirty = dirty || evaluation.acceptedObservation;
      const confirmed = state.detectedRouteVariantId && variantById.has(state.detectedRouteVariantId)
        ? state.detectedRouteVariantId
        : undefined;
      const effectiveRouteVariantId = mode === "enabled" && confirmed
        ? confirmed
        : assignment.assignedRouteVariantId;
      const effectiveDirection = variantById.get(effectiveRouteVariantId)?.direction ??
        assignment.assignedDirection;
      return {
        ...evaluation,
        assignedRouteVariantId: assignment.assignedRouteVariantId,
        detectedRouteVariantId: confirmed,
        candidateRouteVariantId: state.candidateRouteVariantId,
        effectiveRouteVariantId,
        effectiveDirection,
        detectionConfidence: state.detectionConfidence,
      };
    },
    async persist() {
      if (!dirty || !state) return;
      await client.query(
        `INSERT INTO device_direction_state
         (device_id,assignment_id,route_id,assigned_route_variant_id,detected_route_variant_id,
          candidate_route_variant_id,consecutive_evidence_count,candidate_started_at,
          candidate_last_evidence_at,candidate_displacement_meters,strong_evidence_count,
          terminal_evidence,last_confirmed_at,last_observation_at,motion_anchor_at,
          motion_anchor_latitude,motion_anchor_longitude,motion_anchor_progress,
          detection_confidence,geometry_fingerprint,last_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21)
         ON CONFLICT(device_id) DO UPDATE SET
          assignment_id=EXCLUDED.assignment_id,route_id=EXCLUDED.route_id,
          assigned_route_variant_id=EXCLUDED.assigned_route_variant_id,
          detected_route_variant_id=EXCLUDED.detected_route_variant_id,
          candidate_route_variant_id=EXCLUDED.candidate_route_variant_id,
          consecutive_evidence_count=EXCLUDED.consecutive_evidence_count,
          candidate_started_at=EXCLUDED.candidate_started_at,
          candidate_last_evidence_at=EXCLUDED.candidate_last_evidence_at,
          candidate_displacement_meters=EXCLUDED.candidate_displacement_meters,
          strong_evidence_count=EXCLUDED.strong_evidence_count,
          terminal_evidence=EXCLUDED.terminal_evidence,
          last_confirmed_at=EXCLUDED.last_confirmed_at,
          last_observation_at=EXCLUDED.last_observation_at,
          motion_anchor_at=EXCLUDED.motion_anchor_at,
          motion_anchor_latitude=EXCLUDED.motion_anchor_latitude,
          motion_anchor_longitude=EXCLUDED.motion_anchor_longitude,
          motion_anchor_progress=EXCLUDED.motion_anchor_progress,
          detection_confidence=EXCLUDED.detection_confidence,
          geometry_fingerprint=EXCLUDED.geometry_fingerprint,last_reason=EXCLUDED.last_reason`,
        [
          assignment.deviceId,
          state.assignmentId,
          state.routeId,
          state.assignedRouteVariantId,
          state.detectedRouteVariantId ?? null,
          state.candidateRouteVariantId ?? null,
          state.consecutiveEvidenceCount,
          dateOrNull(state.candidateStartedAt),
          dateOrNull(state.candidateLastEvidenceAt),
          state.candidateDisplacementMeters,
          state.strongEvidenceCount,
          state.terminalEvidence,
          dateOrNull(state.lastConfirmedAt),
          dateOrNull(state.lastObservationAt),
          dateOrNull(state.motionAnchor?.timestamp),
          state.motionAnchor?.latitude ?? null,
          state.motionAnchor?.longitude ?? null,
          JSON.stringify(state.motionAnchor?.progressByVariant ?? {}),
          state.detectionConfidence,
          state.geometryFingerprint,
          state.lastReason,
        ],
      );
      dirty = false;
    },
  };
}

export async function verifyHardwareDirectionSchema(): Promise<void> {
  hardwareDirectionConfigFromEnv();
  await query(`SELECT device_id,assignment_id,assigned_route_variant_id,
    detected_route_variant_id,last_observation_at,geometry_fingerprint
    FROM device_direction_state LIMIT 0`);
}
