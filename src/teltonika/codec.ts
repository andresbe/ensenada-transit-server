import { createHash } from "crypto";
import { validImei } from "../tracking/deviceIdentity";

export { validImei } from "../tracking/deviceIdentity";

export class ProtocolError extends Error {}

export interface AvlRecord {
  timestamp: number;
  priority: number;
  longitude: number;
  latitude: number;
  altitude: number;
  heading: number;
  satellites: number;
  speedKmh: number;
  eventId: number;
  io: Array<{ id: number; hex: string }>;
  fingerprint: string;
}

export function crc16IBM(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

class Reader {
  offset = 0;
  constructor(readonly data: Buffer) {}
  take(size: number): Buffer {
    if (size < 0 || this.offset + size > this.data.length) throw new ProtocolError("truncated_record");
    const bytes = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return bytes;
  }
  u8() { return this.take(1).readUInt8(); }
  u16() { return this.take(2).readUInt16BE(); }
}

export function decodeCodec8Extended(frame: Buffer, maxDataBytes = 64 * 1024): AvlRecord[] {
  if (frame.length < 12 || frame.readUInt32BE(0) !== 0) throw new ProtocolError("invalid_preamble");
  const length = frame.readUInt32BE(4);
  if (length < 3 || length > maxDataBytes || frame.length !== length + 12) throw new ProtocolError("invalid_length");
  const data = frame.subarray(8, 8 + length);
  if (frame.readUInt32BE(8 + length) !== crc16IBM(data)) throw new ProtocolError("crc_mismatch");
  const reader = new Reader(data);
  if (reader.u8() !== 0x8e) throw new ProtocolError("unsupported_codec");
  const count = reader.u8();
  // Each Codec 8E record requires 38 bytes even with no IO elements.
  if (!count || count * 38 + 3 > length) throw new ProtocolError("invalid_record_count");
  const records: AvlRecord[] = [];
  for (let index = 0; index < count; index++) {
    const start = reader.offset;
    const timestamp = reader.take(8).readBigUInt64BE();
    if (timestamp > 8640000000000000n) throw new ProtocolError("timestamp_overflow");
    const priority = reader.u8();
    if (priority > 2) throw new ProtocolError("invalid_priority");
    const longitude = reader.take(4).readInt32BE() / 1e7;
    const latitude = reader.take(4).readInt32BE() / 1e7;
    const altitude = reader.take(2).readInt16BE();
    const heading = reader.u16();
    const satellites = reader.u8();
    const speedKmh = reader.u16();
    const eventId = reader.u16();
    const total = reader.u16();
    const io: AvlRecord["io"] = [];
    for (const size of [1, 2, 4, 8, 0]) {
      const elements = reader.u16();
      if (io.length + elements > total) throw new ProtocolError("invalid_io_count");
      for (let n = 0; n < elements; n++) {
        const id = reader.u16();
        const bytes = reader.take(size || reader.u16());
        io.push({ id, hex: bytes.toString("hex") });
      }
    }
    if (io.length !== total) throw new ProtocolError("invalid_io_count");
    records.push({ timestamp: Number(timestamp), priority, longitude, latitude, altitude,
      heading, satellites, speedKmh, eventId, io,
      fingerprint: createHash("sha256").update(data.subarray(start, reader.offset)).digest("hex") });
  }
  if (reader.u8() !== count || reader.offset !== length) throw new ProtocolError("record_count_mismatch");
  return records;
}

/** Stateful framing only; authorization and durable ingestion belong to the receiver. */
export class TeltonikaFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private handshake = true;
  constructor(readonly maxDataBytes = 65536, readonly maxBufferedBytes = 131096) {}
  get pendingBytes() { return this.buffer.length; }
  append(chunk: Buffer): void {
    if (chunk.length + this.buffer.length > this.maxBufferedBytes) throw new ProtocolError("buffer_limit");
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }
  next(): { type: "imei"; imei: string } | { type: "avl"; frame: Buffer } | undefined {
    if (this.handshake) {
      if (this.buffer.length < 2) return;
      if (this.buffer.readUInt16BE(0) !== 15) throw new ProtocolError("invalid_imei_length");
      if (this.buffer.length < 17) return;
      // latin1 does not mask the high bit like Buffer's ASCII decoder.
      const imei = this.buffer.subarray(2, 17).toString("latin1");
      if (!validImei(imei)) throw new ProtocolError("invalid_imei");
      this.buffer = this.buffer.subarray(17);
      this.handshake = false;
      return { type: "imei", imei };
    }
    if (this.buffer.length < 8) return;
    const length = this.buffer.readUInt32BE(4);
    if (this.buffer.readUInt32BE(0) !== 0) throw new ProtocolError("invalid_preamble");
    if (length < 3 || length > this.maxDataBytes) throw new ProtocolError("invalid_length");
    if (this.buffer.length < length + 12) return;
    const frame = this.buffer.subarray(0, length + 12);
    this.buffer = this.buffer.subarray(length + 12);
    return { type: "avl", frame };
  }
}
