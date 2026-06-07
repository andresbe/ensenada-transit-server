import { app } from "./app";
import { env } from "./config/env";

const server = app.listen(env.port, () => {
  console.log(`[server] Ensenada Transit server listening on port ${env.port}`);
});

// ── Graceful shutdown ─────────────────────────────────────────
const shutdown = (signal: string) => {
  console.log(`[server] Received ${signal} – shutting down gracefully…`);
  server.close(() => {
    console.log("[server] HTTP server closed.");
    process.exit(0);
  });

  // Force exit after 10 s if connections are still open
  setTimeout(() => {
    console.error("[server] Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
