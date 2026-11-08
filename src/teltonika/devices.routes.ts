import { Router } from "express";
import { authMiddleware } from "../auth/auth.middleware";
import { requireSuperadmin } from "../tenancy/access";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { asyncHandler } from "../middleware/errorHandler";
import { getClient, query } from "../db";
import { record, text, uuid, page } from "../passengers/validation";
import { AppError } from "../shared/errors";
import { validImei } from "../tracking/deviceIdentity";
import { isHardwareProvider } from "../tracking/hardwareStore";

export const trackingDevicesRouter = Router();
trackingDevicesRouter.use(authMiddleware, requireSuperadmin, apiRateLimiter);

const safeSelect = `SELECT d.id,d.provider,right(d.imei,4) AS imei_suffix,d.model,d.firmware_version,d.status,
  a.id AS assignment_id,a.vehicle_id,a.route_variant_id,d.public_visible,d.revision,d.last_seen_at,
  d.last_connected_at,d.last_received_at,d.last_valid_location_at,d.last_published_at,d.created_at,d.updated_at
  FROM tracking_devices d LEFT JOIN vehicle_device_assignments a ON a.device_id=d.id AND a.unassigned_at IS NULL`;

trackingDevicesRouter.get("/", asyncHandler(async (req, res) => {
  const { limit, offset } = page(req.query);
  const result = await query(`${safeSelect} ORDER BY d.created_at DESC,d.id LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json({ devices: result.rows });
}));

trackingDevicesRouter.get("/:deviceId/telemetry", asyncHandler(async (req, res) => {
  const { limit, offset } = page(req.query);
  const result = await query(`SELECT id,source,vehicle_id,assignment_id,event_key,latitude,longitude,speed_mps,heading,satellites,
    recorded_at,received_at,is_valid,telemetry,delivery_status,delivery_reason
    FROM vehicle_gps_locations WHERE device_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT $2 OFFSET $3`,
  [uuid(req.params.deviceId), limit, offset]);
  res.json({ telemetry: result.rows });
}));

trackingDevicesRouter.get("/:deviceId/rejections", asyncHandler(async (req, res) => {
  const { limit, offset } = page(req.query);
  const result = await query(`SELECT id,event_key,received_at,reason,telemetry FROM tracking_device_rejections
    WHERE device_id=$1 ORDER BY received_at DESC,id DESC LIMIT $2 OFFSET $3`, [uuid(req.params.deviceId), limit, offset]);
  res.json({ rejections: result.rows });
}));

trackingDevicesRouter.get("/:deviceId/packet-diagnostics", asyncHandler(async (req, res) => {
  const { limit, offset } = page(req.query);
  const result = await query(`SELECT id,provider,command,packet_hash,byte_length,reason,received_at,expires_at,
    raw_packet IS NOT NULL AS raw_packet_captured FROM tracking_device_packet_diagnostics
    WHERE device_id=$1 ORDER BY received_at DESC,id DESC LIMIT $2 OFFSET $3`,
  [uuid(req.params.deviceId), limit, offset]);
  res.json({ diagnostics: result.rows });
}));

trackingDevicesRouter.get("/:deviceId/assignments", asyncHandler(async (req, res) => {
  const { limit, offset } = page(req.query);
  const result = await query(`SELECT id,vehicle_id,route_variant_id,assigned_at,unassigned_at,assigned_by,notes
    FROM vehicle_device_assignments WHERE device_id=$1 ORDER BY assigned_at DESC,id DESC LIMIT $2 OFFSET $3`,
  [uuid(req.params.deviceId), limit, offset]);
  res.json({ assignments: result.rows });
}));

async function saveDevice(id: string | null, input: unknown, actorId: string) {
  const body = record(input);
  const allowed = new Set(["provider", "imei", "model", "firmware_version", "status", "vehicle_id", "route_variant_id", "public_visible", "revision", "test_vehicle"]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new AppError("Unknown device field.", 400);
  for (const key of ["public_visible", "test_vehicle"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") throw new AppError(`${key} must be boolean.`, 400);
  }
  if (body.provider !== undefined && !isHardwareProvider(body.provider)) throw new AppError("Invalid tracking provider.", 400);
  if (body.status !== undefined && !["active", "inactive", "retired"].includes(body.status as string)) throw new AppError("Invalid device status.", 400);
  if (id && (body.provider !== undefined || body.imei !== undefined || body.test_vehicle !== undefined)) throw new AppError("Provider, IMEI and test_vehicle are creation-only fields.", 400);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const previous = id ? (await client.query("SELECT * FROM tracking_devices WHERE id=$1 FOR UPDATE", [uuid(id)])).rows[0] : undefined;
    if (id && !previous) throw new AppError("Device not found.", 404);
    if (previous && body.revision !== previous.revision) throw new AppError("Device changed; reload its revision.", 409);
    if (previous && !isHardwareProvider(previous.provider)) throw new AppError("Unsupported tracking provider.", 400);
    const assignment = previous ? (await client.query(`SELECT * FROM vehicle_device_assignments
      WHERE device_id=$1 AND unassigned_at IS NULL`, [id])).rows[0] : null;
    const imei = previous?.imei ?? text(body.imei, "IMEI", 15);
    if (!validImei(imei)) throw new AppError("IMEI must contain 15 digits.", 400);
    const provider = previous?.provider ?? body.provider ?? "TELTONIKA";
    if (!isHardwareProvider(provider)) throw new AppError("Invalid tracking provider.", 400);
    let vehicleId = body.vehicle_id === undefined ? assignment?.vehicle_id ?? null : body.vehicle_id === null ? null : uuid(body.vehicle_id);
    const variantId = body.route_variant_id === undefined ? assignment?.route_variant_id ?? null : body.route_variant_id === null ? null : uuid(body.route_variant_id);
    const visible = body.public_visible ?? previous?.public_visible ?? false;
    const variant = variantId ? (await client.query(`SELECT rv.id,rv.route_id,rv.direction,r.transport_line_id,r.active
      FROM route_variants rv JOIN routes r ON r.id=rv.route_id WHERE rv.id=$1`, [variantId])).rows[0] : null;
    if (variantId && (!variant || !variant.active || !["ida", "vuelta"].includes(variant.direction))) throw new AppError("Route variant unavailable.", 400);
    if (body.test_vehicle) {
      if (provider !== "TELTONIKA") throw new AppError("Create the Ruptela test vehicle first, then assign it with vehicle_id.", 400);
      if (vehicleId || visible) throw new AppError("A test vehicle is created privately; omit vehicle_id and public_visible.", 400);
      // Never claim an existing vehicle automatically, even if it has the pilot's identifier.
      vehicleId = (await client.query(`INSERT INTO fleet_vehicles(tracking_id,economic_number,transport_line_id,assigned_route_id,is_test_vehicle)
        VALUES('TEST-FTC927-001','TEST-FTC927-001',$1,$2,true) RETURNING id`, [variant?.transport_line_id ?? null, variant?.route_id ?? null])).rows[0].id;
    }
    const vehicle = vehicleId ? (await client.query("SELECT * FROM fleet_vehicles WHERE id=$1 FOR UPDATE", [vehicleId])).rows[0] : null;
    if (vehicleId && (!vehicle || vehicle.archived_at)) throw new AppError("Vehicle unavailable.", 400);
    if (variant && (!vehicle || variant.transport_line_id !== vehicle.transport_line_id ||
      (vehicle.assigned_route_id && vehicle.assigned_route_id !== variant.route_id))) throw new AppError("Variant must match the vehicle's line and assigned route.", 400);
    if (visible && (!vehicle || !variant || vehicle.is_test_vehicle)) throw new AppError("Public tracking requires a non-test vehicle and a route variant.", 400);
    const values = [imei, provider, body.model === undefined ? previous?.model ?? (provider === "RUPTELA" ? "Eco5 Lite+" : "FTC927") : text(body.model, "Model", 60),
      body.firmware_version === undefined ? previous?.firmware_version ?? null : body.firmware_version === null ? null : text(body.firmware_version, "Firmware", 60),
      body.status ?? previous?.status ?? "active", visible];
    const saved = id ? await client.query(`UPDATE tracking_devices SET model=$3,firmware_version=$4,status=$5,
      public_visible=$6 WHERE id=$7 AND imei=$1 AND provider=$2 RETURNING id`, [...values, id]) :
      await client.query(`INSERT INTO tracking_devices(imei,provider,model,firmware_version,status,public_visible)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, values);
    const deviceId = saved.rows[0].id;
    if (vehicleId !== (assignment?.vehicle_id ?? null) || variantId !== (assignment?.route_variant_id ?? null)) {
      const boundary = (await client.query("SELECT GREATEST(clock_timestamp(),$1::timestamptz)::text AS at", [assignment?.assigned_at ?? null])).rows[0].at;
      if (assignment) await client.query("UPDATE vehicle_device_assignments SET unassigned_at=$2 WHERE id=$1", [assignment.id, boundary]);
      if (vehicleId) await client.query(`INSERT INTO vehicle_device_assignments(device_id,vehicle_id,route_variant_id,assigned_at,assigned_by)
        VALUES($1,$2,$3,$4,$5)`, [deviceId, vehicleId, variantId, boundary, actorId]);
    }
    await client.query(`INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id)
      VALUES($1,$2,$3,'tracking_devices',$4)`, [vehicle?.transport_line_id ?? null, actorId, id ? "UPDATE" : "CREATE", deviceId]);
    const result = (await client.query(`${safeSelect} WHERE d.id=$1`, [deviceId])).rows[0];
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") throw new AppError("IMEI, vehicle or pilot identifier already registered.", 409);
    throw error;
  } finally { client.release(); }
}

trackingDevicesRouter.post("/", asyncHandler(async (req, res) => {
  res.status(201).json({ device: await saveDevice(null, req.body, req.user!.sub) });
}));
trackingDevicesRouter.patch("/:deviceId", asyncHandler(async (req, res) => {
  res.json({ device: await saveDevice(uuid(req.params.deviceId), req.body, req.user!.sub) });
}));
