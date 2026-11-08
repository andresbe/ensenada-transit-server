import "../config/env";
import { BlockList, isIP } from "net";

export function receiverConfig(values = process.env) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const number = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${name} must be between ${min} and ${max}.`);
    }
    return number;
  };
  const boolean = (name: string, fallback: boolean) => {
    const value = values[name];
    if (value === undefined) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${name} must be true or false.`);
  };
  const allowedPeers = new BlockList();
  const cidrs = (values.RUPTELA_ALLOWED_PEERS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  for (const cidr of cidrs) {
    const [address, prefix, extra] = cidr.split("/");
    const version = isIP(address);
    const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix);
    if (!version || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) {
      throw new Error("Invalid RUPTELA_ALLOWED_PEERS CIDR.");
    }
    allowedPeers.addSubnet(address, bits, version === 4 ? "ipv4" : "ipv6");
  }
  const tcpPort = integer("RUPTELA_TCP_PORT", 5028, 1, 65535);
  const healthPort = integer("PORT", 8080, 1, 65535);
  if (tcpPort === healthPort) throw new Error("PORT and RUPTELA_TCP_PORT must differ.");
  return {
    tcpPort,
    healthPort,
    maxFrameBytes: integer("RUPTELA_MAX_FRAME_BYTES", 1024, 64, 1024),
    maxConnections: integer("RUPTELA_MAX_CONNECTIONS", 600, 1, 2000),
    maxInFlight: integer("RUPTELA_MAX_IN_FLIGHT", 16, 1, 100),
    framesPerMinute: integer("RUPTELA_FRAMES_PER_MINUTE", 120, 1, 3600),
    idleTimeoutMs: integer("RUPTELA_IDLE_TIMEOUT_SECONDS", 180, 10, 3600) * 1000,
    frameTimeoutMs: integer("RUPTELA_FRAME_TIMEOUT_SECONDS", 30, 1, 120) * 1000,
    maxLiveAgeMs: integer("RUPTELA_MAX_LIVE_AGE_SECONDS", 240, 1, 3600) * 1000,
    pollMs: integer("RUPTELA_OUTBOX_POLL_MS", 1000, 100, 60000),
    diagnosticCapture: boolean("RUPTELA_DIAGNOSTIC_CAPTURE", false),
    diagnosticRetentionHours: integer("RUPTELA_DIAGNOSTIC_RETENTION_HOURS", 168, 1, 720),
    metricsToken: values.RUPTELA_METRICS_TOKEN ?? "",
    peerAllowed(address: string) {
      const ip = address.replace(/^::ffff:/, "");
      return !cidrs.length || allowedPeers.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
    },
  };
}

export type ReceiverConfig = ReturnType<typeof receiverConfig>;
