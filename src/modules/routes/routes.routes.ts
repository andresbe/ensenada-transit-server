import { Router } from "express";
import { getLiveBusesByRouteVariant } from "./routes.controller";

export const routesRouter = Router();

routesRouter.get("/:routeVariantId/live", getLiveBusesByRouteVariant);
