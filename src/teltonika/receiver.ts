import net, { Socket } from "net";
import { AvlRecord, decodeCodec8Extended, ProtocolError, TeltonikaFramer } from "./codec";
import { ReceiverConfig } from "./config";

export interface ReceiverDependencies {
  authorize(imei: string): Promise<string | null>;
  accept(deviceId: string, records: AvlRecord[]): Promise<{ accepted: number; inserted: number }>;
  log(event: string, fields?: Record<string, unknown>): void;
}

export function createReceiver(config: ReceiverConfig, dependencies: ReceiverDependencies) {
  const sockets = new Set<Socket>();
  const devices = new Map<string, Socket>();
  const rates = new Map<string, { start: number; count: number }>();
  const jobs = new Set<Promise<void>>();
  const metrics = { connected: 0, authorized: 0, receivedRecords: 0, insertedRecords: 0,
    duplicates: 0, invalidPackets: 0, rejected: 0, ingestionFailures: 0, timeouts: 0 };
  let closing = false;
  let inFlight = 0;
  let connectionWindow = Date.now();
  let connectionAttempts = 0;
  const server = net.createServer(socket => {
    const now = Date.now();
    if (now - connectionWindow >= 60000) { connectionWindow = now; connectionAttempts = 0; }
    if (closing || ++connectionAttempts > config.maxConnections * 4 || sockets.size >= config.maxConnections ||
        !dependenciesPeerAllowed(socket)) {
      metrics.rejected++; socket.destroy(); return;
    }
    sockets.add(socket); metrics.connected = sockets.size;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(config.idleTimeoutMs);
    const framer = new TeltonikaFramer(config.maxDataBytes, 2 * (config.maxDataBytes + 12) + 17);
    let deviceId: string | null = null;
    let processing = false;
    let deadline: NodeJS.Timeout | undefined;
    const armDeadline = () => {
      if (!deadline) deadline = setTimeout(() => { metrics.timeouts++; socket.destroy(); }, config.frameTimeoutMs);
    };
    const clearDeadline = () => { if (deadline) clearTimeout(deadline); deadline = undefined; };
    armDeadline();
    socket.on("timeout", () => { metrics.timeouts++; socket.destroy(); });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearDeadline(); sockets.delete(socket); metrics.connected = sockets.size;
      if (deviceId && devices.get(deviceId) === socket) devices.delete(deviceId);
      metrics.authorized = devices.size;
    });
    const fail = (error: unknown) => {
      if (error instanceof ProtocolError) metrics.invalidPackets++; else metrics.ingestionFailures++;
      dependencies.log(error instanceof ProtocolError ? "invalid_packet" : "ingestion_failure",
        { deviceId, reason: error instanceof ProtocolError ? error.message : "storage_or_device_unavailable" });
      if (!deviceId && !socket.destroyed) socket.end(Buffer.from([0]), () => socket.destroy());
      else socket.destroy();
    };
    const drain = async () => {
      if (processing || socket.destroyed) return;
      processing = true;
      socket.pause();
      try {
        let item;
        while (!closing && !socket.destroyed && (item = framer.next())) {
          armDeadline();
          // No unbounded promise queue during storage outages; devices retry unacknowledged frames.
          if (inFlight >= config.maxInFlight) { metrics.rejected++; socket.destroy(); return; }
          inFlight++;
          try {
            if (item.type === "imei") {
              const authorized = await dependencies.authorize(item.imei);
              if (socket.destroyed) return;
              if (!authorized) { metrics.rejected++; socket.end(Buffer.from([0]), () => socket.destroy()); return; }
              deviceId = authorized;
              devices.get(deviceId)?.destroy();
              devices.set(deviceId, socket); metrics.authorized = devices.size;
              socket.write(Buffer.from([1]));
              dependencies.log("device_connected", { deviceId });
            } else {
              if (!deviceId) throw new ProtocolError("missing_handshake");
              const stamp = Date.now();
              for (const [id, rate] of rates) if (stamp - rate.start >= 60000) rates.delete(id);
              if (!rates.has(deviceId) && rates.size >= config.maxConnections * 4) throw new ProtocolError("rate_limit");
              const rate = rates.get(deviceId) ?? { start: stamp, count: 0 };
              rates.set(deviceId, rate);
              if (++rate.count > config.framesPerMinute) throw new ProtocolError("rate_limit");
              const records = decodeCodec8Extended(item.frame, config.maxDataBytes);
              const result = await dependencies.accept(deviceId, records);
              if (result.accepted !== records.length) throw new Error("incomplete_acceptance");
              metrics.receivedRecords += result.accepted;
              metrics.insertedRecords += result.inserted;
              metrics.duplicates += result.accepted - result.inserted;
              if (!socket.destroyed) {
                const ack = Buffer.alloc(4); ack.writeUInt32BE(result.accepted); socket.write(ack);
              }
            }
          } finally { inFlight--; }
          clearDeadline();
        }
      } catch (error) { fail(error); }
      finally {
        processing = false;
        if (closing) socket.end();
        else if (!socket.destroyed) {
          if (!deviceId || framer.pendingBytes) armDeadline();
          else clearDeadline();
          socket.resume();
        }
      }
    };
    socket.on("data", chunk => {
      try {
        framer.append(chunk); armDeadline();
        const job = drain(); jobs.add(job); void job.finally(() => jobs.delete(job));
      } catch (error) { fail(error); }
    });
  });
  function dependenciesPeerAllowed(socket: Socket) { return config.peerAllowed(socket.remoteAddress ?? ""); }
  return {
    server, metrics,
    async close() {
      closing = true;
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...jobs]);
      for (const socket of sockets) socket.destroy();
      await stopped;
    },
  };
}
