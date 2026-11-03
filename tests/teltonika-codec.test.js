const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decodeCodec8Extended, crc16IBM, TeltonikaFramer } = require("../dist/teltonika/codec");
const { normalizeRecord } = require("../dist/teltonika/normalize");
const { encodePacket, handshake } = require("../scripts/teltonika-simulator");
const sample = { timestamp: 1793642400000, latitude: 31.866, longitude: -116.616 };

test("official Teltonika Codec8E example: CRC, timestamp, IO and invalid fix", () => {
  // https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended
  const frame = Buffer.from("000000000000004A8E010000016B412CEE000100000000000000000000000000000000010005000100010100010011001D00010010015E2C880002000B000000003544C87A000E000000001DD7E06A00000100002994", "hex");
  const [record] = decodeCodec8Extended(frame);
  assert.equal(crc16IBM(frame.subarray(8, -4)), 0x2994);
  assert.equal(new Date(record.timestamp).toISOString(), "2019-06-10T11:36:32.000Z");
  assert.equal(record.eventId, 1); assert.equal(record.io.length, 5);
  assert.deepEqual(record.io[4], { id: 14, hex: "000000001dd7e06a" });
  assert.equal(normalizeRecord(record, "device", "vehicle").invalidReason, "zero_coordinates");
});

test("multiple records, signed coordinates/altitude and all IO widths including NX", () => {
  const io = [1, 2, 4, 8].map((size, i) => ({ id: 300 + i, value: Buffer.alloc(size, 0xff) }));
  io.push({ id: 1200, value: Buffer.from("abcdef0123456789ab", "hex"), variable: true });
  const records = decodeCodec8Extended(encodePacket([{ ...sample, altitude: -20, io }, { ...sample, timestamp: sample.timestamp + 30000 }]));
  assert.equal(records.length, 2); assert.equal(records[0].longitude, -116.616); assert.equal(records[0].altitude, -20);
  assert.equal(records[0].io.length, 5); assert.equal(records[0].io[3].hex, "ffffffffffffffff");
  assert.equal(records[0].io[4].id, 1200);
  assert.notEqual(records[0].fingerprint, records[1].fingerprint);
  assert.equal(normalizeRecord(records[0], "d", "v", sample.timestamp).speedMps, 10);
});

test("CRC, wrong codec, inconsistent counts, truncated IO, trailing bytes and oversized lengths fail closed", () => {
  const good = encodePacket([sample]);
  const crcBad = Buffer.from(good); crcBad[20] ^= 1;
  assert.throws(() => decodeCodec8Extended(crcBad), /crc_mismatch/);
  for (const mutate of [b => b[8] = 8, b => b[b.length - 5] = 2, b => b.writeUInt16BE(65535, 36), b => b[9] = 0]) {
    const bytes = Buffer.from(good); mutate(bytes); bytes.writeUInt32BE(crc16IBM(bytes.subarray(8, -4)), bytes.length - 4);
    assert.throws(() => decodeCodec8Extended(bytes));
  }
  for (let length = 0; length < good.length; length++) assert.throws(() => decodeCodec8Extended(good.subarray(0, length)));
  assert.throws(() => decodeCodec8Extended(Buffer.concat([good, Buffer.from([0])])));
  const framer = new TeltonikaFramer(); framer.append(handshake("356307042441013")); framer.next();
  const huge = Buffer.alloc(8); huge.writeUInt32BE(0xffffffff, 4); framer.append(huge);
  assert.throws(() => framer.next(), /invalid_length/);
  assert.throws(() => new TeltonikaFramer(1280, 2560).append(Buffer.alloc(2561)), /buffer_limit/);
});

test("every fragmentation boundary and coalesced handshake plus two frames", () => {
  const packet = encodePacket([sample]);
  const bytes = Buffer.concat([handshake("356307042441013"), packet, packet]);
  for (let split = 1; split < bytes.length; split++) {
    const framer = new TeltonikaFramer(); const events = [];
    for (const chunk of [bytes.subarray(0, split), bytes.subarray(split)]) {
      framer.append(chunk); let event; while ((event = framer.next())) events.push(event);
    }
    assert.equal(events.length, 3); assert.equal(events[0].imei, "356307042441013");
    assert.equal(decodeCodec8Extended(events[2].frame).length, 1);
  }
  for (const bytes of [Buffer.from([0, 16]), Buffer.concat([Buffer.from([0,15]),Buffer.from("x".repeat(15))]), Buffer.concat([Buffer.from([0,15]),Buffer.alloc(15,0xb1)])]) {
    const framer = new TeltonikaFramer(); framer.append(bytes); assert.throws(() => framer.next(), /imei/);
  }
});

test("no fix, zero/range coordinates and future times are diagnostic-only; old valid records retain timestamps", () => {
  const [record] = decodeCodec8Extended(encodePacket([sample]));
  for (const fields of [{ satellites: 0 }, { latitude: 0, longitude: 0 }, { latitude: 91 }, { longitude: -181 }, { timestamp: sample.timestamp + 60000 }, { heading: 400 }]) {
    assert.equal(normalizeRecord({ ...record, ...fields }, "d", "v", sample.timestamp).isValid, false);
  }
  const old = normalizeRecord(record, "d", null, sample.timestamp + 86400000);
  assert.equal(old.isValid, true); assert.equal(Date.parse(old.recordedAt), sample.timestamp); assert.equal(old.vehicleId, null);
});
