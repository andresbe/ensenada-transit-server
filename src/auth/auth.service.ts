import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db";
import { AppError } from "../shared/errors";
import { JWTPayload, User, UserRole, UserWithHash } from "../types";
import { RegisterInput } from "./validators";

const SALT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET ?? "change_me_in_production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";

// ── Token helpers ─────────────────────────────────────────────

export const generateToken = (user: User): string => {
  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
};

export const validateToken = (token: string): JWTPayload => {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    throw new AppError("Invalid or expired token.", 401);
  }
};

// ── Register ──────────────────────────────────────────────────

export const register = async (input: RegisterInput): Promise<{ user: User; token: string }> => {
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1",
    [input.email],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new AppError("An account with this email already exists.", 409);
  }

  const password_hash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const result = await query<User>(
    `INSERT INTO users (email, password_hash, display_name, auth_provider, role, status)
     VALUES ($1, $2, $3, 'email', 'user', 'active')
     RETURNING id, email, display_name, photo_url, auth_provider, role, status, created_at, updated_at`,
    [input.email, password_hash, input.display_name ?? null],
  );

  const user = result.rows[0];

  // Create default preferences
  await query(
    `INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [user.id],
  );

  return { user, token: generateToken(user) };
};

// ── Login ─────────────────────────────────────────────────────

export const login = async (
  email: string,
  password: string,
): Promise<{ user: User; token: string }> => {
  const result = await query<UserWithHash>(
    `SELECT id, email, password_hash, display_name, photo_url, auth_provider, role, status, created_at, updated_at
     FROM users WHERE email = $1 AND status = 'active'`,
    [email],
  );

  const userRow = result.rows[0];

  if (!userRow || !userRow.password_hash) {
    throw new AppError("Invalid email or password.", 401);
  }

  const valid = await bcrypt.compare(password, userRow.password_hash);
  if (!valid) {
    throw new AppError("Invalid email or password.", 401);
  }

  const { password_hash: _ph, ...user } = userRow;
  return { user: user as User, token: generateToken(user as User) };
};

// ── Social auth ───────────────────────────────────────────────

export interface SocialAuthInput {
  provider: "google" | "apple";
  provider_token: string;
  email?: string;
  display_name?: string;
  photo_url?: string;
}

export const socialAuth = async (
  input: SocialAuthInput,
): Promise<{ user: User; token: string }> => {
  // In a real implementation you would verify the provider_token with
  // Google / Apple APIs here. For now we upsert by email.
  if (!input.email) {
    throw new AppError("email is required for social auth.", 400);
  }

  const existing = await query<User>(
    `SELECT id, email, display_name, photo_url, auth_provider, role, status, created_at, updated_at
     FROM users WHERE email = $1`,
    [input.email],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    const user = existing.rows[0];
    return { user, token: generateToken(user) };
  }

  const result = await query<User>(
    `INSERT INTO users (email, display_name, photo_url, auth_provider, role, status)
     VALUES ($1, $2, $3, $4, 'user', 'active')
     RETURNING id, email, display_name, photo_url, auth_provider, role, status, created_at, updated_at`,
    [input.email, input.display_name ?? null, input.photo_url ?? null, input.provider],
  );

  const user = result.rows[0];
  await query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user.id]);

  return { user, token: generateToken(user) };
};

// ── Guest auth ────────────────────────────────────────────────

export const guestAuth = async (): Promise<{ user: User; token: string }> => {
  const result = await query<User>(
    `INSERT INTO users (auth_provider, role, status)
     VALUES ('guest', 'user', 'active')
     RETURNING id, email, display_name, photo_url, auth_provider, role, status, created_at, updated_at`,
  );

  const user = result.rows[0];
  return { user, token: generateToken(user) };
};

// ── Refresh token ─────────────────────────────────────────────

export const refreshToken = async (token: string): Promise<{ user: User; token: string }> => {
  const payload = validateToken(token);

  const result = await query<User>(
    `SELECT id, email, display_name, photo_url, auth_provider, role, status, created_at, updated_at
     FROM users WHERE id = $1 AND status = 'active'`,
    [payload.sub],
  );

  if (!result.rowCount || result.rowCount === 0) {
    throw new AppError("User not found or inactive.", 401);
  }

  const user = result.rows[0];
  return { user, token: generateToken(user) };
};
