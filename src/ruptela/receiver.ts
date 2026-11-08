import net, { Socket } from "net";
import { ReceiverConfig } from "./config";
import { decodeEnvelope, decodeIdentification, decodeRecords } from "./protocol/decoder";
import { identificationAck, heartbeatAck, recordsAck } from "./protocol/encoder";
import { RuptelaFramer } from "./protocol/framing";
import {
  RUPTELA_COMMAND,
  RuptelaEnvelope,
  RuptelaProtocolError,
  RuptelaRecord,
} from "./protocol/types";

export interface ReceiverDependencies {
  authorize(imei: string): Promise<string | null>;
  accept(deviceId: string, records: RuptelaRecord[]): Promise<{ accepted: number; inserted: number }>;
  capture?(diagnostic: {
    deviceId: string;
    command: number;
    packetHash: string;
    byteLength: number;
    reason: string;
    rawPacket?: Buffer;
  }): Promise<void>;
  log(event: string, fields?: Record<string, unknown>): void;
}

const isRecordsCommand = (command: number) =>
  command === RUPTELA_COMMAND.RECORDS || command === RUPTELA_COMMAND.EXTENDED_RECORDS;

const isIdentificationCommand = (command: number) =>
  command === RUPTELA_COMMAND.IDENTIFICATION || command === RUPTELA_COMMAND.DYNAMIC_IDENTIFICATION;

export function createReceiver(config: ReceiverConfig, dependencies: ReceiverDependencies) {
  const sockets = new Set<Socket>();
  const devices = new Map<string, Socket>();
  const rates = new Map<string, { start: number; count: number }>();
  const jobs = new Set<Promise<void>>();
  const metrics = {
    connected: 0,
    authorized: 0,
    receivedPackets: 0,
    receivedRecords: 0,
    insertedRecords: 0,
    duplicates: 0,
    invalidPackets: 0,
    unsupportedPackets: 0,
    rejected: 0,
    ingestionFailures: 0,
    negativeAcks: 0,
    timeouts: 0,
  };
  let closing = false;
  let inFlight = 0;
  let connectionWindow = Date.now();
  let connectionAttempts = 0;

  const server = net.createServer(socket => {
    const now = Date.now();
    if (now - connectionWindow >= 60000) {
      connectionWindow = now;
      connectionAttempts = 0;
    }
    if (
      closing ||
      ++connectionAttempts > config.maxConnections * 4 ||
      sockets.size >= config.maxConnections ||
      !peerAllowed(socket)
    ) {
      metrics.rejected++;
      socket.destroy();
      return;
    }

    sockets.add(socket);
    metrics.connected = sockets.size;
    dependencies.log("connection_accepted", { connections: metrics.connected });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(config.idleTimeoutMs);
    const framer = new RuptelaFramer(config.maxFrameBytes, config.maxFrameBytes * 16);
    let deviceId: string | null = null;
    let imei: string | null = null;
    let processing = false;
    let deadline: NodeJS.Timeout | undefined;

    const armDeadline = () => {
      if (!deadline) {
        deadline = setTimeout(() => {
          metrics.timeouts++;
          socket.destroy();
        }, config.frameTimeoutMs);
      }
    };
    const clearDeadline = () => {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
    };
    const respondAndClose = (response?: Buffer) => {
      if (socket.destroyed) return;
      if (response) socket.end(response, () => socket.destroy());
      else socket.destroy();
    };

    armDeadline();
    socket.on("timeout", () => {
      metrics.timeouts++;
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearDeadline();
      sockets.delete(socket);
      metrics.connected = sockets.size;
      if (deviceId && devices.get(deviceId) === socket) devices.delete(deviceId);
      metrics.authorized = devices.size;
      dependencies.log("device_disconnected", { deviceId, connections: metrics.connected });
    });

    const drain = async () => {
      if (processing || socket.destroyed) return;
      processing = true;
      socket.pause();
      let activeFrame: Buffer | undefined;
      let activeEnvelope: RuptelaEnvelope | undefined;
      try {
        while (!closing && !socket.destroyed && (activeFrame = framer.next())) {
          armDeadline();
          if (inFlight >= config.maxInFlight) {
            metrics.rejected++;
            socket.destroy();
            return;
          }
          inFlight++;
          try {
            activeEnvelope = decodeEnvelope(activeFrame, config.maxFrameBytes);
            metrics.receivedPackets++;
            dependencies.log("packet_received", {
              deviceId,
              command: activeEnvelope.command,
              byteLength: activeFrame.length,
              packetHash: activeEnvelope.packetHash.slice(0, 12),
            });
            if (imei && activeEnvelope.imei !== imei) {
              throw new RuptelaProtocolError("imei_changed_on_connection");
            }
            if (!deviceId) {
              const authorized = await dependencies.authorize(activeEnvelope.imei);
              if (socket.destroyed) return;
              if (!authorized) {
                metrics.rejected++;
                dependencies.log("unknown_imei", { imeiSuffix: activeEnvelope.imei.slice(-4) });
                respondAndClose(isIdentificationCommand(activeEnvelope.command) ? identificationAck(false) : undefined);
                return;
              }
              deviceId = authorized;
              imei = activeEnvelope.imei;
              devices.get(deviceId)?.destroy();
              devices.set(deviceId, socket);
              metrics.authorized = devices.size;
              dependencies.log("device_authorized", { deviceId, imeiSuffix: imei.slice(-4) });
            }

            const stamp = Date.now();
            for (const [id, rate] of rates) {
              if (stamp - rate.start >= 60000) rates.delete(id);
            }
            if (!rates.has(deviceId) && rates.size >= config.maxConnections * 4) {
              throw new RuptelaProtocolError("rate_limit");
            }
            const rate = rates.get(deviceId) ?? { start: stamp, count: 0 };
            rates.set(deviceId, rate);
            if (++rate.count > config.framesPerMinute) throw new RuptelaProtocolError("rate_limit");

            if (isIdentificationCommand(activeEnvelope.command)) {
              const identification = decodeIdentification(activeEnvelope.command, activeEnvelope.payload);
              if (!socket.destroyed) socket.write(identificationAck(true));
              dependencies.log("device_identified", {
                deviceId,
                command: activeEnvelope.command,
                protocolVersion: identification.version,
                model: identification.model,
                firmwareVersion: identification.firmwareVersion,
              });
            } else if (activeEnvelope.command === RUPTELA_COMMAND.HEARTBEAT) {
              if (activeEnvelope.payload.length !== 0) throw new RuptelaProtocolError("invalid_heartbeat");
              if (!socket.destroyed) socket.write(heartbeatAck());
              dependencies.log("heartbeat_acknowledged", { deviceId });
            } else if (isRecordsCommand(activeEnvelope.command)) {
              const packet = decodeRecords(activeEnvelope.command, activeEnvelope.payload);
              dependencies.log("packet_decoded", {
                deviceId,
                command: activeEnvelope.command,
                declaredRecords: packet.declaredCount,
                normalizedRecords: packet.records.length,
                recordsLeft: packet.recordsLeft,
              });
              const result = await dependencies.accept(deviceId, packet.records);
              if (result.accepted !== packet.records.length) throw new Error("incomplete_acceptance");
              metrics.receivedRecords += result.accepted;
              metrics.insertedRecords += result.inserted;
              metrics.duplicates += result.accepted - result.inserted;
              if (!socket.destroyed) socket.write(recordsAck(true));
              dependencies.log("gps_records_persisted", {
                deviceId,
                accepted: result.accepted,
                inserted: result.inserted,
                duplicates: result.accepted - result.inserted,
              });
            } else {
              metrics.unsupportedPackets++;
              throw new RuptelaProtocolError("unsupported_command");
            }
          } finally {
            inFlight--;
          }
          activeFrame = undefined;
          activeEnvelope = undefined;
          clearDeadline();
        }
      } catch (error) {
        const protocolError = error instanceof RuptelaProtocolError;
        if (protocolError) metrics.invalidPackets++;
        else metrics.ingestionFailures++;
        const reason = protocolError ? error.message : "storage_or_device_unavailable";
        dependencies.log(protocolError ? "invalid_packet" : "ingestion_failure", {
          deviceId,
          command: activeEnvelope?.command,
          packetHash: activeEnvelope?.packetHash.slice(0, 12),
          reason,
        });
        if (
          protocolError &&
          config.diagnosticCapture &&
          deviceId &&
          activeEnvelope &&
          activeFrame &&
          dependencies.capture
        ) {
          try {
            await dependencies.capture({
              deviceId,
              command: activeEnvelope.command,
              packetHash: activeEnvelope.packetHash,
              byteLength: activeFrame.length,
              reason,
              rawPacket: Buffer.from(activeFrame),
            });
          } catch {
            dependencies.log("diagnostic_capture_failure", { deviceId, reason: "storage_unavailable" });
          }
        }
        if (activeEnvelope && isRecordsCommand(activeEnvelope.command) && deviceId) {
          metrics.negativeAcks++;
          respondAndClose(recordsAck(false));
        } else {
          respondAndClose();
        }
      } finally {
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
        framer.append(chunk);
        armDeadline();
        const job = drain();
        jobs.add(job);
        void job.finally(() => jobs.delete(job));
      } catch (error) {
        metrics.invalidPackets++;
        dependencies.log("invalid_packet", {
          deviceId,
          reason: error instanceof Error ? error.message : "framing_error",
        });
        socket.destroy();
      }
    });
  });

  function peerAllowed(socket: Socket) {
    return config.peerAllowed(socket.remoteAddress ?? "");
  }

  return {
    server,
    metrics,
    async close() {
      closing = true;
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...jobs]);
      for (const socket of sockets) socket.destroy();
      await stopped;
    },
  };
}
