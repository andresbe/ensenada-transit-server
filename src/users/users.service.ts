import { query } from "../db";
import { AppError } from "../shared/errors";
import { User, UserPreferences } from "../types";

export const USER_COLUMNS =
  "id, email, display_name, photo_url, auth_provider, role, status, created_at, updated_at";

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
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.display_name !== undefined) {
    fields.push(`display_name = $${idx++}`);
    values.push(input.display_name);
  }
  if (input.photo_url !== undefined) {
    fields.push(`photo_url = $${idx++}`);
    values.push(input.photo_url);
  }

  if (fields.length === 0) {
    return getUserById(id);
  }

  values.push(id);
  const result = await query<User>(
    `UPDATE users SET ${fields.join(", ")}
     WHERE id = $${idx} AND status != 'deleted'
     RETURNING ${USER_COLUMNS}`,
    values,
  );

  if (!result.rowCount || result.rowCount === 0) {
    throw new AppError("User not found.", 404);
  }
  return result.rows[0];
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
