import { saveProfile, validateProfile } from "./profile.service";
import { getClient, query } from "../db";
import { AppError } from "../shared/errors";
import { User, UserPreferences } from "../types";

import { USER_COLUMNS } from "./columns";
export { USER_COLUMNS } from "./columns";

export const getPreferences = async (userId: string): Promise<UserPreferences | null> => {
  const result = await query<UserPreferences>(
    "SELECT * FROM user_preferences WHERE user_id = $1",
    [userId],
  );
  return result.rows[0] ?? null;
};

// ── Get user by id ────────────────────────────────────────────

export const getUserById = async (id: string): Promise<User> => {
  const result = await query<User>(
    `SELECT ${USER_COLUMNS}
     FROM users WHERE id = $1 AND status != 'deleted'`,
    [id],
  );
  if (!result.rowCount || result.rowCount === 0) {
    throw new AppError("User not found.", 404);
  }
  return result.rows[0];
};

// ── Update user profile ───────────────────────────────────────

export interface UpdateUserInput {
  display_name?: string;
  photo_url?: string;
}

export const updateUser = async (id: string, input: UpdateUserInput): Promise<User> => {
  if (input.photo_url !== undefined) throw new AppError("Use the avatar upload endpoint to change your photo.", 400);
  if (input.display_name === undefined) return getUserById(id);
  return saveProfile(id, { display_name: input.display_name });
};

// ── Update preferences ────────────────────────────────────────

export interface UpdatePreferencesInput {
  language?: string;
  push_notifications_enabled?: boolean;
  favorite_route_alerts?: boolean;
}

export const updatePreferences = async (
  userId: string,
  input: UpdatePreferencesInput,
): Promise<UserPreferences> => {
  // Upsert preferences row
  await query(
    `INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId],
  );

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.language !== undefined) {
    fields.push(`language = $${idx++}`);
    values.push(input.language);
  }
  if (input.push_notifications_enabled !== undefined) {
    fields.push(`push_notifications_enabled = $${idx++}`);
    values.push(input.push_notifications_enabled);
  }
  if (input.favorite_route_alerts !== undefined) {
    fields.push(`favorite_route_alerts = $${idx++}`);
    values.push(input.favorite_route_alerts);
  }

  if (fields.length === 0) {
    const result = await query<UserPreferences>(
      `SELECT * FROM user_preferences WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0];
  }

  values.push(userId);
  const result = await query<UserPreferences>(
    `UPDATE user_preferences SET ${fields.join(", ")}
     WHERE user_id = $${idx}
     RETURNING *`,
    values,
  );
  return result.rows[0];
};

// Validate the whole legacy profile request before any write, then commit together.
export async function updateAccount(userId: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Invalid profile.",400);
  const input = body as Record<string, unknown>;
  if (input.photo_url !== undefined) throw new AppError("Use the avatar upload endpoint to change your photo.",400);
  const name = input.display_name === undefined ? undefined : (await validateProfile({display_name:input.display_name})).name;
  let prefs: UpdatePreferencesInput | undefined;
  if (input.preferences !== undefined) {
    if (!input.preferences || typeof input.preferences !== "object" || Array.isArray(input.preferences)) throw new AppError("Invalid preferences.",400);
    const p = input.preferences as Record<string,unknown>;
    if (p.language !== undefined && p.language !== "es" && p.language !== "en") throw new AppError("Invalid language.",400);
    for (const key of ["push_notifications_enabled","favorite_route_alerts"]) {
      if (p[key] !== undefined && typeof p[key] !== "boolean") throw new AppError("Invalid preference.",400);
    }
    prefs = p as UpdatePreferencesInput;
  }
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const account = await client.query<User & {auth_provider:string}>(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1 AND status='active' FOR UPDATE`,[userId]);
    let user = account.rows[0];
    if (!user) throw new AppError("User not found.",401);
    if (name !== undefined) {
      if (user.role !== "user" || user.auth_provider === "guest") throw new AppError("A passenger account is required.",403);
      user = (await client.query<User>(`UPDATE users SET display_name=$2,updated_at=NOW() WHERE id=$1 RETURNING ${USER_COLUMNS}`,[userId,name])).rows[0];
    }
    let preferences;
    if (prefs) {
      await client.query("INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING",[userId]);
      preferences = (await client.query<UserPreferences>("UPDATE user_preferences SET language=COALESCE($2,language),push_notifications_enabled=COALESCE($3,push_notifications_enabled),favorite_route_alerts=COALESCE($4,favorite_route_alerts) WHERE user_id=$1 RETURNING *",[userId,prefs.language ?? null,prefs.push_notifications_enabled ?? null,prefs.favorite_route_alerts ?? null])).rows[0];
    }
    await client.query("COMMIT");
    return {user,preferences};
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
