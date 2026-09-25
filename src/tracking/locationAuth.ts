import { Request } from "express";
import { env } from "../config/env";
import { query } from "../db";
import { AppError } from "../shared/errors";
import { LocationUpdateRequest } from "../modules/locations/locations.types";
import { getActiveAdmin } from "../auth/admin.service";

type LocationAuthUser = {
  id: string;
  role: "driver" | "admin";
};

export const validateLocationUpdateAuth = async (
  req: Request,
  payload: LocationUpdateRequest,
): Promise<void> => {
  if (!req.user) {
    if (env.locationUpdateAuthMode === "required") {
      throw new AppError("Authentication token is required for location updates.", 401);
    }

    return;
  }

  if (req.user.identityType === "admin") {
    await getActiveAdmin(req.user);
    return;
  }

  if (payload.sourceType !== "driver") {
    return;
  }

  if (req.user.role !== "driver") {
    throw new AppError("Driver or admin account required for driver location updates.", 403);
  }

  const result = await query<LocationAuthUser>(
    `SELECT correo AS id, 'driver' AS role
     FROM conductores
     WHERE correo = $1`,
    [req.user.sub],
  );

  const user = result.rows[0];

  if (!user) {
    throw new AppError("User not found or inactive.", 401);
  }

  if (user.role !== "driver" && user.role !== "admin") {
    throw new AppError("Driver access required for driver location updates.", 403);
  }

  if (user.role === "driver" && payload.sourceId !== user.id) {
    throw new AppError("Driver sourceId must match the authenticated user.", 403);
  }
};
