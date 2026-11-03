import { getClient, query } from "../db";
import { env } from "../config/env";
import { ingestLocation } from "../tracking/ingestion";
import { AvlRecord } from "./codec";
import { normalizeRecord, NormalizedTelemetry, fitsLocationSchema } from "./normalize";

export async function authorizeDevice(imei: string): Promise<string | null> {
  const result = await query(`UPDATE tracking_devices SET last_connected_at=now()
    WHERE imei=$1 AND provider='TELTONIKA' AND status='active' RETURNING id`, [imei]);
  return result.rows[0]?.id ?? null;
}

export async function acceptRecords(deviceId: string, records: AvlRecord[], receivedAt = Date.now()) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const device = (await client.query("SELECT * FROM tracking_devices WHERE id=$1 AND status='active' AND provider='TELTONIKA' FOR UPDATE", [deviceId])).rows[0];
    if (!device) throw new Error("device_disabled");
    const rows = records.map(record => {
      const telemetry = normalizeRecord(record, device.id, null, receivedAt);
      return { event_key: record.fingerprint, recorded_at: telemetry.recordedAt, is_valid: telemetry.isValid,
        telemetry, fits_schema: fitsLocationSchema(record), latitude: telemetry.latitude, longitude: telemetry.longitude,
        speed_mps: telemetry.speedMps, heading: telemetry.heading, satellites: telemetry.satellites,
        delivery_status: telemetry.isValid ? "pending" : "skipped", delivery_reason: telemetry.invalidReason };
    });
    // Resolve installation at event time, so buffered records cannot move to the device's new vehicle.
    const inserted = await client.query(`INSERT INTO vehicle_gps_locations
      (source,device_id,vehicle_id,assignment_id,device_revision,event_key,latitude,longitude,speed_mps,heading,satellites,
       recorded_at,received_at,is_valid,telemetry,delivery_status,delivery_reason)
      SELECT 'TELTONIKA',$1,a.vehicle_id,a.id,$2,x.event_key,x.latitude,x.longitude,x.speed_mps,x.heading,x.satellites,
        x.recorded_at,$3,x.is_valid,x.telemetry || jsonb_build_object('vehicleId',a.vehicle_id),x.delivery_status,x.delivery_reason
      FROM jsonb_to_recordset($4::jsonb) AS x(event_key text,recorded_at timestamptz,is_valid boolean,
        latitude numeric,longitude numeric,speed_mps real,heading real,satellites smallint,
        telemetry jsonb,delivery_status text,delivery_reason text)
      LEFT JOIN LATERAL (SELECT id,vehicle_id FROM vehicle_device_assignments
        WHERE device_id=$1 AND assigned_at<=x.recorded_at AND (unassigned_at IS NULL OR x.recorded_at<unassigned_at)
        ORDER BY assigned_at DESC,id LIMIT 1) a ON true
      ON CONFLICT DO NOTHING RETURNING id`,
    [device.id, device.revision, new Date(receivedAt), JSON.stringify(rows.filter(row => row.fits_schema))]);
    const rejected = await client.query(`INSERT INTO tracking_device_rejections(device_id,event_key,received_at,reason,telemetry)
      SELECT $1,x.event_key,$2,x.delivery_reason,x.telemetry FROM jsonb_to_recordset($3::jsonb)
        AS x(event_key text,delivery_reason text,telemetry jsonb)
      ON CONFLICT DO NOTHING RETURNING id`,
    [device.id, new Date(receivedAt), JSON.stringify(rows.filter(row => !row.fits_schema))]);
    const validTimes = rows.filter(row => row.is_valid).map(row => Date.parse(row.recorded_at));
    await client.query(`UPDATE tracking_devices SET last_received_at=GREATEST(last_received_at,$2::timestamptz),
      last_seen_at=GREATEST(last_seen_at,$2::timestamptz),
      last_valid_location_at=GREATEST(last_valid_location_at,$3::timestamptz) WHERE id=$1`,
    [device.id, new Date(receivedAt), validTimes.length ? new Date(Math.max(...validTimes)) : null]);
    await client.query("COMMIT");
    return { accepted: records.length, inserted: inserted.rows.length + rejected.rows.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export const deviceMappingSql = `SELECT d.*,a.id AS assignment_id,a.vehicle_id,a.route_variant_id,
  v.tracking_id,v.economic_number,v.archived_at,v.operational_status,v.is_test_vehicle,
  v.assigned_route_id,v.transport_line_id,rv.route_id,rv.direction,r.active AS route_active,
  r.transport_line_id AS route_line_id,
  (v.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=v.transport_line_id AND l.active)) AS line_active,
  EXISTS(SELECT 1 FROM driver_sessions s WHERE s.bus_id=v.tracking_id AND s.status='active') AS android_active
  FROM tracking_devices d LEFT JOIN vehicle_device_assignments a ON a.device_id=d.id AND a.unassigned_at IS NULL
  LEFT JOIN fleet_vehicles v ON v.id=a.vehicle_id
  LEFT JOIN route_variants rv ON rv.id=a.route_variant_id LEFT JOIN routes r ON r.id=rv.route_id`;

export function unavailableReason(device: Record<string, any>): string | null {
  if (device.status !== "active" || device.provider !== "TELTONIKA") return "device_disabled";
  if (!device.vehicle_id || !device.tracking_id) return "unassigned_vehicle";
  if (device.archived_at || device.operational_status !== "available" || !device.line_active) return "vehicle_unavailable";
  if (!device.route_id || !device.route_variant_id) return "unassigned_route";
  if (!device.route_active || device.route_line_id !== device.transport_line_id ||
      (device.assigned_route_id && device.assigned_route_id !== device.route_id)) return "route_assignment_changed";
  if (!["ida", "vuelta"].includes(device.direction)) return "unsupported_direction";
  if (device.android_active) return "android_session_active";
  return null;
}

/** Replayable outbox: Redis commits precede delivered_at. Replays are timestamp-idempotent. */
export async function publishPending(maxAgeMs = env.locationTtlMs): Promise<{ published: number; skipped: number; failures: number }> {
  const devices = (await query(`SELECT device_id FROM vehicle_gps_locations WHERE delivery_status='pending' AND source='TELTONIKA'
    GROUP BY device_id ORDER BY min(id) LIMIT 100`)).rows;
  const counts = { published: 0, skipped: 0, failures: 0 };
  for (const { device_id: deviceId } of devices) {
    const client = await getClient();
    const deviceCounts = { published: 0, skipped: 0 };
    try {
      await client.query("BEGIN");
      const lock = await client.query("SELECT id FROM tracking_devices WHERE id=$1 FOR UPDATE SKIP LOCKED", [deviceId]);
      if (!lock.rows.length) { await client.query("COMMIT"); continue; }
      const device = (await client.query(`${deviceMappingSql} WHERE d.id=$1`, [deviceId])).rows[0];
      const pending = (await client.query(`SELECT * FROM vehicle_gps_locations WHERE device_id=$1 AND delivery_status='pending' AND source='TELTONIKA'
        ORDER BY recorded_at,id LIMIT 100 FOR UPDATE`, [deviceId])).rows;
      let watermark = device.last_published_at ? new Date(device.last_published_at).getTime() : 0;
      for (const row of pending) {
        const telemetry = row.telemetry as NormalizedTelemetry | null;
        const timestamp = new Date(row.recorded_at).getTime();
        let reason = unavailableReason(device);
        if (!row.is_valid || !telemetry) reason = telemetry?.invalidReason ?? "invalid_gps";
        else if (Date.now() - timestamp > Math.min(maxAgeMs, env.locationTtlMs)) reason = "historical";
        else if (row.device_revision !== device.revision || row.vehicle_id !== device.vehicle_id || row.assignment_id !== device.assignment_id) reason = "assignment_changed";
        else if (timestamp <= watermark) reason = "out_of_order";
        if (!reason && telemetry) {
          await ingestLocation({ provider: "TELTONIKA", deviceId, deviceRevision: device.revision,
            sourceId: deviceId, sourceType: "driver", busId: device.tracking_id,
            routeId: device.route_id, routeVariantId: device.route_variant_id, routeVariantDirection: device.direction,
            latitude: telemetry.latitude, longitude: telemetry.longitude, speed: telemetry.speedMps,
            heading: telemetry.heading, timestamp });
          watermark = timestamp;
          await client.query("UPDATE tracking_devices SET last_published_at=$2 WHERE id=$1", [deviceId, new Date(watermark)]);
        }
        await client.query(`UPDATE vehicle_gps_locations SET delivery_status=$2,delivery_reason=$3,delivered_at=now() WHERE id=$1`,
          [row.id, reason ? "skipped" : "published", reason]);
        if (reason) deviceCounts.skipped++; else deviceCounts.published++;
      }
      await client.query("COMMIT");
      counts.published += deviceCounts.published;
      counts.skipped += deviceCounts.skipped;
    } catch (error) {
      await client.query("ROLLBACK");
      counts.failures++;
    } finally { client.release(); }
  }
  return counts;
}
