import { beginCheckpointRun } from "./checkpoints.service";
import { getClient, query } from "../db";
import { AppError } from "../shared/errors";
import { record, text, uuid } from "../passengers/validation";

export async function driverIdentity(client: {query: typeof query}, subject: string) {
  const conductor = await client.query("SELECT id FROM conductores WHERE correo=$1", [subject]);
  if (conductor.rows[0]) return { conductorId: conductor.rows[0].id as string, userId: null };
  if (/^[0-9a-f-]{36}$/i.test(subject)) {
    const user = await client.query("SELECT id FROM users WHERE id=$1 AND role='driver' AND status='active'", [subject]);
    if (user.rows[0]) return {conductorId:null,userId:subject};
  }
  throw new AppError("Conductor no encontrado.",403);
}

export async function startSession(subject: string, input: unknown) {
  const body = record(input), busId = text(body.bus_id,"bus_id",100);
  const routeId = body.route_id ? uuid(body.route_id,"route_id") : null;
  const variantId = body.variant_id ? uuid(body.variant_id,"variant_id") : null;
  if (variantId && !routeId) throw new AppError("route_id es obligatorio con variant_id.",400);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["driver-session:"+subject]);
    const identity = await driverIdentity(client,subject);
    if (identity.conductorId) await client.query("SELECT id FROM conductores WHERE id=$1 FOR NO KEY UPDATE", [identity.conductorId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["fleet-bus:"+busId]);
    const found = await client.query("SELECT * FROM fleet_vehicles WHERE tracking_id=$1 FOR UPDATE",[busId]);
    const vehicle = found.rows[0];
    if (!vehicle && identity.conductorId) {
      const memberships=await client.query("SELECT conductor_id FROM driver_line_memberships WHERE conductor_id=$1 LIMIT 1",[identity.conductorId]);
      if (memberships.rows.length) throw new AppError("Selecciona un camión registrado y asignado a tu cuenta.",403);
    }
    if (vehicle && (vehicle.archived_at || vehicle.operational_status!=="available" || !identity.conductorId || vehicle.assigned_driver_id!==identity.conductorId)) {
      throw new AppError("Este camión no está disponible o no está asignado a tu cuenta.",403);
    }
    if (vehicle?.transport_line_id) {
      const membership=await client.query("SELECT m.conductor_id FROM driver_line_memberships m JOIN transport_lines l ON l.id=m.line_id WHERE m.conductor_id=$1 AND m.line_id=$2 AND m.active AND l.active",[identity.conductorId,vehicle.transport_line_id]);
      if (!membership.rows.length) throw new AppError("Conductor o línea no disponibles.",403);
      if (vehicle.assigned_route_id && vehicle.assigned_route_id!==routeId) throw new AppError("Utiliza la ruta asignada al camión.",403);
    }
    if (routeId) {
      const route = await client.query("SELECT id,transport_line_id FROM routes WHERE id=$1 AND active=true FOR SHARE",[routeId]);
      if (!route.rows.length) throw new AppError("Ruta no disponible.",400);
      if (route.rows[0].transport_line_id !== (vehicle?.transport_line_id ?? null)) throw new AppError("La ruta y el camión deben pertenecer a la misma línea.",403);
    }
    // Legacy sessions keep bus_id; new registered vehicles additionally acquire a foreign key.
    const occupied = await client.query("SELECT id FROM driver_sessions WHERE bus_id=$1 AND status='active' AND NOT (driver_id IS NOT DISTINCT FROM $2::uuid AND conductor_id IS NOT DISTINCT FROM $3::uuid)",[busId,identity.userId,identity.conductorId]);
    if (occupied.rows.length) throw new AppError("El camión ya tiene un recorrido activo.",409);
    await client.query("UPDATE driver_sessions SET status='ended',ended_at=now() WHERE status='active' AND (driver_id=$1 OR conductor_id=$2)",[identity.userId,identity.conductorId]);
    const result = await client.query(`INSERT INTO driver_sessions(driver_id,conductor_id,vehicle_id,bus_id,route_id,variant_id,transport_line_id,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,[identity.userId,identity.conductorId,vehicle?.id ?? null,busId,routeId,variantId,vehicle?.transport_line_id ?? null]);
    if (routeId && variantId) await beginCheckpointRun(client,result.rows[0].id,routeId,variantId,result.rows[0].started_at);
    await client.query("COMMIT");
    return result.rows[0];
  } catch(error) {
    await client.query("ROLLBACK");
    if ((error as {code?:string}).code==="23505") throw new AppError("El camión o conductor ya tiene un recorrido activo.",409);
    throw error;
  } finally { client.release(); }
}
