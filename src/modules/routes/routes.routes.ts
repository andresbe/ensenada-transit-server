import { Router } from "express";
import { getLiveBusesByRouteVariant, getRouteEta } from "./routes.controller";

export const routesRouter = Router();

routesRouter.get("/:routeVariantId/live", getLiveBusesByRouteVariant);
routesRouter.get("/:routeVariantId/eta", getRouteEta);
