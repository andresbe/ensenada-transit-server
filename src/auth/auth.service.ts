import { jwtSecret } from "./tokenConfig";
import { googleUser } from "./google.service";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db";
import { sendWelcomeEmail } from "../email/email.service";
import { AppError } from "../shared/errors";
import { JWTPayload, User, UserWithHash } from "../types";
import { RegisterInput } from "./validators";
import { adminSession, getActiveAdmin } from "./admin.service";

const SALT_ROUNDS = 12;
const JWT_SECRET = jwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";
const USER_COLUMNS =
  "id, email, display_name, photo_url, auth_provider, role, status, is_tester, created_at, updated_at";

// ── Token helpers ─────────────────────────────────────────────

export const generateToken = (user: User): string => {
  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
};

type ConductorRow = {
  token_version: number;
  correo: string;
  password: string;
  nombre_usuario: string;
};

const isBcryptHash = (value: string): boolean => /^\$2[aby]\$\d{2}\$/.test(value);

export const generateDriverToken = (email: string, tokenVersion = 0): string => {
  const payload: JWTPayload = {
    sub: email,
    tokenVersion,
    email,
    role: "driver",
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);
};

export const loginConductor = async (
  email: string,
  password: string,
): Promise<{ user: User; token: string }> => {
  const result = await query<ConductorRow>(
    `SELECT correo, password, nombre_usuario, token_version
     FROM conductores
     WHERE correo = $1`,
    [email],
  );

  const conductor = result.rows[0];

  if (!conductor) {
    throw new AppError("Invalid email or password.", 401);
  }

  const valid = isBcryptHash(conductor.password)
    ? await bcrypt.compare(password, conductor.password)
    : false;

  if (!valid) {
    throw new AppError("Invalid email or password.", 401);
  }

  const user: User = {
    id: conductor.correo,
    email: conductor.correo,
    display_name: conductor.nombre_usuario,
    photo_url: null,
    auth_provider: "email",
    role: "driver",
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
  };

  return { user, token: generateDriverToken(conductor.correo, conductor.token_version) };
};

export const validateToken = (token: string): JWTPayload => {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof payload === "string" || typeof payload.sub !== "string" || !payload.sub ||
        !["user", "driver", "admin"].includes(payload.role)) {
      throw new Error("Invalid token claims.");
    }
    return payload as JWTPayload;
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
     RETURNING ${USER_COLUMNS}`,
    [input.email, password_hash, input.display_name ?? null],
  );

  const user = result.rows[0];

  // Create default preferences
  await query(
    `INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [user.id],
  );

  const token = generateToken(user);

  // Fire-and-forget welcome email. SMTP must never block registration.
  if (user.email) {
    sendWelcomeEmail(user.email, user.display_name ?? "usuario")
      .then((sent) => {
        if (sent) {
          console.log(`[email] Welcome email sent to ${user.email}`);
        }
      })
      .catch((error) => console.error("[email] Failed to send welcome email", error));
  }

  return { user, token };
};

// ── Login ─────────────────────────────────────────────────────

export const login = async (
  email: string,
  password: string,
): Promise<{ user: User; token: string }> => {
  const result = await query<UserWithHash>(
    `SELECT ${USER_COLUMNS}, password_hash
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
  password?: string;
  provider: "google" | "apple";
  provider_token: string;
  email?: string;
  display_name?: string;
  photo_url?: string;
}

export const socialAuth = async (
  input: SocialAuthInput,
): Promise<{ user: User; token: string }> => {
  if (input.provider !== "google") throw new AppError("This provider is not available.", 503);
  const user = await googleUser(input.provider_token, input.password);
  return { user, token: generateToken(user) };
};

// ── Guest auth ────────────────────────────────────────────────

export const guestAuth = async (): Promise<{ user: User; token: string }> => {
  const result = await query<User>(
    `INSERT INTO users (auth_provider, role, status)
     VALUES ('guest', 'user', 'active')
     RETURNING ${USER_COLUMNS}`,
  );

  const user = result.rows[0];
  return { user, token: generateToken(user) };
};

// ── Refresh token ─────────────────────────────────────────────

export const refreshToken = async (token: string): Promise<{ user: User; token: string }> => {
  const payload = validateToken(token);
  if (payload.identityType === "admin") {
    return adminSession(await getActiveAdmin(payload));
  }

  if (payload.role === "driver" && payload.sub.includes("@")) {
    const result = await query<ConductorRow>(
      "SELECT correo,nombre_usuario,token_version FROM conductores WHERE correo=$1", [payload.sub],
    );
    const conductor = result.rows[0];
    if (!conductor || (conductor.token_version ?? 0) !== (payload.tokenVersion ?? 0)) throw new AppError("Driver session expired.", 401);
    return {
      user: {
        id: conductor.correo, email: conductor.correo, display_name: conductor.nombre_usuario,
        photo_url: null, auth_provider: "email", role: "driver", status: "active",
        created_at: new Date(), updated_at: new Date(),
      },
      token: generateDriverToken(conductor.correo, conductor.token_version),
    };
  }

  const result = await query<User>(
    `SELECT ${USER_COLUMNS}
     FROM users WHERE id = $1 AND status = 'active'`,
    [payload.sub],
  );

  if (!result.rowCount || result.rowCount === 0) {
    throw new AppError("User not found or inactive.", 401);
  }

  const user = result.rows[0];
  return { user, token: generateToken(user) };
};
