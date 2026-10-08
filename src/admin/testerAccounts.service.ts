import { getClient } from "../db";
import { AppError } from "../shared/errors";

export async function setTesterAccount(adminId: string, userId: string, enabled: unknown) {
  if (typeof enabled !== "boolean") throw new AppError("is_tester debe ser booleano.", 400);
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(userId)) throw new AppError("Cuenta inválida.", 400);
  const db = await getClient();
  try {
    await db.query("BEGIN");
    const admin = await db.query("SELECT id FROM admins WHERE id=$1 AND status='active' AND is_superadmin FOR SHARE", [adminId]);
    if (!admin.rows.length) throw new AppError("Solo un superadministrador puede cambiar el modo tester.", 403);
    const result = await db.query("UPDATE users SET is_tester=$2 WHERE id=$1 AND status='active' RETURNING id,email,is_tester", [userId, enabled]);
    if (!result.rows.length) throw new AppError("No existe una cuenta activa.", 404);
    if (!enabled) await db.query("UPDATE passenger_boardings SET status='ended',ended_at=now(),expires_at=now() WHERE user_id=$1 AND is_test AND status IN ('pending','verified')", [userId]);
    await db.query("INSERT INTO tester_account_changes(user_id,admin_id,enabled) VALUES($1,$2,$3)", [userId, adminId, enabled]);
    await db.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}
