export const RUPTELA_COMMAND = {
  RECORDS: 1,
  IDENTIFICATION: 15,
  HEARTBEAT: 16,
  DYNAMIC_IDENTIFICATION: 18,
  EXTENDED_RECORDS: 68,
} as const;

export class RuptelaProtocolError extends Error {}

export interface RuptelaIoElement {
  id: number;
  length: 1 | 2 | 4 | 8;
  hex: string;
  value: number | string;
}

export interface RuptelaRecord {
  timestamp: number;
  timestampSeconds: number;
  timestampExtension: number;
  recordExtension: number | null;
  priority: number;
  longitude: number;
  latitude: number;
  altitude: number;
  heading: number;
  satellites: number;
  speedKmh: number;
  hdop: number;
  eventId: number;
  io: RuptelaIoElement[];
  fingerprint: string;
}

export interface RuptelaEnvelope {
  imei: string;
  command: number;
  payload: Buffer;
  packetHash: string;
}

export interface RuptelaIdentification {
  version: number | null;
  model: string | null;
  firmwareVersion: string | null;
}

export interface RuptelaRecordsPacket {
  recordsLeft: boolean;
  declaredCount: number;
  records: RuptelaRecord[];
}
