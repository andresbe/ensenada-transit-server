import { env } from "../config/env";
import {
  acceptHardwareRecords,
  authorizeHardwareDevice,
  hardwareDeviceMappingSql,
  hardwareUnavailableReason,
  publishHardwarePending,
} from "../tracking/hardwareStore";
import { AvlRecord } from "./codec";
import { fitsLocationSchema, normalizeRecord } from "./normalize";

export const deviceMappingSql = hardwareDeviceMappingSql;

export async function authorizeDevice(imei: string): Promise<string | null> {
  return authorizeHardwareDevice("TELTONIKA", imei);
}

export async function acceptRecords(
  deviceId: string,
  records: AvlRecord[],
  receivedAt = Date.now(),
) {
  return acceptHardwareRecords(
    "TELTONIKA",
    deviceId,
    records.map(record => ({
      eventKey: record.fingerprint,
      fitsSchema: fitsLocationSchema(record),
      telemetry: normalizeRecord(record, deviceId, null, receivedAt),
    })),
    receivedAt,
  );
}

export function unavailableReason(device: Record<string, any>): string | null {
  return hardwareUnavailableReason(device, "TELTONIKA");
}

export async function publishPending(maxAgeMs = env.locationTtlMs) {
  return publishHardwarePending("TELTONIKA", maxAgeMs);
}
