import { AvlRecord } from "./codec";

export interface NormalizedTelemetry {
  provider: "TELTONIKA";
  deviceId: string;
  vehicleId: string | null;
  latitude: number;
  longitude: number;
  altitude: number;
  speedMps: number;
  heading: number;
  satellites: number;
  recordedAt: string;
  receivedAt: string;
  isValid: boolean;
  invalidReason: string | null;
  priority: number;
  eventId: number;
  io: AvlRecord["io"];
}

export function normalizeRecord(record: AvlRecord, deviceId: string, vehicleId: string | null,
  receivedAt = Date.now()): NormalizedTelemetry {
  let invalidReason: string | null = null;
  if (Math.abs(record.latitude) > 90 || Math.abs(record.longitude) > 180) invalidReason = "coordinate_range";
  else if (record.latitude === 0 && record.longitude === 0) invalidReason = "zero_coordinates";
  else if (record.satellites === 0) invalidReason = "no_gnss_fix";
  else if (record.heading >= 360) invalidReason = "invalid_heading";
  else if (record.speedKmh / 3.6 >= 100) invalidReason = "invalid_speed";
  else if (record.satellites > 99) invalidReason = "invalid_satellites";
  else if (record.timestamp <= 0 || record.timestamp > receivedAt + 30000) invalidReason = "invalid_timestamp";
  return { provider: "TELTONIKA", deviceId, vehicleId, latitude: record.latitude, longitude: record.longitude,
    altitude: record.altitude, speedMps: record.speedKmh / 3.6, heading: record.heading,
    satellites: record.satellites, recordedAt: new Date(record.timestamp).toISOString(),
    receivedAt: new Date(receivedAt).toISOString(), isValid: invalidReason === null, invalidReason,
    priority: record.priority, eventId: record.eventId, io: record.io };
}

/** 030's typed history must not contain fabricated/clamped values, even for invalid fixes. */
export function fitsLocationSchema(record: AvlRecord): boolean {
  return Math.abs(record.latitude) <= 90 && Math.abs(record.longitude) <= 180 &&
    record.heading < 360 && record.speedKmh / 3.6 < 100 && record.satellites <= 99 &&
    record.timestamp <= 253402300799999;
}
