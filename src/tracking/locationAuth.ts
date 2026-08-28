import { Request } from "express";
import { env } from "../config/env";
import { query } from "../db";
import { AppError } from "../shared/errors";
import { LocationUpdateRequest } from "../modules/locations/locations.types";

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

  if (payload.sourceType !== "driver") {
    return;
  }

  const result =
    req.user.role === "driver"
      ? await query<LocationAuthUser>(
          `SELECT correo AS id, 'driver' AS role
           FROM conductores
           WHERE correo = $1`,
          [req.user.sub],
        )
      : await query<LocationAuthUser>(
          `SELECT id, 'admin' AS role
           FROM users
           WHERE id = $1 AND status = 'active' AND role = 'admin'`,
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
