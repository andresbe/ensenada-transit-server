import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { getAllLiveBuses, updateLocation } from "./locations.controller";

export const locationsRouter = Router();

locationsRouter.post("/locations/update", updateLocation);
locationsRouter.get("/buses/live", asyncHandler(getAllLiveBuses));
