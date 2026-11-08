/** CRC-CCITT/Kermit: reflected polynomial 0x8408, initial value 0. */
export function crc16Kermit(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}
