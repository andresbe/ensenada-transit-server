import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";
import { getLatestAndroidRelease } from "./appUpdates.service";

export const appUpdatesRouter = Router();

appUpdatesRouter.get("/android/latest.json", asyncHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  const manifest = await getLatestAndroidRelease();
  if (!manifest) throw new AppError("No Android release published", 404);
  sendSuccess(res, manifest);
}));
