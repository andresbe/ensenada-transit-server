import { createHash } from "crypto";
import { validImei } from "../../tracking/deviceIdentity";
import { crc16Kermit } from "./checksum";
import {
  RUPTELA_COMMAND,
  RuptelaEnvelope,
  RuptelaIdentification,
  RuptelaIoElement,
  RuptelaProtocolError,
  RuptelaRecord,
  RuptelaRecordsPacket,
} from "./types";

class Reader {
  offset = 0;

  constructor(readonly data: Buffer) {}

  get remaining() {
    return this.data.length - this.offset;
  }

  take(size: number): Buffer {
    if (size < 0 || this.offset + size > this.data.length) {
      throw new RuptelaProtocolError("truncated_packet");
    }
    const value = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  u8() { return this.take(1).readUInt8(); }
  u16() { return this.take(2).readUInt16BE(); }
  u32() { return this.take(4).readUInt32BE(); }
  i32() { return this.take(4).readInt32BE(); }
}

const fingerprint = (command: number, parts: Buffer[]) => {
  const hash = createHash("sha256").update(Buffer.from([command]));
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};

const ascii = (bytes: Buffer): string | null => {
  const value = bytes.toString("latin1").replace(/\0+$/g, "").trim();
  return /^[\x20-\x7e]*$/.test(value) && value.length ? value : null;
};

export function decodeEnvelope(frame: Buffer, maxFrameBytes = 1024): RuptelaEnvelope {
  if (frame.length < 13 || frame.length > maxFrameBytes) {
    throw new RuptelaProtocolError("invalid_length");
  }
  const bodyLength = frame.readUInt16BE(0);
  if (bodyLength < 9 || frame.length !== bodyLength + 4) {
    throw new RuptelaProtocolError("invalid_length");
  }
  const body = frame.subarray(2, 2 + bodyLength);
  if (frame.readUInt16BE(frame.length - 2) !== crc16Kermit(body)) {
    throw new RuptelaProtocolError("crc_mismatch");
  }
  const numericImei = body.subarray(0, 8).readBigUInt64BE().toString();
  const imei = numericImei.padStart(15, "0");
  if (!validImei(imei) || numericImei.length > 15) {
    throw new RuptelaProtocolError("invalid_imei");
  }
  return {
    imei,
    command: body.readUInt8(8),
    payload: body.subarray(9),
    packetHash: createHash("sha256").update(frame).digest("hex"),
  };
}

export function decodeIdentification(
  command: number,
  payload: Buffer,
): RuptelaIdentification {
  if (command === RUPTELA_COMMAND.IDENTIFICATION) {
    if (payload.length !== 37) throw new RuptelaProtocolError("invalid_identification");
    return {
      version: null,
      model: ascii(payload.subarray(0, 4)),
      firmwareVersion: ascii(payload.subarray(4, 15)),
    };
  }
  if (command !== RUPTELA_COMMAND.DYNAMIC_IDENTIFICATION) {
    throw new RuptelaProtocolError("unsupported_identification");
  }
  const reader = new Reader(payload);
  if (reader.remaining < 2) throw new RuptelaProtocolError("invalid_identification");
  const version = reader.u8();
  const count = reader.u8();
  let model: string | null = null;
  let firmwareVersion: string | null = null;
  for (let index = 0; index < count; index++) {
    const id = reader.u8();
    const length = reader.u8();
    const value = reader.take(length);
    if (id === 1) model = ascii(value);
    if (id === 2) firmwareVersion = ascii(value);
  }
  if (reader.remaining !== 0) throw new RuptelaProtocolError("invalid_identification");
  return { version, model, firmwareVersion };
}

function readIo(reader: Reader, extended: boolean): RuptelaIoElement[] {
  const io: RuptelaIoElement[] = [];
  for (const length of [1, 2, 4, 8] as const) {
    const count = reader.u8();
    if (io.length + count > 512) throw new RuptelaProtocolError("invalid_io_count");
    for (let index = 0; index < count; index++) {
      const id = extended ? reader.u16() : reader.u8();
      const bytes = reader.take(length);
      const value = length === 8
        ? bytes.readBigUInt64BE().toString()
        : length === 4
          ? bytes.readUInt32BE()
          : length === 2
            ? bytes.readUInt16BE()
            : bytes.readUInt8();
      io.push({ id, length, hex: bytes.toString("hex"), value });
    }
  }
  return io;
}

interface RecordPart {
  record: RuptelaRecord;
  raw: Buffer;
  merge: { total: number; index: number };
}

function standardMerge(extension: number) {
  if (extension < 100) return { total: 1, index: 0 };
  const flag = Math.floor(extension / 100);
  const total = Math.floor(extension / 10) % 10 + 1;
  const index = extension % 10;
  if (flag !== 1 || index >= total) throw new RuptelaProtocolError("invalid_record_extension");
  return { total, index };
}

function extendedMerge(extension: number) {
  const total = (extension >>> 4) + 1;
  const index = extension & 0x0f;
  if (total > 8 || index >= total) throw new RuptelaProtocolError("invalid_record_extension");
  return { total, index };
}

function decodeRecordPart(reader: Reader, command: number): RecordPart {
  const extended = command === RUPTELA_COMMAND.EXTENDED_RECORDS;
  const start = reader.offset;
  const timestampSeconds = reader.u32();
  const timestampExtension = reader.u8();
  const recordExtension = extended ? reader.u8() : null;
  const merge = extended
    ? extendedMerge(recordExtension as number)
    : standardMerge(timestampExtension);
  const priority = reader.u8();
  const longitude = reader.i32() / 1e7;
  const latitude = reader.i32() / 1e7;
  const altitude = reader.u16() / 10;
  const heading = reader.u16() / 100;
  const satellites = reader.u8();
  const speedKmh = reader.u16();
  const hdop = reader.u8() / 10;
  const eventId = extended ? reader.u16() : reader.u8();
  const io = readIo(reader, extended);
  const raw = reader.data.subarray(start, reader.offset);
  const virtualMilliseconds = !extended && merge.total > 1 ? 0 : timestampExtension;
  return {
    raw,
    merge,
    record: {
      timestamp: timestampSeconds * 1000 + virtualMilliseconds,
      timestampSeconds,
      timestampExtension,
      recordExtension,
      priority,
      longitude,
      latitude,
      altitude,
      heading,
      satellites,
      speedKmh,
      hdop,
      eventId,
      io,
      fingerprint: fingerprint(command, [raw]),
    },
  };
}

export function decodeRecords(command: number, payload: Buffer): RuptelaRecordsPacket {
  if (command !== RUPTELA_COMMAND.RECORDS && command !== RUPTELA_COMMAND.EXTENDED_RECORDS) {
    throw new RuptelaProtocolError("unsupported_records_command");
  }
  const reader = new Reader(payload);
  const recordsLeft = reader.u8();
  const declaredCount = reader.u8();
  if (recordsLeft > 1 || declaredCount === 0) {
    throw new RuptelaProtocolError("invalid_record_count");
  }

  const records: RuptelaRecord[] = [];
  let pending: { record: RuptelaRecord; raw: Buffer[]; total: number; next: number } | null = null;
  for (let index = 0; index < declaredCount; index++) {
    const part = decodeRecordPart(reader, command);
    if (part.merge.total === 1) {
      if (pending) throw new RuptelaProtocolError("incomplete_merged_record");
      records.push(part.record);
      continue;
    }
    if (part.merge.index === 0) {
      if (pending) throw new RuptelaProtocolError("incomplete_merged_record");
      pending = { record: part.record, raw: [part.raw], total: part.merge.total, next: 1 };
      continue;
    }
    if (
      !pending ||
      part.merge.total !== pending.total ||
      part.merge.index !== pending.next ||
      part.record.timestampSeconds !== pending.record.timestampSeconds ||
      (command === RUPTELA_COMMAND.EXTENDED_RECORDS &&
        part.record.timestampExtension !== pending.record.timestampExtension)
    ) {
      throw new RuptelaProtocolError("invalid_merged_record_sequence");
    }
    pending.record.io.push(...part.record.io);
    pending.raw.push(part.raw);
    pending.next++;
    if (pending.next === pending.total) {
      pending.record.fingerprint = fingerprint(command, pending.raw);
      records.push(pending.record);
      pending = null;
    }
  }
  if (pending) throw new RuptelaProtocolError("incomplete_merged_record");
  if (reader.remaining !== 0) throw new RuptelaProtocolError("trailing_packet_data");
  return { recordsLeft: recordsLeft === 1, declaredCount, records };
}
