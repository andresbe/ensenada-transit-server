import { query, getClient } from "../db";
import { AppError } from "../shared/errors";
import { record, text, uuid, coordinate } from "./validation";
import { visibleRouteSql } from "./visibility";
export async function saveJourney(userId: string, input: unknown, routeOnly = false) {
  const b = record(input),
    routeId = uuid(b.route_id),
    variantId = b.variant_id == null ? null : uuid(b.variant_id);
  if (
    variantId &&
    !(
      await query("SELECT id FROM route_variants WHERE id=$1 AND route_id=$2", [
        variantId,
        routeId,
      ])
    ).rows.length
  )
    throw new AppError("Variant does not belong to route.", 400);
  const hasDestination = b.destination_latitude != null || b.destination_longitude != null;
  const clientId = text(b.client_id, "client_id", 1000);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const owner = await client.query("SELECT id,is_tester FROM users WHERE id=$1 AND status='active' FOR UPDATE", [userId]);
    if (!owner.rows.length) throw new AppError("Account unavailable.",401);
    if (!(await client.query(`SELECT id FROM routes r WHERE r.id=$1 AND ${visibleRouteSql("r")}`,[routeId])).rows.length) throw new AppError("Route not found.",404);
    const existing = routeOnly
      ? await client.query("SELECT * FROM saved_journeys WHERE user_id=$1 AND route_id=$2 ORDER BY created_at,id LIMIT 1", [userId, routeId])
      : await client.query("SELECT * FROM saved_journeys WHERE user_id=$1 AND client_id=$2", [userId, clientId]);
    if (existing.rows.length) {
      await client.query("COMMIT");
      return { favorite: existing.rows[0], created: false };
    }
    const count = await client.query("SELECT count(*)::int AS total FROM saved_journeys WHERE user_id=$1", [userId]);
    if (!owner.rows[0]?.is_tester && count.rows[0].total >= 3) throw new AppError("Puedes guardar hasta 3 rutas favoritas. Quita una antes de agregar otra.", 409, { code: "FAVORITES_LIMIT", limit: 3 });
    const result = await client.query(
      `INSERT INTO saved_journeys(user_id,route_id,variant_id,destination_title,destination_latitude,destination_longitude,client_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,client_id) DO UPDATE SET client_id=EXCLUDED.client_id RETURNING *`,
      [
        userId,
        routeId,
        variantId,
        b.destination_title == null ? null : text(b.destination_title, "destination_title"),
        hasDestination ? coordinate(b.destination_latitude, "latitude") : null,
        hasDestination ? coordinate(b.destination_longitude, "longitude") : null,
        clientId,
      ],
    );
    await client.query("COMMIT");
    return { favorite: result.rows[0], created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

}
