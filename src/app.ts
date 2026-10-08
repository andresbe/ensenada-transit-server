import { lineManagementRouter } from "./tenancy/management.routes";
import { scopedLineRouter } from "./tenancy/scoped.routes";
import { platformRouter } from "./tenancy/platform.routes";
import { notificationsRouter } from "./passengers/notifications.routes";
import { fleetRouter } from "./fleet/fleet.routes";
import { catalogRouter } from "./passengers/catalog.routes";
import { journeyPlannerRouter } from "./passengers/journeyPlanner.routes";
import { passengerRouter } from "./passengers/passengers.routes";
import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { connectRedis } from "./redis/client";
import { authRouter } from "./auth/auth.routes";
import { adminUsersRouter } from "./admin/users.routes";
import { usersRouter } from "./users/users.routes";
import { dbRoutesRouter } from "./routes/routes.routes";
import { favoritesRouter } from "./favorites/favorites.routes";
import { reportsRouter } from "./reports/reports.routes";
import { trackingRouter } from "./tracking/locations.routes";
import { driverSessionsRouter } from "./driver-sessions/driverSessions.routes";
import { locationsService } from "./modules/locations/locations.service";
// Legacy in-memory route geometry endpoints (backward compatibility)
import { routesRouter as legacyRoutesRouter } from "./modules/routes/routes.routes";
import { errorHandler, notFoundHandler } from "./shared/errors";
import { sendSuccess } from "./shared/response";
import { appUpdatesRouter } from "./app-updates/appUpdates.routes";

export const app = express();

app.use(cors({ origin: env.corsOrigin }));
const defaultJsonParser = express.json();
app.use((req, res, next) => {
  if (/^\/admin\/lines\/[^/]+\/db-routes(?:\/|$)/i.test(req.path) && ["POST","PUT"].includes(req.method)) return next();
  // The import router authenticates before parsing its larger GeoJSON payload.
  if ((req.method === "POST" && /^\/db-routes\/import\/?$/i.test(req.path)) ||
      (req.method === "PUT" && /^\/db-routes\/[^/]+\/?$/i.test(req.path))) return next();
  return defaultJsonParser(req, res, next);
});

// ── Health check ──────────────────────────────────────────────
app.get("/health", (_req, res) => {
  return sendSuccess(res, {
    status: "ok",
    service: "ensenada-transit-server",
    version: "1.0.0",
  });
});

// ── Connect Redis (non-blocking – app still starts if Redis is down) ──
connectRedis()
  .then(() => locationsService.hydrateFromRedis())
  .catch((err) => console.error("[app] Redis connection failed on startup:", err));

// ── API routes ────────────────────────────────────────────────
app.use("/auth", authRouter);
app.use("/admin/platform",platformRouter);
app.use("/admin/lines",lineManagementRouter);
app.use("/admin/lines/:lineId",scopedLineRouter);
app.use("/updates", appUpdatesRouter);
app.use("/admin/users", adminUsersRouter);
app.use("/admin/buses", fleetRouter);
app.use("/users", usersRouter);
app.use(catalogRouter);
app.use(journeyPlannerRouter);
app.use(passengerRouter);
app.use(notificationsRouter);
app.use("/db-routes", dbRoutesRouter);
app.use("/favorites", favoritesRouter);
app.use("/reports", reportsRouter);
app.use("/driver-sessions", driverSessionsRouter);

// Tracking (new Redis-backed versions of the original endpoints)
app.use(trackingRouter);

// Legacy in-memory route geometry endpoints (ETA, live-by-variant)
app.use("/routes", legacyRoutesRouter);

// ── Error handling ────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);
