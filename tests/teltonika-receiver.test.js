const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { createReceiver } = require("../dist/teltonika/receiver");
const { receiverConfig } = require("../dist/teltonika/config");
const { encodePacket, handshake } = require("../scripts/teltonika-simulator");
const imei = "356307042441013";
const packet = () => encodePacket([{ timestamp: Date.now(), latitude: 31.866, longitude: -116.616 }]);

async function harness(t, overrides = {}, config = {}) {
  const receiver = createReceiver({ ...receiverConfig({}), ...config }, {
    authorize: async value => value === imei ? "device-id" : null,
    accept: async (_id, records) => ({ accepted: records.length, inserted: records.length }), log() {}, ...overrides,
  });
  receiver.server.listen(0, "127.0.0.1"); await once(receiver.server, "listening");
  t.after(() => receiver.close());
  async function connect() {
    const socket = net.connect(receiver.server.address().port, "127.0.0.1");
    const bytes = []; socket.on("data", b => bytes.push(b)); socket.on("error", () => {});
    await once(socket, "connect"); t.after(() => socket.destroy());
    return { socket, bytes, async waitBytes(length) {
      const end = Date.now() + 2000;
      while (Buffer.concat(bytes).length < length && Date.now() < end && !socket.destroyed) await new Promise(r => setTimeout(r, 5));
      return Buffer.concat(bytes);
    } };
  }
  return { receiver, connect };
}

test("TCP handshake, fragments, coalesced records and ACK only after durable acceptance", { timeout: 5000 }, async t => {
  let release; const committed = new Promise(r => release = r);
  const { connect, receiver } = await harness(t, { accept: async (_id, records) => { await committed; return { accepted: records.length, inserted: records.length }; } });
  const c = await connect(); const hello = handshake(imei);
  c.socket.write(hello.subarray(0, 1)); c.socket.write(hello.subarray(1));
  assert.deepEqual(await c.waitBytes(1), Buffer.from([1]));
  c.socket.write(Buffer.concat([packet(), packet()]));
  await new Promise(r => setTimeout(r, 30)); assert.equal(Buffer.concat(c.bytes).length, 1);
  release(); assert.deepEqual(await c.waitBytes(9), Buffer.from([1,0,0,0,1,0,0,0,1]));
  assert.equal(receiver.metrics.receivedRecords, 2);
});

test("unknown/disabled or invalid IMEI is rejected with 00", async t => {
  const { connect } = await harness(t);
  for (const hello of [handshake("111111111111111"), Buffer.from([0, 14])]) {
    const c = await connect(); c.socket.write(hello); assert.equal((await c.waitBytes(1))[0], 0);
  }
});

test("storage failure and corrupt packets are never acknowledged", async t => {
  const { connect, receiver } = await harness(t, { accept: async () => { throw new Error("database down"); } });
  for (const corrupt of [false, true]) {
    const c = await connect(); c.socket.write(handshake(imei)); await c.waitBytes(1);
    const frame = packet(); if (corrupt) frame[20] ^= 1;
    c.socket.write(frame); await once(c.socket, "close"); assert.equal(Buffer.concat(c.bytes).length, 1);
  }
  assert.equal(receiver.metrics.ingestionFailures, 1); assert.equal(receiver.metrics.invalidPackets, 1);
});

test("reconnection supersedes old socket; retransmitted records get the full ACK", async t => {
  const seen = new Set();
  const { connect, receiver } = await harness(t, { accept: async (_id, records) => {
    let inserted = 0; for (const record of records) if (!seen.has(record.fingerprint)) { seen.add(record.fingerprint); inserted++; }
    return { accepted: records.length, inserted };
  } });
  const first = await connect(); const frame = packet();
  first.socket.write(Buffer.concat([handshake(imei), frame])); await first.waitBytes(5);
  const closed = once(first.socket, "close");
  const second = await connect(); second.socket.write(Buffer.concat([handshake(imei), frame]));
  assert.equal((await second.waitBytes(5)).readUInt32BE(1), 1); await closed;
  assert.equal(receiver.metrics.duplicates, 1); assert.equal(receiver.metrics.authorized, 1);
});

test("partial frame deadline, peer controls, connection cap and per-device rate limit", async t => {
  const { connect, receiver } = await harness(t, {}, { frameTimeoutMs: 40, maxConnections: 1, framesPerMinute: 1 });
  const c = await connect(); c.socket.write(Buffer.from([0])); await once(c.socket, "close");
  assert.equal(receiver.metrics.timeouts, 1);
  const live = await connect(); live.socket.write(handshake(imei)); await live.waitBytes(1);
  const extra = await connect(); if (!extra.socket.destroyed) await once(extra.socket, "close");
  live.socket.write(Buffer.concat([packet(), packet()])); await once(live.socket, "close");
  assert.equal(Buffer.concat(live.bytes).length, 5);
  assert.ok(receiver.metrics.rejected >= 1);
  const config = receiverConfig({ TELTONIKA_ALLOWED_PEERS: "127.0.0.1/32" });
  assert.equal(config.peerAllowed("::ffff:127.0.0.1"), true); assert.equal(config.peerAllowed("192.0.2.1"), false);
  assert.throws(() => receiverConfig({ PORT: "5027" }));
});

test("concurrent devices have bounded in-flight storage; shutdown drains accepted work", async t => {
  let release; const gate = new Promise(r => release = r);
  let started = false;
  const { connect, receiver } = await harness(t, { authorize: async value => value,
    accept: async (_id, records) => { started = true; await gate; return { accepted: records.length, inserted: records.length }; },
  }, { maxInFlight: 1 });
  const first = await connect(); first.socket.write(handshake(imei)); await first.waitBytes(1);
  const second = await connect(); second.socket.write(handshake("111111111111111")); await second.waitBytes(1);
  first.socket.write(packet());
  while (!started) await new Promise(r => setTimeout(r, 2));
  second.socket.write(packet()); await once(second.socket, "close");
  assert.equal(Buffer.concat(second.bytes).length, 1, "no ACK for capacity rejection");
  const closing = receiver.close(); release(); await closing;
  assert.equal(receiver.metrics.receivedRecords, 1);
});
