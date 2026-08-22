import { Request } from "express";
import { env } from "../config/env";
import { query } from "../db";
import { AppError } from "../shared/errors";
import { UserRole, UserStatus } from "../types";
import { LocationUpdateRequest } from "../modules/locations/locations.types";

type LocationAuthUser = {
  id: string;
  role: UserRole;
  status: UserStatus;
  assigned_bus_id: string | null;
  assigned_route_id: string | null;
  assigned_route_variant_id: string | null;
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

  const result = await query<LocationAuthUser>(
    `SELECT id, role, status, assigned_bus_id, assigned_route_id, assigned_route_variant_id
     FROM users
     WHERE id = $1 AND status = 'active'`,
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

  if (user.role === "driver" && user.assigned_bus_id && payload.busId !== user.assigned_bus_id) {
    throw new AppError("Driver is not assigned to this bus.", 403);
  }

  if (user.role === "driver" && user.assigned_route_id && payload.routeId !== user.assigned_route_id) {
    throw new AppError("Driver is not assigned to this route.", 403);
  }

  if (
    user.role === "driver" &&
    user.assigned_route_variant_id &&
    payload.routeVariantId !== user.assigned_route_variant_id
  ) {
    throw new AppError("Driver is not assigned to this route variant.", 403);
  }
};
