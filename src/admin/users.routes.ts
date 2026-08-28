import bcrypt from "bcrypt";
import { Request, Response, Router } from "express";
import { authMiddleware, adminMiddleware } from "../auth/auth.middleware";
import { validateEmail, validatePassword } from "../auth/validators";
import { query } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { sendSuccess } from "../shared/response";
import { User, UserRole, UserStatus } from "../types";
import { USER_COLUMNS } from "../users/users.service";

const SALT_ROUNDS = 12;
const roles = new Set<UserRole>(["user", "driver", "admin"]);
const statuses = new Set<UserStatus>(["active", "suspended", "deleted"]);

export const adminUsersRouter = Router();

adminUsersRouter.use(authMiddleware, adminMiddleware);

const optionalString = (value: unknown): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError("Expected a string value.", 400);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const validateRole = (value: unknown, fallback?: UserRole): UserRole => {
  if (value === undefined && fallback) {
    return fallback;
  }

  if (typeof value !== "string" || !roles.has(value as UserRole)) {
    throw new AppError("role must be one of: user, driver, admin.", 400);
  }

  return value as UserRole;
};

const validateStatus = (value: unknown): UserStatus | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !statuses.has(value as UserStatus)) {
    throw new AppError("status must be one of: active, suspended, deleted.", 400);
  }

  return value as UserStatus;
};

// GET /admin/users
adminUsersRouter.get(
  "/",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const role = req.query.role;
    const includeDeleted = req.query.includeDeleted === "true";
    const params: unknown[] = [];
    const filters: string[] = [];

    if (typeof role === "string") {
      filters.push(`role = $${params.length + 1}`);
      params.push(validateRole(role));
    }

    if (!includeDeleted) {
      filters.push("status != 'deleted'");
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await query<User>(
      `SELECT ${USER_COLUMNS}
       FROM users
       ${where}
       ORDER BY created_at DESC
       LIMIT 200`,
      params,
    );

    sendSuccess(res, { users: result.rows });
  }),
);

// POST /admin/users
adminUsersRouter.post(
  "/",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const email = validateEmail(body.email);
    const password = validatePassword(body.password);
    const role = validateRole(body.role, "driver");
    const displayName = optionalString(body.display_name);

    const existing = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);

    if (existing.rowCount && existing.rowCount > 0) {
      throw new AppError("An account with this email already exists.", 409);
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await query<User>(
      `INSERT INTO users (
         email,
         password_hash,
         display_name,
         auth_provider,
         role,
         status
       )
       VALUES ($1, $2, $3, 'email', $4, 'active')
       RETURNING ${USER_COLUMNS}`,
      [
        email,
        passwordHash,
        displayName ?? null,
        role,
      ],
    );

    await query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      result.rows[0].id,
    ]);

    sendSuccess(res, { user: result.rows[0] }, 201);
  }),
);

// PATCH /admin/users/:userId
adminUsersRouter.patch(
  "/:userId",
  apiRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];

    const addField = (name: string, value: unknown) => {
      fields.push(`${name} = $${values.length + 1}`);
      values.push(value);
    };

    if (body.email !== undefined) {
      addField("email", validateEmail(body.email));
    }

    if (body.display_name !== undefined) {
      addField("display_name", optionalString(body.display_name));
    }

    if (body.role !== undefined) {
      addField("role", validateRole(body.role));
    }

    const status = validateStatus(body.status);
    if (status !== undefined) {
      addField("status", status);
    }

    if (body.password !== undefined) {
      addField("password_hash", await bcrypt.hash(validatePassword(body.password), SALT_ROUNDS));
    }

    if (fields.length === 0) {
      throw new AppError("At least one field is required.", 400);
    }

    values.push(req.params.userId);
    const result = await query<User>(
      `UPDATE users
       SET ${fields.join(", ")}
       WHERE id = $${values.length} AND status != 'deleted'
       RETURNING ${USER_COLUMNS}`,
      values,
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw new AppError("User not found.", 404);
    }

    sendSuccess(res, { user: result.rows[0] });
  }),
);
