import { removeEndedSessionLocation } from "../redis/cache";
import { locationsService } from "../modules/locations/locations.service";
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
  const requestId = body.request_id ? text(body.request_id, "request_id", 100) : null;
  const fingerprint = JSON.stringify([busId, routeId, variantId]);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["driver-session:"+subject]);
    const identity = await driverIdentity(client,subject);
    if (requestId) {
      const existing = await client.query("SELECT * FROM driver_sessions WHERE start_request_id=$1 AND (conductor_id=$2 OR driver_id=$3)", [requestId, identity.conductorId, identity.userId]);
      if (existing.rows[0]) {
        if (existing.rows[0].start_request_fingerprint !== fingerprint) throw new AppError("El intento de inicio corresponde a otra selección.", 409);
        await client.query("COMMIT");
        return existing.rows[0];
      }
    }
    if (routeId && !variantId) throw new AppError("Selecciona el recorrido de ida o vuelta antes de iniciar.",400);
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
    {
      const active = await client.query("SELECT id FROM driver_sessions WHERE status='active' AND (driver_id=$1 OR conductor_id=$2)", [identity.userId, identity.conductorId]);
      if (active.rows.length) throw new AppError("Ya tienes un servicio activo. Recupéralo o finalízalo antes de iniciar otro.", 409);
    }
    const result = await client.query(`INSERT INTO driver_sessions(driver_id,conductor_id,vehicle_id,bus_id,route_id,variant_id,transport_line_id,status,start_request_id,start_request_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9) RETURNING *`,[identity.userId,identity.conductorId,vehicle?.id ?? null,busId,routeId,variantId,vehicle?.transport_line_id ?? null,requestId,requestId ? fingerprint : null]);
    if (routeId && variantId) await beginCheckpointRun(client,result.rows[0].id,routeId,variantId,result.rows[0].started_at);
    await client.query("COMMIT");
    return result.rows[0];
  } catch(error) {
    await client.query("ROLLBACK");
    if ((error as {code?:string}).code==="23505") throw new AppError("El camión o conductor ya tiene un recorrido activo.",409);
    throw error;
  } finally { client.release(); }
}

export async function endSession(subject:string,sessionId:string) {
  const client=await getClient();
  try {
    await client.query("BEGIN");
    const identity=await driverIdentity(client,subject);
    const result=await client.query("SELECT * FROM driver_sessions WHERE id=$1 AND (driver_id=$2 OR conductor_id=$3) FOR UPDATE",[uuid(sessionId),identity.userId,identity.conductorId]);
    if(!result.rows[0])throw new AppError("Servicio no encontrado.",404);
    let session=result.rows[0];
    if(session.status==='active') {
      session=(await client.query("UPDATE driver_sessions SET status='ended',ended_at=now() WHERE id=$1 RETURNING *",[session.id])).rows[0];
    }
    await client.query("UPDATE driver_checkpoint_runs SET ended_at=$2 WHERE session_id=$1 AND ended_at IS NULL",[session.id,session.ended_at]);
    await client.query("COMMIT");
    locationsService.removeEndedSession(session.bus_id,session.id);
    void removeEndedSessionLocation(session.bus_id,session.id);
    return session;
  } catch(error){await client.query("ROLLBACK");throw error;}
  finally {client.release();}
}

export async function currentSession(subject:string) {
  const client=await getClient();
  try {
    const identity=await driverIdentity(client,subject);
    const result=await client.query(
      "SELECT s.id,s.bus_id,s.route_id,COALESCE(cr.variant_id,s.variant_id) AS variant_id,s.started_at,s.status,COALESCE(cr.direction,v.direction) AS direction FROM driver_sessions s LEFT JOIN route_variants v ON v.id=s.variant_id LEFT JOIN driver_checkpoint_runs cr ON cr.session_id=s.id AND cr.ended_at IS NULL WHERE s.status='active' AND (s.conductor_id=$1 OR s.driver_id=$2) ORDER BY s.started_at DESC LIMIT 1",
      [identity.conductorId,identity.userId]);
    return result.rows[0] ?? null;
  } finally {client.release();}
}
