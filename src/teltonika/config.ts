import "../config/env";
import { BlockList, isIP } from "net";

export function receiverConfig(values = process.env) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const n = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}.`);
    return n;
  };
  const allowedPeers = new BlockList();
  const cidrs = (values.TELTONIKA_ALLOWED_PEERS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  for (const cidr of cidrs) {
    const [address, prefix, extra] = cidr.split("/");
    const version = isIP(address);
    const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix);
    if (!version || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) {
      throw new Error("Invalid TELTONIKA_ALLOWED_PEERS CIDR.");
    }
    allowedPeers.addSubnet(address, bits, version === 4 ? "ipv4" : "ipv6");
  }
  const tcpPort = integer("TELTONIKA_TCP_PORT", 5027, 1, 65535);
  const healthPort = integer("PORT", 8080, 1, 65535);
  if (tcpPort === healthPort) throw new Error("PORT and TELTONIKA_TCP_PORT must differ.");
  return {
    tcpPort, healthPort,
    maxDataBytes: integer("TELTONIKA_MAX_FRAME_BYTES", 65536, 1280, 262144),
    maxConnections: integer("TELTONIKA_MAX_CONNECTIONS", 600, 1, 2000),
    maxInFlight: integer("TELTONIKA_MAX_IN_FLIGHT", 16, 1, 100),
    framesPerMinute: integer("TELTONIKA_FRAMES_PER_MINUTE", 120, 1, 3600),
    idleTimeoutMs: integer("TELTONIKA_IDLE_TIMEOUT_SECONDS", 180, 10, 3600) * 1000,
    frameTimeoutMs: integer("TELTONIKA_FRAME_TIMEOUT_SECONDS", 30, 1, 120) * 1000,
    maxLiveAgeMs: integer("TELTONIKA_MAX_LIVE_AGE_SECONDS", 240, 1, 3600) * 1000,
    pollMs: integer("TELTONIKA_OUTBOX_POLL_MS", 1000, 100, 60000),
    metricsToken: values.TELTONIKA_METRICS_TOKEN ?? "",
    peerAllowed(address: string) {
      const ip = address.replace(/^::ffff:/, "");
      return !cidrs.length || allowedPeers.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
    },
  };
}

export type ReceiverConfig = ReturnType<typeof receiverConfig>;
