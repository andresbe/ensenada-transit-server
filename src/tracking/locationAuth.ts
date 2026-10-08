import { localSimulationAllowed } from "./localSimulation";
import { canonicalRouteId } from "../passengers/identity";
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
  const simulationToken = req.header("x-local-simulation-token");
  if (simulationToken !== undefined) {
    if (!localSimulationAllowed(process.env, req.socket.remoteAddress, simulationToken)
      || !/^SIM-[a-f0-9]{8}-[0-9]{3}$/.test(payload.busId)
      || payload.sourceId !== payload.busId || payload.sourceType !== "driver") {
      throw new AppError("Local simulation is not authorized.", 403);
    }
    const existing = await query("SELECT id FROM fleet_vehicles WHERE tracking_id=$1", [payload.busId]);
    const variant = await query(
      "SELECT v.id FROM route_variants v JOIN routes r ON r.id=v.route_id WHERE v.id::text=$1 AND r.id::text=$2 AND v.direction=$3 AND r.active AND r.visible_in_app",
      [payload.routeVariantId, payload.routeId, payload.routeVariantDirection],
    );
    if (existing.rows.length || !variant.rows.length) throw new AppError("Invalid simulation vehicle or route.", 403);
    return;
  }
  // Preserve unregistered legacy IDs, but registered driver telemetry must belong
  // to the assigned conductor. Passenger observations retain their own sourceType.
  if (payload.sourceType === "driver") {
    const registered = await query(
      `SELECT v.archived_at,v.operational_status,v.transport_line_id,v.assigned_route_id,v.assigned_driver_id,c.correo FROM fleet_vehicles v
       LEFT JOIN conductores c ON c.id=v.assigned_driver_id WHERE v.tracking_id=$1`,
      [payload.busId],
    );
    const vehicle = registered.rows[0];
    if (!vehicle && req.user?.role === "driver") {
      const enrolled = await query(
        "SELECT m.conductor_id FROM driver_line_memberships m JOIN conductores c ON c.id=m.conductor_id WHERE c.correo=$1 LIMIT 1",
        [req.user.sub],
      );
      if (enrolled.rows.length) throw new AppError("Selecciona un camión registrado y asignado a tu cuenta.",403);
    }
    const routeId=await canonicalRouteId(payload.routeId);
    const route=(await query("SELECT transport_line_id FROM routes WHERE id::text=$1 AND active",[routeId])).rows[0];
    if (route?.transport_line_id && route.transport_line_id!==vehicle?.transport_line_id) throw new AppError("La ruta no corresponde a la línea del camión.",403);
    if (vehicle?.transport_line_id) {
      const member=await query("SELECT m.conductor_id FROM driver_line_memberships m JOIN transport_lines l ON l.id=m.line_id WHERE m.conductor_id=$1 AND m.line_id=$2 AND m.active AND l.active",[vehicle.assigned_driver_id,vehicle.transport_line_id]);
      if (!member.rows.length || !route || route.transport_line_id!==vehicle.transport_line_id || (vehicle.assigned_route_id && vehicle.assigned_route_id!==routeId)) throw new AppError("Asignación de línea o ruta inválida.",403);
    }
    if (vehicle && (vehicle.archived_at || vehicle.operational_status !== "available" ||
      !req.user || req.user.role !== "driver" || vehicle.correo !== req.user.sub || payload.sourceId !== req.user.sub)) {
      throw new AppError("El camión no está disponible o no está asignado a este conductor.",403);
    }
  }
  if (!req.user) {
    if (env.locationUpdateAuthMode === "required") {
      throw new AppError("Authentication token is required for location updates.", 401);
    }

    return;
  }

  if (req.user.identityType === "admin") {
    if (!(await getActiveAdmin(req.user)).is_superadmin) throw new AppError("Solo un conductor autorizado puede transmitir esta ubicación.",403);
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
