import { getClient } from "../db";
import { AppError } from "../shared/errors";

export const MAX_PASSENGER_DEVICES = 5;

export async function registerDevice(userId: string, token: string, platform: string) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    // Serialize same-token handoffs and same-account registrations across replicas.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["push-token:" + token]);
    const owner = await client.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR NO KEY UPDATE", [userId]);
    if (!owner.rows.length) throw new AppError("Cuenta no disponible.",403);
    const result = await client.query(`INSERT INTO passenger_devices(user_id,token,platform) VALUES($1,$2,$3)
      ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,platform=EXCLUDED.platform,active=TRUE,updated_at=NOW() RETURNING id`, [userId,token,platform]);
    // Keep the new device and the most recently refreshed devices; cascade removes obsolete jobs.
    await client.query(`DELETE FROM passenger_devices WHERE user_id=$1 AND id IN (
      SELECT id FROM passenger_devices WHERE user_id=$1
      ORDER BY (id=$2) DESC,updated_at DESC,id OFFSET $3)`, [userId,result.rows[0].id,MAX_PASSENGER_DEVICES]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
