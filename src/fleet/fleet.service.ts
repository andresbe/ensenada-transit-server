import { currentLine } from "../tenancy/context";
import { randomUUID } from "crypto";
import { getClient, query } from "../db";
import { AppError } from "../shared/errors";
import { record, text, uuid, choice } from "../passengers/validation";

export const vehicleColumns = `v.*, l.name AS line_name, c.nombre_usuario AS driver_name, c.correo AS driver_email`;
export const vehicleJoins = `FROM fleet_vehicles v LEFT JOIN transport_lines l ON l.id=v.transport_line_id
  LEFT JOIN conductores c ON c.id=v.assigned_driver_id`;

export async function getVehicle(id: string) {
  const result = await query(`SELECT ${vehicleColumns} ${vehicleJoins} WHERE v.id=$1`, [uuid(id)]);
  if (!result.rows[0]) throw new AppError("Camión no encontrado.", 404);
  return result.rows[0];
}

export async function saveVehicle(id: string | null, input: unknown, adminId: string) {
  const body = record(input);
  const economic = text(body.economic_number, "Número económico", 40);
  const context = currentLine();
  const line = context?.lineId ?? (body.transport_line_id ? uuid(body.transport_line_id, "Línea") : null);
  if (context && body.transport_line_id && body.transport_line_id !== line) throw new AppError("La línea no coincide con el espacio activo.",403);
  const assignedRoute = body.assigned_route_id ? uuid(body.assigned_route_id,"Ruta asignada") : null;
  const plate = body.plate ? text(body.plate, "Placas", 20).toUpperCase() : null;
  if (plate && !/^[A-Z0-9 -]+$/.test(plate)) throw new AppError("Placas inválidas.", 400);
  const capacity = body.capacity ?? null;
  if (capacity !== null && (!Number.isInteger(capacity) || Number(capacity) < 1 || Number(capacity) > 200)) {
    throw new AppError("La capacidad debe estar entre 1 y 200.", 400);
  }
  const status = choice(body.operational_status, ["available", "maintenance", "out_of_service"] as const, "Estado");
  const driver = body.assigned_driver_id ? uuid(body.assigned_driver_id, "Conductor") : null;
  const tracking = body.tracking_id ? text(body.tracking_id, "Identificador de seguimiento", 100) : randomUUID();
  const client = await getClient();
  try {
    await client.query("BEGIN");
    if (!id) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["fleet-bus:"+tracking]);
      const active = await client.query("SELECT id FROM driver_sessions WHERE bus_id=$1 AND status='active'", [tracking]);
      if (active.rows.length) throw new AppError("Finaliza el recorrido antes de registrar este identificador de seguimiento.", 409);
    }
    let previous;
    if (id) {
      const result = await client.query("SELECT * FROM fleet_vehicles WHERE id=$1 FOR UPDATE", [uuid(id)]);
      previous = result.rows[0];
      if (!previous || previous.archived_at) throw new AppError("Camión no encontrado o dado de baja.", 404);
      if (body.revision !== previous.revision) throw new AppError("El camión cambió. Actualiza la lista antes de editar.", 409);
      if (body.tracking_id !== undefined && body.tracking_id !== previous.tracking_id) throw new AppError("El identificador de seguimiento no puede cambiar.", 400);
      if (previous.assigned_driver_id !== driver || previous.assigned_route_id !== assignedRoute || status !== "available") {
        const active = await client.query("SELECT id FROM driver_sessions WHERE status='active' AND bus_id=$1", [previous.tracking_id]);
        if (active.rows.length) throw new AppError("Finaliza el recorrido activo antes de cambiar conductor o disponibilidad.", 409);
      }
    }
    if (line) {
      const active = await client.query("SELECT id FROM transport_lines WHERE id=$1 AND active=true", [line]);
      if (!active.rows.length && line !== previous?.transport_line_id) throw new AppError("La línea no está disponible.", 400);
    }
    if (line && driver) {
      const membership = await client.query("SELECT conductor_id FROM driver_line_memberships WHERE conductor_id=$1 AND line_id=$2 AND active",[driver,line]);
      if (!membership.rows.length) throw new AppError("El conductor no pertenece a esta línea.",400);
    }
    if (assignedRoute) {
      const route=await client.query("SELECT id FROM routes WHERE id=$1 AND transport_line_id=$2 AND active",[assignedRoute,line]);
      if (!route.rows.length) throw new AppError("La ruta no pertenece a esta línea.",400);
    }
    const result = id ? await client.query(`UPDATE fleet_vehicles SET economic_number=$2, transport_line_id=$3, plate=$4,capacity=$5,
      operational_status=$6,assigned_driver_id=$7,assigned_route_id=$8,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
    [id,economic,line,plate,capacity,status,driver,assignedRoute]) :
      await client.query(`INSERT INTO fleet_vehicles(economic_number,transport_line_id,plate,capacity,operational_status,assigned_driver_id,tracking_id,assigned_route_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [economic,line,plate,capacity,status,driver,tracking,assignedRoute]);
    const vehicle = result.rows[0];
    if (!previous || previous.assigned_driver_id !== driver || previous.assigned_route_id !== assignedRoute || previous.operational_status !== status) {
      await client.query("INSERT INTO fleet_assignment_history(vehicle_id,conductor_id,admin_id,route_id,action,operational_status) VALUES($1,$2,$3,$4,$5,$6)", [vehicle.id,driver,adminId,assignedRoute,previous ? "assignment" : "create",status]);
    }
    await client.query("COMMIT");
    return vehicle;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as {code?: string}).code === "23505") throw new AppError("Ya existe ese número económico, placas, identificador de seguimiento o conductor asignado.", 409);
    throw error;
  } finally { client.release(); }
}

export async function archiveVehicle(id: string, revision: unknown, adminId: string) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM fleet_vehicles WHERE id=$1 FOR UPDATE", [uuid(id)]);
    const vehicle = result.rows[0];
    if (!vehicle || vehicle.archived_at) throw new AppError("Camión no encontrado.", 404);
    if (revision !== vehicle.revision) throw new AppError("El camión cambió. Actualiza la lista.", 409);
    const active = await client.query("SELECT id FROM driver_sessions WHERE bus_id=$1 AND status='active'", [vehicle.tracking_id]);
    if (active.rows.length) throw new AppError("Finaliza el recorrido antes de dar de baja el camión.", 409);
    await client.query("UPDATE fleet_vehicles SET archived_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1", [id]);
    await client.query("INSERT INTO fleet_assignment_history(vehicle_id,conductor_id,admin_id,route_id,action,operational_status) VALUES($1,$2,$3,$4,'archive',$5)", [id,vehicle.assigned_driver_id,adminId,vehicle.assigned_route_id,vehicle.operational_status]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
