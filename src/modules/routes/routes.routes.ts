import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { getRouteEta } from "./routes.controller";
import { apiRateLimiter } from "../../middleware/rateLimiter";

export const routesRouter = Router();

// /routes/:routeId/live is registered once by tracking/locations.routes.ts;
// it accepts a route ID or a variant ID. ETA always uses a variant ID.
routesRouter.get("/:routeVariantId/eta", apiRateLimiter, asyncHandler(getRouteEta));
