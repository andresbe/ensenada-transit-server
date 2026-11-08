const { crc16Kermit } = require("../dist/ruptela/protocol/checksum");

function deviceFrame(imei, command, payload = Buffer.alloc(0)) {
  const body = Buffer.alloc(9 + payload.length);
  body.writeBigUInt64BE(BigInt(imei), 0);
  body.writeUInt8(command, 8);
  payload.copy(body, 9);
  const packet = Buffer.alloc(body.length + 4);
  packet.writeUInt16BE(body.length, 0);
  body.copy(packet, 2);
  packet.writeUInt16BE(crc16Kermit(body), packet.length - 2);
  return packet;
}

function ioBody(io, extended) {
  const parts = [];
  for (const length of [1, 2, 4, 8]) {
    const group = io.filter(element => element.length === length);
    parts.push(Buffer.from([group.length]));
    for (const element of group) {
      const id = Buffer.alloc(extended ? 2 : 1);
      if (extended) id.writeUInt16BE(element.id);
      else id.writeUInt8(element.id);
      const value = Buffer.alloc(length);
      if (length === 8) value.writeBigUInt64BE(BigInt(element.value));
      else if (length === 4) value.writeUInt32BE(element.value);
      else if (length === 2) value.writeUInt16BE(element.value);
      else value.writeUInt8(element.value);
      parts.push(id, value);
    }
  }
  return Buffer.concat(parts);
}

// Synthetic protocol fixture builder. These bytes are not represented as Eco5 hardware captures.
function recordBytes(input = {}, extended = false) {
  const record = {
    timestampSeconds: Math.floor(Date.now() / 1000),
    timestampExtension: 0,
    recordExtension: 0,
    priority: 0,
    longitude: -116.616,
    latitude: 31.866,
    altitude: 12.3,
    heading: 90,
    satellites: 10,
    speedKmh: 36,
    hdop: 1.1,
    eventId: 27,
    io: [],
    ...input,
  };
  const header = Buffer.alloc(extended ? 25 : 23);
  let offset = 0;
  header.writeUInt32BE(record.timestampSeconds, offset); offset += 4;
  header.writeUInt8(record.timestampExtension, offset++);
  if (extended) header.writeUInt8(record.recordExtension, offset++);
  header.writeUInt8(record.priority, offset++);
  header.writeInt32BE(Math.round(record.longitude * 1e7), offset); offset += 4;
  header.writeInt32BE(Math.round(record.latitude * 1e7), offset); offset += 4;
  header.writeUInt16BE(Math.round(record.altitude * 10), offset); offset += 2;
  header.writeUInt16BE(Math.round(record.heading * 100), offset); offset += 2;
  header.writeUInt8(record.satellites, offset++);
  header.writeUInt16BE(record.speedKmh, offset); offset += 2;
  header.writeUInt8(Math.round(record.hdop * 10), offset++);
  if (extended) header.writeUInt16BE(record.eventId, offset);
  else header.writeUInt8(record.eventId, offset);
  return Buffer.concat([header, ioBody(record.io, extended)]);
}

function recordsFrame(imei, records, options = {}) {
  const extended = options.extended === true;
  const payload = Buffer.concat([
    Buffer.from([options.recordsLeft ? 1 : 0, records.length]),
    ...records.map(record => recordBytes(record, extended)),
  ]);
  return deviceFrame(imei, extended ? 68 : 1, payload);
}

function dynamicIdentificationFrame(imei, parameters = []) {
  const fields = [Buffer.from([1, parameters.length])];
  for (const parameter of parameters) {
    const value = Buffer.isBuffer(parameter.value) ? parameter.value : Buffer.from(parameter.value, "ascii");
    fields.push(Buffer.from([parameter.id, value.length]), value);
  }
  return deviceFrame(imei, 18, Buffer.concat(fields));
}

module.exports = { deviceFrame, recordBytes, recordsFrame, dynamicIdentificationFrame };
