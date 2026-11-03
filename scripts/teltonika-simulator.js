const net = require("node:net");
const { parseArgs } = require("node:util");
const { crc16IBM } = require("../dist/teltonika/codec");

function handshake(imei) {
  if (!/^[0-9]{15}$/.test(imei)) throw new Error("IMEI must contain 15 digits.");
  return Buffer.concat([Buffer.from([0, 15]), Buffer.from(imei)]);
}

function encodePacket(records) {
  if (!records.length || records.length > 255) throw new Error("Use 1-255 records.");
  const chunks = [Buffer.from([0x8e, records.length])];
  const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
  for (const record of records) {
    const gps = Buffer.alloc(26);
    gps.writeBigUInt64BE(BigInt(record.timestamp), 0);
    gps.writeUInt8(record.priority ?? 0, 8);
    gps.writeInt32BE(Math.round(record.longitude * 1e7), 9);
    gps.writeInt32BE(Math.round(record.latitude * 1e7), 13);
    gps.writeInt16BE(record.altitude ?? 12, 17);
    gps.writeUInt16BE(record.heading ?? 90, 19);
    gps.writeUInt8(record.satellites ?? 8, 21);
    gps.writeUInt16BE(record.speedKmh ?? 36, 22);
    gps.writeUInt16BE(record.eventId ?? 0, 24);
    const io = record.io ?? [];
    chunks.push(gps, u16(io.length));
    for (const size of [1, 2, 4, 8, 0]) {
      const group = io.filter(element => (element.variable ? 0 : element.value.length) === size);
      chunks.push(u16(group.length));
      for (const element of group) {
        chunks.push(u16(element.id));
        if (size === 0) chunks.push(u16(element.value.length));
        chunks.push(element.value);
      }
    }
  }
  chunks.push(Buffer.from([records.length]));
  const data = Buffer.concat(chunks);
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length, 4);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc16IBM(data));
  return Buffer.concat([header, data, crc]);
}

async function main() {
  const { values } = parseArgs({ options: {
    host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "5027" },
    imei: { type: "string" }, latitude: { type: "string", default: "31.866" }, longitude: { type: "string", default: "-116.616" },
    records: { type: "string", default: "2" }, fragment: { type: "boolean", default: false },
    "allow-remote": { type: "boolean", default: false },
  } });
  if (!["127.0.0.1", "::1", "localhost"].includes(values.host) && !values["allow-remote"]) {
    throw new Error("Remote traffic disabled. Use an explicit --host and --allow-remote only for an approved test target.");
  }
  if (!values.imei) throw new Error("Provide --imei for a registered test device.");
  const count = Number(values.records), port = Number(values.port), latitude = Number(values.latitude), longitude = Number(values.longitude);
  if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(port) || port < 1 || port > 65535 ||
    !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error("Invalid simulator arguments.");
  const packet = encodePacket(Array.from({ length: count }, (_, index) => ({ timestamp: Date.now() - (count - index - 1) * 30000, latitude, longitude })));
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, values.host);
    let buffer = Buffer.alloc(0), accepted = false;
    const timeout = setTimeout(() => socket.destroy(new Error("Timed out waiting for ACK.")), 10000);
    const send = bytes => {
      if (values.fragment) for (let offset = 0; offset < bytes.length; offset += 7) socket.write(bytes.subarray(offset, offset + 7));
      else socket.write(bytes);
    };
    socket.on("connect", () => send(handshake(values.imei)));
    socket.on("error", reject);
    socket.on("close", () => { clearTimeout(timeout); reject(new Error("Connection closed before record ACK.")); });
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!accepted && buffer.length) {
        if (buffer[0] !== 1) { socket.destroy(new Error("Device rejected.")); return; }
        buffer = buffer.subarray(1); accepted = true; send(packet);
      }
      if (accepted && buffer.length >= 4) {
        if (buffer.readUInt32BE() !== count) { socket.destroy(new Error("Incorrect record ACK.")); return; }
        console.log(JSON.stringify({ event: "simulator_accepted", records: count }));
        clearTimeout(timeout); resolve(); socket.end();
      }
    });
  });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { encodePacket, handshake };
