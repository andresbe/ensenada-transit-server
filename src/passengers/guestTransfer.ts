import { getClient } from "../db";
import { validateToken } from "../auth/auth.service";
import { AppError } from "../shared/errors";
import { uuid } from "./validation";

export async function transferGuestData(accountId: string, guestToken: string) {
  const payload = validateToken(guestToken);
  if (payload.identityType === "admin") throw new AppError("A guest session is required.", 403);
  const guestId = uuid(payload.sub);
  if (guestId === accountId) throw new AppError("A different registered account is required.", 400);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const identities = await client.query(
      "SELECT id,auth_provider,status,is_tester FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE",
      [guestId, accountId],
    );
    const guest = identities.rows.find((u) => u.id === guestId),
      account = identities.rows.find((u) => u.id === accountId);
    if (
      !guest ||
      guest.auth_provider !== "guest" ||
      !account ||
      account.auth_provider === "guest" ||
      account.status !== "active"
    )
      throw new AppError("Invalid account transfer.", 403);
    const prior = await client.query(
      "SELECT account_id FROM guest_account_transfers WHERE guest_id=$1",
      [guestId],
    );
    if (prior.rows.length) {
      if (prior.rows[0].account_id !== accountId)
        throw new AppError("Guest already transferred.", 409);
      await client.query("COMMIT");
      return;
    }
    if (guest.status !== "active") throw new AppError("Inactive guest.", 403);
    const favorites = await client.query("SELECT count(*)::int AS total FROM saved_journeys WHERE user_id IN ($1,$2)", [guestId, accountId]);
    if (!account.is_tester && favorites.rows[0].total > 3) throw new AppError("La cuenta y el invitado superan las 3 rutas favoritas. Quita favoritos antes de transferirlos.", 409, { code: "FAVORITES_LIMIT", limit: 3 });
    // Preserve both sets of data; deterministic namespaces prevent target conflicts.
    for (const table of [
      "saved_journeys",
      "saved_places",
      "user_reports",
      "support_tickets",
      "passenger_trips",
    ]) {
      await client.query(
        `UPDATE ${table} SET user_id=$1,client_id=CASE WHEN client_id IS NULL THEN NULL ELSE $3||client_id END WHERE user_id=$2`,
        [accountId, guestId, `guest:${guestId}:`],
      );
    }
    for (const [table, column] of [
      ["favorite_routes", "route_id"],
      ["favorite_stops", "stop_id"],
      ["notification_subscriptions", "route_id"],
    ]) {
      await client.query(
        `INSERT INTO ${table}(user_id,${column}) SELECT $1,${column} FROM ${table} WHERE user_id=$2 ON CONFLICT DO NOTHING`,
        [accountId, guestId],
      );
      await client.query(`DELETE FROM ${table} WHERE user_id=$1`, [guestId]);
    }
    await client.query("DELETE FROM passenger_devices WHERE user_id=$1", [guestId]);
    await client.query("INSERT INTO guest_account_transfers(guest_id,account_id) VALUES($1,$2)", [
      guestId,
      accountId,
    ]);
    await client.query("UPDATE users SET status='deleted' WHERE id=$1", [guestId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
