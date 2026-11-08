const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeEnvelope,
  decodeIdentification,
  decodeRecords,
} = require("../dist/ruptela/protocol/decoder");
const { crc16Kermit } = require("../dist/ruptela/protocol/checksum");
const {
  heartbeatAck,
  identificationAck,
  recordsAck,
} = require("../dist/ruptela/protocol/encoder");
const { RuptelaFramer } = require("../dist/ruptela/protocol/framing");
const { RuptelaProtocolError } = require("../dist/ruptela/protocol/types");
const { normalizeRecord } = require("../dist/ruptela/normalize");
const { dynamicIdentificationFrame, recordsFrame } = require("./ruptela-fixtures");

const imei = "863071016796572";

test("documented Ruptela acknowledgments use CRC-CCITT/Kermit", () => {
  assert.equal(recordsAck(true).toString("hex"), "0002640113bc");
  assert.equal(recordsAck(false).toString("hex"), "000264000235");
  assert.equal(identificationAck(true).toString("hex"), "00027301cb25");
  assert.equal(identificationAck(false).toString("hex"), "00037302b4afa3");
  assert.equal(heartbeatAck().toString("hex"), "00027401862d");
  assert.equal(crc16Kermit(Buffer.from("6401", "hex")), 0x13bc);
});

test("public upstream identification and location fixtures decode without invented offsets", () => {
  // Public Traccar regression fixtures for the generic Ruptela protocol; not an Eco5 capture.
  const identification = Buffer.from("002e000316d53d58d6020f4573303430302e30332e36382e30340000c2b3090d0e950000827b000003e80000003c003c1681", "hex");
  const identified = decodeEnvelope(identification);
  assert.equal(identified.imei, "869530043209218");
  assert.deepEqual(decodeIdentification(identified.command, identified.payload), {
    version: null,
    model: "Es04",
    firmwareVersion: "00.03.68.04",
  });

  const frame = Buffer.from("0050000310f5615f419c0100015613d8ed0000fff5b37a035af37801e700000900000d07071b0c020003001c01202cad000500064302a81d33e61e100116317cd3ffff174ad60241000077fa960000f232003c2e", "hex");
  const envelope = decodeEnvelope(frame);
  const packet = decodeRecords(envelope.command, envelope.payload);
  assert.equal(envelope.imei, imei);
  assert.equal(packet.declaredCount, 1);
  assert.equal(packet.records[0].timestamp, 1444141293000);
  assert.equal(packet.records[0].longitude, -0.067495);
  assert.equal(packet.records[0].latitude, 5.6292216);
  assert.equal(packet.records[0].satellites, 9);
  const telemetry = normalizeRecord(packet.records[0], "device-id", null, 1444141300000);
  assert.equal(telemetry.externalPowerVolts, 13.286);
  assert.equal(telemetry.gsmSignalLevel, 12);
  assert.equal(telemetry.networkOperator, 62002);
});

test("synthetic standard and extended packets preserve records, IO and merge fragments", () => {
  const seconds = 1760000000;
  const standard = decodeEnvelope(recordsFrame(imei, [
    { timestampSeconds: seconds, timestampExtension: 0, latitude: 31.866, longitude: -116.616 },
    { timestampSeconds: seconds, timestampExtension: 1, latitude: 31.867, longitude: -116.615 },
  ]));
  const standardRecords = decodeRecords(standard.command, standard.payload).records;
  assert.equal(standardRecords.length, 2);
  assert.equal(standardRecords[1].timestamp, seconds * 1000 + 1);

  const standardFragments = decodeEnvelope(recordsFrame(imei, [
    { timestampSeconds: seconds, timestampExtension: 110, io: [{ id: 27, length: 1, value: 21 }] },
    { timestampSeconds: seconds, timestampExtension: 111, io: [{ id: 29, length: 2, value: 12700 }] },
  ]));
  const standardMerged = decodeRecords(standardFragments.command, standardFragments.payload);
  assert.equal(standardMerged.records.length, 1);
  assert.deepEqual(standardMerged.records[0].io.map(value => value.id), [27, 29]);

  const extended = decodeEnvelope(recordsFrame(imei, [
    { timestampSeconds: seconds, recordExtension: 0x10, io: [{ id: 409, length: 1, value: 1 }] },
    { timestampSeconds: seconds, recordExtension: 0x11, io: [
      { id: 762, length: 1, value: 7 },
      { id: 763, length: 1, value: 5 },
    ] },
  ], { extended: true }));
  const merged = decodeRecords(extended.command, extended.payload);
  assert.equal(merged.declaredCount, 2);
  assert.equal(merged.records.length, 1);
  assert.deepEqual(merged.records[0].io.map(value => value.id), [409, 762, 763]);
  assert.equal(normalizeRecord(merged.records[0], "device-id", null, seconds * 1000 + 1000).ignition, true);

  const incomplete = decodeEnvelope(recordsFrame(imei, [
    { timestampSeconds: seconds, recordExtension: 0x10 },
  ], { extended: true }));
  assert.throws(() => decodeRecords(incomplete.command, incomplete.payload), /incomplete_merged_record/);
});

test("dynamic identification is length-bounded and ignores sensitive IMSI content", () => {
  const envelope = decodeEnvelope(dynamicIdentificationFrame(imei, [
    { id: 1, value: "Ec05" },
    { id: 2, value: "00.06.82.24" },
    { id: 3, value: Buffer.from("0000000000000001", "hex") },
  ]));
  assert.deepEqual(decodeIdentification(envelope.command, envelope.payload), {
    version: 1,
    model: "Ec05",
    firmwareVersion: "00.06.82.24",
  });
});

test("framing supports fragments and coalesced frames and rejects bad lengths/checksums", () => {
  const first = recordsFrame(imei, [{}]);
  const second = recordsFrame(imei, [{ timestampExtension: 1 }]);
  const framer = new RuptelaFramer();
  framer.append(first.subarray(0, 1));
  assert.equal(framer.next(), undefined);
  framer.append(Buffer.concat([first.subarray(1), second]));
  assert.deepEqual(framer.next(), first);
  assert.deepEqual(framer.next(), second);
  assert.equal(framer.next(), undefined);

  const corrupt = Buffer.from(first);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decodeEnvelope(corrupt), error => error instanceof RuptelaProtocolError && error.message === "crc_mismatch");
  assert.throws(() => decodeEnvelope(first.subarray(0, -1)), /invalid_length/);
  const invalidLength = Buffer.from([0xff, 0xff]);
  const limited = new RuptelaFramer();
  limited.append(invalidLength);
  assert.throws(() => limited.next(), /invalid_length/);
});
