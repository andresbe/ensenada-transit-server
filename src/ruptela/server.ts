import "../config/env";
import { timingSafeEqual } from "crypto";
import { createServer } from "http";
import pool, { query } from "../db";
import redis, { connectRedis } from "../redis/client";
import { receiverConfig } from "./config";
import { createReceiver } from "./receiver";
import {
  acceptRecords,
  authorizeDevice,
  capturePacketDiagnostic,
  prunePacketDiagnostics,
  publishPending,
} from "./store";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error("DATABASE_URL and REDIS_URL are required.");
  }
  const config = receiverConfig();
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ time: new Date().toISOString(), service: "ruptela", event, ...fields }));

  // Verify the operational schema before listening. This process never executes migrations or DDL.
  await query(`SELECT d.revision,a.route_variant_id,l.delivery_status,r.event_key,p.packet_hash
    FROM tracking_devices d
    LEFT JOIN vehicle_device_assignments a ON a.device_id=d.id
    LEFT JOIN vehicle_gps_locations l ON l.device_id=d.id
    LEFT JOIN tracking_device_rejections r ON r.device_id=d.id
    LEFT JOIN tracking_device_packet_diagnostics p ON p.device_id=d.id LIMIT 0`);
  const sourceConstraints = await query(`SELECT count(*)::int AS count FROM pg_constraint
    WHERE conrelid='vehicle_gps_locations'::regclass
    AND conname IN ('vehicle_gps_locations_source_check','vehicle_gps_locations_source_shape_check')
    AND pg_get_constraintdef(oid) LIKE '%RUPTELA%'`);
  if (sourceConstraints.rows[0]?.count !== 2) throw new Error("migration_032_required");

  const receiver = createReceiver(config, {
    authorize: authorizeDevice,
    accept: acceptRecords,
    capture: diagnostic => capturePacketDiagnostic(diagnostic, config.diagnosticRetentionHours),
    log,
  });
  let stopping = false;
  let worker: Promise<void> | undefined;
  const delivery = { published: 0, skipped: 0, failures: 0 };
  const tick = () => {
    if (worker || stopping) return;
    worker = publishPending(config.maxLiveAgeMs).then(result => {
      delivery.published += result.published;
      delivery.skipped += result.skipped;
      delivery.failures += result.failures;
      if (result.published || result.skipped) {
        log("outbox_processed", { published: result.published, skipped: result.skipped });
      }
      if (result.failures) log("outbox_failure", { devices: result.failures, retry: true });
    }).catch(() => {
      delivery.failures++;
      log("outbox_failure", { retry: true });
    }).finally(() => {
      worker = undefined;
    });
  };
  const timer = setInterval(tick, config.pollMs);
  const diagnosticCleanup = setInterval(() => {
    void prunePacketDiagnostics().catch(() => log("diagnostic_cleanup_failure", { retry: true }));
  }, 60 * 60 * 1000);
  const summary = setInterval(() => log("metrics", { ...receiver.metrics, ...delivery }), 60000);
  void prunePacketDiagnostics().catch(() => log("diagnostic_cleanup_failure", { retry: true }));
  void connectRedis().catch(() => log("redis_unavailable"));

  const health = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(!stopping && receiver.server.listening ? 200 : 503)
        .end(JSON.stringify({ status: stopping ? "stopping" : "ok" }));
    } else if (req.url === "/ready") {
      void query("SELECT 1").then(() => {
        res.writeHead(!stopping && receiver.server.listening ? 200 : 503).end();
      }).catch(() => res.writeHead(503).end());
    } else if (req.url === "/metrics") {
      const token = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${config.metricsToken}`);
      if (!config.metricsToken || token.length !== expected.length || !timingSafeEqual(token, expected)) {
        res.writeHead(403).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      void query(`SELECT count(*)::int AS pending,min(received_at) AS oldest_pending_at
        FROM vehicle_gps_locations WHERE delivery_status='pending' AND source='RUPTELA'`).then(result => {
        res.end(JSON.stringify({ ...receiver.metrics, ...delivery, redisReady: redis.isReady, outbox: result.rows[0] }));
      }).catch(() => res.writeHead(503).end());
    } else {
      res.writeHead(404).end();
    }
  });

  const fatal = () => {
    log("listener_failure");
    void shutdown("listener_failure");
  };
  receiver.server.on("error", fatal);
  health.on("error", fatal);
  receiver.server.listen(config.tcpPort, "0.0.0.0", () => log("tcp_listening", { port: config.tcpPort }));
  health.listen(config.healthPort, "0.0.0.0", () => log("health_listening", { port: config.healthPort }));

  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(diagnosticCleanup);
    clearInterval(summary);
    log("shutdown", { signal });
    const forced = setTimeout(() => process.exit(1), 15000);
    forced.unref();
    const httpClosed = new Promise<void>(resolve => health.close(() => resolve()));
    await receiver.close();
    await worker;
    await httpClosed;
    if (redis.isOpen) await redis.disconnect();
    await pool.end();
    clearTimeout(forced);
    process.exitCode = signal === "listener_failure" ? 1 : 0;
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(() => {
  console.error(JSON.stringify({
    service: "ruptela",
    event: "startup_failure",
    hint: "Check configuration, database access and migrations through 032.",
  }));
  process.exit(1);
});
