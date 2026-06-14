import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { getLiveBusesByRouteVariant, getRouteEta } from "./routes.controller";

export const routesRouter = Router();

routesRouter.get("/:routeVariantId/live", asyncHandler(getLiveBusesByRouteVariant));
routesRouter.get("/:routeVariantId/eta", asyncHandler(getRouteEta));
