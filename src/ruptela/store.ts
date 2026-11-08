import { env } from "../config/env";
import { getClient, query } from "../db";
import {
  acceptHardwareRecords,
  authorizeHardwareDevice,
  publishHardwarePending,
} from "../tracking/hardwareStore";
import { fitsLocationSchema, normalizeRecord } from "./normalize";
import { RuptelaRecord } from "./protocol/types";

export async function authorizeDevice(imei: string): Promise<string | null> {
  return authorizeHardwareDevice("RUPTELA", imei);
}

export async function acceptRecords(
  deviceId: string,
  records: RuptelaRecord[],
  receivedAt = Date.now(),
) {
  return acceptHardwareRecords(
    "RUPTELA",
    deviceId,
    records.map(record => ({
      eventKey: record.fingerprint,
      fitsSchema: fitsLocationSchema(record),
      telemetry: normalizeRecord(record, deviceId, null, receivedAt),
    })),
    receivedAt,
  );
}

export async function publishPending(maxAgeMs = env.locationTtlMs) {
  return publishHardwarePending("RUPTELA", maxAgeMs);
}

export interface PacketDiagnostic {
  deviceId: string;
  command: number;
  packetHash: string;
  byteLength: number;
  reason: string;
  rawPacket?: Buffer;
}

export async function capturePacketDiagnostic(
  diagnostic: PacketDiagnostic,
  retentionHours: number,
) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM tracking_device_packet_diagnostics WHERE expires_at<=now()");
    await client.query(
      `INSERT INTO tracking_device_packet_diagnostics
       (provider,device_id,command,packet_hash,byte_length,reason,raw_packet,expires_at)
       VALUES('RUPTELA',$1,$2,$3,$4,$5,$6,now()+($7::text || ' hours')::interval)
       ON CONFLICT(provider,device_id,packet_hash,reason) DO NOTHING`,
      [
        diagnostic.deviceId,
        diagnostic.command,
        diagnostic.packetHash,
        diagnostic.byteLength,
        diagnostic.reason.slice(0, 80),
        diagnostic.rawPacket ?? null,
        retentionHours,
      ],
    );
    await client.query(
      `DELETE FROM tracking_device_packet_diagnostics WHERE device_id=$1 AND id IN
       (SELECT id FROM tracking_device_packet_diagnostics WHERE device_id=$1 ORDER BY received_at DESC,id DESC OFFSET 100)`,
      [diagnostic.deviceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function prunePacketDiagnostics(): Promise<number> {
  const result = await query(
    "DELETE FROM tracking_device_packet_diagnostics WHERE provider='RUPTELA' AND expires_at<=now() RETURNING id",
  );
  return result.rows.length;
}
