const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { createReceiver } = require("../dist/ruptela/receiver");
const { receiverConfig } = require("../dist/ruptela/config");
const { identificationAck, recordsAck } = require("../dist/ruptela/protocol/encoder");
const { deviceFrame, dynamicIdentificationFrame, recordsFrame } = require("./ruptela-fixtures");

const imei = "863071016796572";

async function harness(t, overrides = {}, config = {}) {
  const receiver = createReceiver({ ...receiverConfig({}), ...config }, {
    authorize: async value => value === imei ? "device-id" : null,
    accept: async (_deviceId, records) => ({ accepted: records.length, inserted: records.length }),
    log() {},
    ...overrides,
  });
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");
  t.after(() => receiver.close());
  async function connect() {
    const socket = net.connect(receiver.server.address().port, "127.0.0.1");
    const bytes = [];
    socket.on("data", value => bytes.push(value));
    socket.on("error", () => {});
    await once(socket, "connect");
    t.after(() => socket.destroy());
    return {
      socket,
      bytes,
      async waitBytes(length) {
        const deadline = Date.now() + 2000;
        while (Buffer.concat(bytes).length < length && Date.now() < deadline && !socket.destroyed) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return Buffer.concat(bytes);
      },
      async waitClosed() {
        const deadline = Date.now() + 2000;
        while (!socket.destroyed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      },
    };
  }
  return { receiver, connect };
}

test("identification, fragmented/coalesced records and ACK only after durable acceptance", { timeout: 6000 }, async t => {
  let release;
  const committed = new Promise(resolve => { release = resolve; });
  const { receiver, connect } = await harness(t, {
    accept: async (_deviceId, records) => {
      await committed;
      return { accepted: records.length, inserted: records.length };
    },
  });
  const connection = await connect();
  const identification = dynamicIdentificationFrame(imei, [
    { id: 1, value: "Ec05" },
    { id: 2, value: "00.06.82.24" },
  ]);
  connection.socket.write(identification.subarray(0, 3));
  connection.socket.write(identification.subarray(3));
  assert.deepEqual(await connection.waitBytes(6), identificationAck(true));

  const first = recordsFrame(imei, [{}]);
  const second = recordsFrame(imei, [{ timestampExtension: 1 }]);
  connection.socket.write(Buffer.concat([first, second]));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(Buffer.concat(connection.bytes).length, 6, "no records ACK before persistence commits");
  release();
  const expected = Buffer.concat([identificationAck(true), recordsAck(true), recordsAck(true)]);
  assert.deepEqual(await connection.waitBytes(expected.length), expected);
  assert.equal(receiver.metrics.receivedRecords, 2);
  assert.equal(receiver.metrics.insertedRecords, 2);
});

test("unknown or inactive devices are rejected without a successful records ACK", async t => {
  const { connect, receiver } = await harness(t);
  const identification = await connect();
  identification.socket.write(dynamicIdentificationFrame("111111111111111", []));
  assert.deepEqual(await identification.waitBytes(7), identificationAck(false));
  await identification.waitClosed();

  const records = await connect();
  records.socket.write(recordsFrame("111111111111111", [{}]));
  await records.waitClosed();
  assert.equal(Buffer.concat(records.bytes).length, 0);
  assert.equal(receiver.metrics.rejected, 2);
});

test("checksum, malformed payload and storage failures never receive a positive ACK", async t => {
  const captures = [];
  const { connect, receiver } = await harness(t, {
    accept: async () => { throw new Error("database unavailable"); },
    capture: async diagnostic => captures.push(diagnostic),
  }, { diagnosticCapture: true });

  const corrupt = await connect();
  const corruptFrame = recordsFrame(imei, [{}]);
  corruptFrame[corruptFrame.length - 1] ^= 1;
  corrupt.socket.write(corruptFrame);
  await corrupt.waitClosed();
  assert.equal(Buffer.concat(corrupt.bytes).length, 0);

  const malformed = await connect();
  malformed.socket.write(deviceFrame(imei, 1, Buffer.from([0, 1])));
  assert.deepEqual(await malformed.waitBytes(6), recordsAck(false));
  await malformed.waitClosed();
  assert.equal(captures.length, 1);
  assert.equal(captures[0].reason, "truncated_packet");
  assert.ok(Buffer.isBuffer(captures[0].rawPacket));

  const storage = await connect();
  storage.socket.write(recordsFrame(imei, [{}]));
  assert.deepEqual(await storage.waitBytes(6), recordsAck(false));
  await storage.waitClosed();
  assert.equal(receiver.metrics.ingestionFailures, 1);
  assert.ok(receiver.metrics.invalidPackets >= 2);
});

test("reconnection supersedes the old socket and retransmission is acknowledged", async t => {
  const seen = new Set();
  const { connect, receiver } = await harness(t, {
    accept: async (_deviceId, records) => {
      let inserted = 0;
      for (const record of records) {
        if (!seen.has(record.fingerprint)) {
          seen.add(record.fingerprint);
          inserted++;
        }
      }
      return { accepted: records.length, inserted };
    },
  });
  const frame = recordsFrame(imei, [{}]);
  const first = await connect();
  first.socket.write(frame);
  assert.deepEqual(await first.waitBytes(6), recordsAck(true));
  const second = await connect();
  second.socket.write(frame);
  assert.deepEqual(await second.waitBytes(6), recordsAck(true));
  await first.waitClosed();
  assert.equal(receiver.metrics.duplicates, 1);
  assert.equal(receiver.metrics.authorized, 1);
});

test("partial frame timeout, connection cap, rate limit and peer allowlist are bounded", async t => {
  const { connect, receiver } = await harness(t, {}, {
    frameTimeoutMs: 40,
    maxConnections: 1,
    framesPerMinute: 1,
  });
  const partial = await connect();
  partial.socket.write(Buffer.from([0]));
  await partial.waitClosed();
  assert.equal(receiver.metrics.timeouts, 1);

  const active = await connect();
  active.socket.write(recordsFrame(imei, [{}]));
  await active.waitBytes(6);
  const extra = await connect();
  await extra.waitClosed();
  active.socket.write(recordsFrame(imei, [{ timestampExtension: 1 }]));
  await active.waitClosed();
  assert.deepEqual(Buffer.concat(active.bytes), Buffer.concat([recordsAck(true), recordsAck(false)]));
  assert.ok(receiver.metrics.rejected >= 1);

  const config = receiverConfig({ RUPTELA_ALLOWED_PEERS: "127.0.0.1/32" });
  assert.equal(config.peerAllowed("::ffff:127.0.0.1"), true);
  assert.equal(config.peerAllowed("192.0.2.1"), false);
  assert.throws(() => receiverConfig({ PORT: "5028" }));
  assert.throws(() => receiverConfig({ RUPTELA_MAX_FRAME_BYTES: "1025" }));
});
