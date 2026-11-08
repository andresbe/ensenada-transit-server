import { crc16Kermit } from "./checksum";
import { RUPTELA_COMMAND } from "./types";

export function encodeServerPacket(command: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([command]), payload]);
  const packet = Buffer.alloc(body.length + 4);
  packet.writeUInt16BE(body.length, 0);
  body.copy(packet, 2);
  packet.writeUInt16BE(crc16Kermit(body), packet.length - 2);
  return packet;
}

export const recordsAck = (accepted: boolean) =>
  encodeServerPacket(100, Buffer.from([accepted ? 1 : 0]));

export const identificationAck = (accepted: boolean, delayMinutes = 180) =>
  encodeServerPacket(
    115,
    accepted ? Buffer.from([1]) : Buffer.from([2, delayMinutes]),
  );

export const heartbeatAck = () =>
  encodeServerPacket(116, Buffer.from([1]));

export function responseForCommand(command: number): Buffer | null {
  if (command === RUPTELA_COMMAND.HEARTBEAT) return heartbeatAck();
  if (
    command === RUPTELA_COMMAND.IDENTIFICATION ||
    command === RUPTELA_COMMAND.DYNAMIC_IDENTIFICATION
  ) return identificationAck(true);
  return null;
}
