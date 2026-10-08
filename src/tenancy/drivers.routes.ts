import { Router } from "express";
import bcrypt from "bcrypt";
import { getActiveAdmin } from "../auth/admin.service";
import { validatePassword } from "../auth/validators";
import { getClient } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { record, text, uuid } from "../passengers/validation";
import { lineAccess } from "./access";

// These operations update a global login and a line membership atomically.
// They run before the scoped database role and require explicit line ownership.
export const driverManagementRouter = Router({ mergeParams: true });
driverManagementRouter.put("/drivers/:id", apiRateLimiter, asyncHandler(async (req, res) => {
  const actor = await getActiveAdmin(req.user!);
  const line = uuid(req.params.lineId), id = uuid(req.params.id), body = record(req.body);
  await lineAccess(actor.id, line, true, true);
  if (!Number.isInteger(body.revision) || typeof body.active !== "boolean") throw new AppError("Datos de conductor inválidos.", 400);
  const name = text(body.name, "Nombre", 100);
  let hash: string | undefined;
  if (body.password !== undefined) {
    const password = validatePassword(body.password);
    if (Buffer.byteLength(password, "utf8") > 72) throw new AppError("La contraseña excede 72 bytes.", 400);
    hash = await bcrypt.hash(password, 12);
  }
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM transport_lines WHERE id=$1 FOR UPDATE", [line]);
    const permission = await client.query(
      "SELECT a.id FROM admins a JOIN transport_lines l ON l.id=$2 LEFT JOIN admin_line_memberships m ON m.admin_id=a.id AND m.line_id=l.id WHERE a.id=$1 AND a.status='active' AND a.token_version=$3 AND l.active AND (a.is_superadmin OR (m.active AND m.role='admin'))",
      [actor.id, line, req.user!.tokenVersion],
    );
    if (!permission.rows.length) throw new AppError("Permiso revocado.", 403);
    const driver = (await client.query("SELECT c.id,c.nombre_usuario,c.revision,m.active FROM conductores c JOIN driver_line_memberships m ON m.conductor_id=c.id WHERE c.id=$1 AND m.line_id=$2 FOR UPDATE OF c,m", [id, line])).rows[0];
    if (!driver) throw new AppError("Conductor no encontrado.", 404);
    if (driver.revision !== body.revision) throw new AppError("El conductor cambió. Actualiza la lista.", 409);
    if (hash || name !== driver.nombre_usuario) {
      const shared = await client.query("SELECT line_id FROM driver_line_memberships WHERE conductor_id=$1 AND line_id<>$2", [id, line]);
      if (shared.rows.length && !actor.is_superadmin) throw new AppError("Este conductor pertenece a varias líneas. Solicita el cambio de datos o contraseña al superadministrador.", 403);
    }
    if (!body.active || hash) {
      const trips = await client.query("SELECT id FROM driver_sessions WHERE conductor_id=$1 AND status='active' AND ($3::boolean OR transport_line_id=$2)", [id, line, Boolean(hash)]);
      if (trips.rows.length) throw new AppError("Finaliza el recorrido antes de suspender el acceso o cambiar la contraseña.", 409);
    }
    await client.query("UPDATE conductores SET nombre_usuario=$2,password=COALESCE($3,password),token_version=token_version+CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END,revision=revision+1 WHERE id=$1", [id, name, hash ?? null]);
    await client.query("UPDATE driver_line_memberships SET active=$3 WHERE conductor_id=$1 AND line_id=$2", [id, line, body.active]);
    await client.query("INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,'driver',$4)", [line, actor.id, hash ? "CREDENTIAL_RESET" : body.active ? "UPDATE" : "SUSPEND", id]);
    await client.query("COMMIT");
    res.json({ saved: true });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));
