import { env } from "../config/env";
import { getClient, query } from "../db";
import type { LiveBus } from "../modules/locations/locations.types";
import type { PoolClient } from "pg";
import {
  createHardwareDirectionSession,
  disableHardwareDirectionShadow,
  HardwareDirectionDecision,
  HardwareDirectionSession,
  isHardwareDirectionShadowAvailable,
} from "./hardwareDirectionStore";
import { ingestLocation } from "./ingestion";

export const hardwareProviders = ["TELTONIKA", "RUPTELA"] as const;
export type HardwareProvider = (typeof hardwareProviders)[number];

export function isHardwareProvider(value: unknown): value is HardwareProvider {
  return typeof value === "string" && hardwareProviders.includes(value as HardwareProvider);
}

export interface NormalizedHardwareTelemetry {
  provider: HardwareProvider;
  deviceId: string;
  vehicleId: string | null;
  latitude: number;
  longitude: number;
  altitude: number;
  speedMps: number;
  heading: number;
  satellites: number;
  hdop?: number;
  recordedAt: string;
  receivedAt: string;
  isValid: boolean;
  invalidReason: string | null;
  priority: number;
  eventId: number;
  io: unknown;
}

export interface PreparedHardwareRecord {
  eventKey: string;
  fitsSchema: boolean;
  telemetry: NormalizedHardwareTelemetry;
}

export async function authorizeHardwareDevice(
  provider: HardwareProvider,
  imei: string,
): Promise<string | null> {
  const result = await query(
    `UPDATE tracking_devices SET last_connected_at=now()
     WHERE imei=$1 AND provider=$2 AND status='active' RETURNING id`,
    [imei, provider],
  );
  return result.rows[0]?.id ?? null;
}

export async function acceptHardwareRecords(
  provider: HardwareProvider,
  deviceId: string,
  records: PreparedHardwareRecord[],
  receivedAt = Date.now(),
) {
  for (const record of records) {
    if (
      !/^[a-f0-9]{64}$/.test(record.eventKey) ||
      record.telemetry.provider !== provider ||
      record.telemetry.deviceId !== deviceId
    ) {
      throw new Error("invalid_normalized_hardware_record");
    }
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");
    const device = (
      await client.query(
        "SELECT * FROM tracking_devices WHERE id=$1 AND status='active' AND provider=$2 FOR UPDATE",
        [deviceId, provider],
      )
    ).rows[0];
    if (!device) throw new Error("device_disabled");

    const rows = records.map(({ eventKey, fitsSchema, telemetry }) => ({
      event_key: eventKey,
      recorded_at: telemetry.recordedAt,
      is_valid: telemetry.isValid,
      telemetry,
      fits_schema: fitsSchema,
      latitude: telemetry.latitude,
      longitude: telemetry.longitude,
      speed_mps: telemetry.speedMps,
      heading: telemetry.heading,
      satellites: telemetry.satellites,
      delivery_status: telemetry.isValid ? "pending" : "skipped",
      delivery_reason: telemetry.invalidReason,
    }));

    // Resolve installation at event time so buffered records stay with their original vehicle.
    const inserted = await client.query(
      `INSERT INTO vehicle_gps_locations
       (source,device_id,vehicle_id,assignment_id,device_revision,event_key,latitude,longitude,speed_mps,heading,satellites,
        recorded_at,received_at,is_valid,telemetry,delivery_status,delivery_reason)
       SELECT $1,$2,a.vehicle_id,a.id,$3,x.event_key,x.latitude,x.longitude,x.speed_mps,x.heading,x.satellites,
         x.recorded_at,$4,x.is_valid,x.telemetry || jsonb_build_object('vehicleId',a.vehicle_id),x.delivery_status,x.delivery_reason
       FROM jsonb_to_recordset($5::jsonb) AS x(event_key text,recorded_at timestamptz,is_valid boolean,
         latitude numeric,longitude numeric,speed_mps real,heading real,satellites smallint,
         telemetry jsonb,delivery_status text,delivery_reason text)
       LEFT JOIN LATERAL (SELECT id,vehicle_id FROM vehicle_device_assignments
         WHERE device_id=$2 AND assigned_at<=x.recorded_at AND (unassigned_at IS NULL OR x.recorded_at<unassigned_at)
         ORDER BY assigned_at DESC,id LIMIT 1) a ON true
       ON CONFLICT DO NOTHING RETURNING id`,
      [provider, device.id, device.revision, new Date(receivedAt), JSON.stringify(rows.filter(row => row.fits_schema))],
    );
    const rejected = await client.query(
      `INSERT INTO tracking_device_rejections(device_id,event_key,received_at,reason,telemetry)
       SELECT $1,x.event_key,$2,x.delivery_reason,x.telemetry FROM jsonb_to_recordset($3::jsonb)
         AS x(event_key text,delivery_reason text,telemetry jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [device.id, new Date(receivedAt), JSON.stringify(rows.filter(row => !row.fits_schema))],
    );
    const validTimes = rows
      .filter(row => row.is_valid)
      .map(row => Date.parse(row.recorded_at));
    await client.query(
      `UPDATE tracking_devices SET last_received_at=GREATEST(last_received_at,$2::timestamptz),
       last_seen_at=GREATEST(last_seen_at,$2::timestamptz),
       last_valid_location_at=GREATEST(last_valid_location_at,$3::timestamptz) WHERE id=$1`,
      [device.id, new Date(receivedAt), validTimes.length ? new Date(Math.max(...validTimes)) : null],
    );
    await client.query("COMMIT");
    return { accepted: records.length, inserted: inserted.rows.length + rejected.rows.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const hardwareDeviceMappingSql = `SELECT d.*,a.id AS assignment_id,a.vehicle_id,a.route_variant_id,
  v.tracking_id,v.economic_number,v.archived_at,v.operational_status,v.is_test_vehicle,
  v.assigned_route_id,v.transport_line_id,rv.route_id,rv.direction,r.active AS route_active,
  r.transport_line_id AS route_line_id,
  (v.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=v.transport_line_id AND l.active)) AS line_active,
  EXISTS(SELECT 1 FROM driver_sessions s WHERE s.bus_id=v.tracking_id AND s.status='active') AS android_active
  FROM tracking_devices d LEFT JOIN vehicle_device_assignments a ON a.device_id=d.id AND a.unassigned_at IS NULL
  LEFT JOIN fleet_vehicles v ON v.id=a.vehicle_id
  LEFT JOIN route_variants rv ON rv.id=a.route_variant_id LEFT JOIN routes r ON r.id=rv.route_id`;

export function hardwareUnavailableReason(
  device: Record<string, any>,
  expectedProvider?: HardwareProvider,
): string | null {
  if (
    device.status !== "active" ||
    !isHardwareProvider(device.provider) ||
    (expectedProvider !== undefined && device.provider !== expectedProvider)
  ) return "device_disabled";
  if (!device.vehicle_id || !device.tracking_id) return "unassigned_vehicle";
  if (device.archived_at || device.operational_status !== "available" || !device.line_active) return "vehicle_unavailable";
  if (!device.route_id || !device.route_variant_id) return "unassigned_route";
  if (
    !device.route_active ||
    device.route_line_id !== device.transport_line_id ||
    (device.assigned_route_id && device.assigned_route_id !== device.route_id)
  ) return "route_assignment_changed";
  if (!["ida", "vuelta"].includes(device.direction)) return "unsupported_direction";
  if (device.android_active) return "android_session_active";
  return null;
}

export function hardwareLocationMatchesMapping(
  device: Record<string, any>,
  bus: Pick<LiveBus,
    "provider" | "deviceId" | "deviceRevision" | "sourceId" | "busId" | "routeId" |
    "routeVariantId" | "assignedRouteVariantId" | "routeVariantDirection"
  >,
  effectiveVariant?: Record<string, any>,
): boolean {
  if (
    device.provider !== bus.provider ||
    device.revision !== bus.deviceRevision ||
    device.id !== bus.deviceId ||
    device.id !== bus.sourceId ||
    device.tracking_id !== bus.busId ||
    device.route_id !== bus.routeId
  ) return false;
  if (!bus.assignedRouteVariantId) {
    return device.route_variant_id === bus.routeVariantId &&
      device.direction === bus.routeVariantDirection;
  }
  if (device.route_variant_id !== bus.assignedRouteVariantId) return false;
  if (bus.routeVariantId === bus.assignedRouteVariantId) {
    return device.direction === bus.routeVariantDirection;
  }
  return effectiveVariant?.id === bus.routeVariantId &&
    effectiveVariant.route_id === device.route_id &&
    effectiveVariant.direction === bus.routeVariantDirection;
}

const logDirectionDecision = (
  provider: HardwareProvider,
  device: Record<string, any>,
  decision: HardwareDirectionDecision,
) => {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    service: "hardware-direction",
    event: "direction_evaluated",
    mode: env.hardwareAutoDirectionMode,
    provider,
    deviceId: device.id,
    busId: device.tracking_id,
    assignedRouteVariantId: decision.assignedRouteVariantId,
    candidateRouteVariantId: decision.candidateRouteVariantId ?? null,
    detectedRouteVariantId: decision.detectedRouteVariantId ?? null,
    effectiveRouteVariantId: decision.effectiveRouteVariantId,
    confidence: decision.detectionConfidence,
    reason: decision.reason,
    switched: decision.switched,
    displacementMeters: decision.displacementMeters === undefined
      ? null
      : Math.round(decision.displacementMeters),
  }));
};

const shadowDirectionLockTimeoutMs = 500;
const shadowDirectionStatementTimeoutMs = 1500;

const logShadowDirectionFailure = (
  provider: HardwareProvider,
  device: Record<string, any>,
  phase: "load" | "observe" | "persist",
  error: unknown,
) => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    service: "hardware-direction",
    event: "shadow_disabled",
    provider,
    deviceId: device.id,
    busId: device.tracking_id,
    phase,
    errorName: error instanceof Error ? error.name : typeof error,
    ...(code ? { errorCode: code } : {}),
    fallback: "assigned_route_variant",
  }));
};

const runShadowDirectionDatabaseStep = async <T>(
  client: PoolClient,
  provider: HardwareProvider,
  device: Record<string, any>,
  phase: "load" | "persist",
  operation: () => Promise<T>,
): Promise<T | undefined> => {
  const savepoint = `hardware_direction_shadow_${phase}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(`SET LOCAL lock_timeout TO '${shadowDirectionLockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout TO '${shadowDirectionStatementTimeoutMs}ms'`);
    const result = await operation();
    await client.query("SET LOCAL lock_timeout TO DEFAULT");
    await client.query("SET LOCAL statement_timeout TO DEFAULT");
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // The outer transaction is no longer recoverable, so preserve normal outbox retry behavior.
      throw error;
    }
    disableHardwareDirectionShadow();
    logShadowDirectionFailure(provider, device, phase, error);
    return undefined;
  }
};

/** Replayable outbox: Redis commits precede delivered_at. Replays are timestamp-idempotent. */
export async function publishHardwarePending(
  provider: HardwareProvider,
  maxAgeMs = env.locationTtlMs,
): Promise<{ published: number; skipped: number; failures: number }> {
  const directionMode = env.hardwareAutoDirectionMode;
  const devices = (
    await query(
      `SELECT device_id FROM vehicle_gps_locations WHERE delivery_status='pending' AND source=$1
       GROUP BY device_id ORDER BY min(id) LIMIT 100`,
      [provider],
    )
  ).rows;
  const counts = { published: 0, skipped: 0, failures: 0 };
  for (const { device_id: deviceId } of devices) {
    const client = await getClient();
    const deviceCounts = { published: 0, skipped: 0 };
    try {
      await client.query("BEGIN");
      const lock = await client.query(
        "SELECT id FROM tracking_devices WHERE id=$1 FOR UPDATE SKIP LOCKED",
        [deviceId],
      );
      if (!lock.rows.length) {
        await client.query("COMMIT");
        continue;
      }
      const device = (
        await client.query(`${hardwareDeviceMappingSql} WHERE d.id=$1`, [deviceId])
      ).rows[0];
      const pending = (
        await client.query(
          `SELECT * FROM vehicle_gps_locations
           WHERE device_id=$1 AND delivery_status='pending' AND source=$2
           ORDER BY recorded_at,id LIMIT 100 FOR UPDATE`,
          [deviceId, provider],
        )
      ).rows;
      const directionAssignment = {
        deviceId,
        assignmentId: device.assignment_id,
        routeId: device.route_id,
        assignedRouteVariantId: device.route_variant_id,
        assignedDirection: device.direction,
      };
      const directionRequested = directionMode !== "off" &&
        !hardwareUnavailableReason(device, provider) &&
        (directionMode !== "shadow" || isHardwareDirectionShadowAvailable());
      let directionSession: HardwareDirectionSession | undefined;
      if (directionRequested) {
        directionSession = directionMode === "shadow"
          ? await runShadowDirectionDatabaseStep(
              client,
              provider,
              device,
              "load",
              () => createHardwareDirectionSession(client, directionAssignment, directionMode),
            )
          : await createHardwareDirectionSession(client, directionAssignment, directionMode);
      }
      let watermark = device.last_published_at ? new Date(device.last_published_at).getTime() : 0;
      for (const row of pending) {
        const telemetry = row.telemetry as NormalizedHardwareTelemetry | null;
        const timestamp = new Date(row.recorded_at).getTime();
        let reason = hardwareUnavailableReason(device, provider);
        if (!row.is_valid || !telemetry) reason = telemetry?.invalidReason ?? "invalid_gps";
        else if (Date.now() - timestamp > Math.min(maxAgeMs, env.locationTtlMs)) reason = "historical";
        else if (
          row.device_revision !== device.revision ||
          row.vehicle_id !== device.vehicle_id ||
          row.assignment_id !== device.assignment_id
        ) reason = "assignment_changed";
        else if (timestamp <= watermark) reason = "out_of_order";
        if (!reason && telemetry) {
          let direction: HardwareDirectionDecision | undefined;
          if (directionSession) {
            try {
              direction = directionSession.observe({
                latitude: telemetry.latitude,
                longitude: telemetry.longitude,
                timestamp,
                speedMps: telemetry.speedMps,
                heading: telemetry.heading,
                satellites: telemetry.satellites,
                hdop: telemetry.hdop,
              });
            } catch (error) {
              if (directionMode !== "shadow") throw error;
              disableHardwareDirectionShadow();
              logShadowDirectionFailure(provider, device, "observe", error);
              directionSession = undefined;
            }
          }
          if (direction) logDirectionDecision(provider, device, direction);
          await ingestLocation({
            provider,
            deviceId,
            deviceRevision: device.revision,
            sourceId: deviceId,
            sourceType: "driver",
            busId: device.tracking_id,
            routeId: device.route_id,
            routeVariantId: direction?.effectiveRouteVariantId ?? device.route_variant_id,
            ...(directionMode === "enabled"
              ? { assignedRouteVariantId: device.route_variant_id }
              : {}),
            routeVariantDirection: direction?.effectiveDirection ?? device.direction,
            latitude: telemetry.latitude,
            longitude: telemetry.longitude,
            speed: telemetry.speedMps,
            heading: telemetry.heading,
            timestamp,
          });
          watermark = timestamp;
          await client.query(
            "UPDATE tracking_devices SET last_published_at=$2 WHERE id=$1",
            [deviceId, new Date(watermark)],
          );
        }
        await client.query(
          `UPDATE vehicle_gps_locations SET delivery_status=$2,delivery_reason=$3,delivered_at=now() WHERE id=$1`,
          [row.id, reason ? "skipped" : "published", reason],
        );
        if (reason) deviceCounts.skipped++;
        else deviceCounts.published++;
      }
      if (directionSession) {
        if (directionMode === "shadow") {
          await runShadowDirectionDatabaseStep(
            client,
            provider,
            device,
            "persist",
            () => directionSession!.persist(),
          );
        } else {
          await directionSession.persist();
        }
      }
      await client.query("COMMIT");
      counts.published += deviceCounts.published;
      counts.skipped += deviceCounts.skipped;
    } catch (error) {
      await client.query("ROLLBACK");
      counts.failures++;
    } finally {
      client.release();
    }
  }
  return counts;
}
