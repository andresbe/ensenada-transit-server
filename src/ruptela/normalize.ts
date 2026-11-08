import { NormalizedHardwareTelemetry } from "../tracking/hardwareStore";
import { RuptelaRecord } from "./protocol/types";

export interface NormalizedRuptelaTelemetry extends NormalizedHardwareTelemetry {
  provider: "RUPTELA";
  hdop: number;
  ignition: boolean | null;
  externalPowerVolts: number | null;
  gsmSignalLevel: number | null;
  networkOperator: number | null;
  gprsConnected: boolean | null;
  networkTechnology: number | null;
  networkRegistrationStatus: number | null;
}

const numericIo = (record: RuptelaRecord, ...ids: number[]): number | null => {
  for (let index = record.io.length - 1; index >= 0; index--) {
    const element = record.io[index];
    if (ids.includes(element.id) && typeof element.value === "number") return element.value;
  }
  return null;
};

export function normalizeRecord(
  record: RuptelaRecord,
  deviceId: string,
  vehicleId: string | null,
  receivedAt = Date.now(),
): NormalizedRuptelaTelemetry {
  let invalidReason: string | null = null;
  if (Math.abs(record.latitude) > 90 || Math.abs(record.longitude) > 180) invalidReason = "coordinate_range";
  else if (record.latitude === 0 && record.longitude === 0) invalidReason = "zero_coordinates";
  else if (record.satellites === 0) invalidReason = "no_gnss_fix";
  else if (record.heading >= 360) invalidReason = "invalid_heading";
  else if (record.speedKmh / 3.6 >= 100) invalidReason = "invalid_speed";
  else if (record.satellites > 99) invalidReason = "invalid_satellites";
  else if (record.timestamp <= 0 || record.timestamp > receivedAt + 30000) invalidReason = "invalid_timestamp";

  const ignition = numericIo(record, 251, 409);
  const externalPower = numericIo(record, 29);
  const gprs = numericIo(record, 418);
  return {
    provider: "RUPTELA",
    deviceId,
    vehicleId,
    latitude: record.latitude,
    longitude: record.longitude,
    altitude: record.altitude,
    speedMps: record.speedKmh / 3.6,
    heading: record.heading,
    satellites: record.satellites,
    recordedAt: new Date(record.timestamp).toISOString(),
    receivedAt: new Date(receivedAt).toISOString(),
    isValid: invalidReason === null,
    invalidReason,
    priority: record.priority,
    eventId: record.eventId,
    hdop: record.hdop,
    ignition: ignition === null ? null : ignition > 0,
    externalPowerVolts: externalPower === null ? null : externalPower / 1000,
    gsmSignalLevel: numericIo(record, 27),
    networkOperator: numericIo(record, 150),
    gprsConnected: gprs === null ? null : gprs > 0,
    networkTechnology: numericIo(record, 762),
    networkRegistrationStatus: numericIo(record, 763),
    io: record.io,
  };
}

export function fitsLocationSchema(record: RuptelaRecord): boolean {
  return Math.abs(record.latitude) <= 90 && Math.abs(record.longitude) <= 180 &&
    record.heading < 360 && record.speedKmh / 3.6 < 100 && record.satellites <= 99 &&
    record.timestamp <= 253402300799999;
}
