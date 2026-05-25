import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { locationsRouter } from "./modules/locations/locations.routes";
import { routesRouter } from "./modules/routes/routes.routes";
import { errorHandler, notFoundHandler } from "./shared/errors";
import { sendSuccess } from "./shared/response";

export const app = express();

app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => {
  return sendSuccess(res, {
    status: "ok",
    service: "ensenada-transit-location-service",
  });
});

app.use(locationsRouter);
app.use("/routes", routesRouter);

app.use(notFoundHandler);
app.use(errorHandler);
