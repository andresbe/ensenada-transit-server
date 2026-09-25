import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db";
import { AppError } from "../shared/errors";
import { JWTPayload, User } from "../types";

interface AdminRow {
  id: string;
  email: string;
  display_name: string | null;
  status: User["status"];
  token_version: number;
  created_at: Date;
  updated_at: Date;
}

const ADMIN_COLUMNS = "id, email, display_name, status, token_version, created_at, updated_at";
// Compare a real bcrypt hash even for an unknown account to avoid a fast failure path.
const DUMMY_HASH = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";

export function publicAdmin(admin: AdminRow): User {
  return {
    id: admin.id, email: admin.email, display_name: admin.display_name,
    role: "admin", status: admin.status, auth_provider: "email", photo_url: null,
    created_at: admin.created_at, updated_at: admin.updated_at,
  };
}

export function adminSession(admin: AdminRow): { user: User; token: string } {
  const payload: JWTPayload = {
    sub: admin.id, email: admin.email, role: "admin",
    identityType: "admin", tokenVersion: admin.token_version,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET ?? "change_me_in_production", {
    algorithm: "HS256",
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  } as jwt.SignOptions);
  return { user: publicAdmin(admin), token };
}

export async function loginAdmin(email: string, password: string): Promise<{ user: User; token: string }> {
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new AppError("password must not exceed 72 UTF-8 bytes.", 400);
  }
  const result = await query<AdminRow & { password_hash: string }>(
    `SELECT ${ADMIN_COLUMNS}, password_hash FROM admins WHERE email = $1 AND status = 'active'`,
    [email],
  );
  const admin = result.rows[0];
  const valid = await bcrypt.compare(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !valid) throw new AppError("Invalid email or password.", 401);
  return adminSession(admin);
}

export async function getActiveAdmin(payload: JWTPayload): Promise<AdminRow> {
  if (payload.identityType !== "admin" || payload.role !== "admin") {
    throw new AppError("Admin access required.", 403);
  }
  if (typeof payload.sub !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub) ||
      !Number.isInteger(payload.tokenVersion)) {
    throw new AppError("Invalid admin token.", 401);
  }
  const result = await query<AdminRow>(
    `SELECT ${ADMIN_COLUMNS} FROM admins WHERE id = $1 AND status = 'active' AND token_version = $2`,
    [payload.sub, payload.tokenVersion],
  );
  if (!result.rows[0]) throw new AppError("Admin session is no longer active.", 401);
  return result.rows[0];
}
