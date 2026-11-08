import { RuptelaProtocolError } from "./types";

export class RuptelaFramer {
  private buffer = Buffer.alloc(0);

  constructor(
    readonly maxFrameBytes = 1024,
    readonly maxBufferedBytes = maxFrameBytes * 2,
  ) {}

  get pendingBytes() {
    return this.buffer.length;
  }

  append(chunk: Buffer): void {
    if (chunk.length + this.buffer.length > this.maxBufferedBytes) {
      throw new RuptelaProtocolError("buffer_limit");
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  next(): Buffer | undefined {
    if (this.buffer.length < 2) return;
    const bodyLength = this.buffer.readUInt16BE(0);
    // Device packets always carry an 8-byte IMEI and a 1-byte command.
    if (bodyLength < 9 || bodyLength + 4 > this.maxFrameBytes) {
      throw new RuptelaProtocolError("invalid_length");
    }
    const frameLength = bodyLength + 4;
    if (this.buffer.length < frameLength) return;
    const frame = this.buffer.subarray(0, frameLength);
    this.buffer = this.buffer.subarray(frameLength);
    return frame;
  }
}
