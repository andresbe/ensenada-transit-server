import { AppError } from "../shared/errors";

// ── Email ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidEmail = (email: string): boolean => EMAIL_RE.test(email.trim());

export const validateEmail = (email: unknown): string => {
  if (typeof email !== "string" || email.trim() === "") {
    throw new AppError("email is required.", 400);
  }
  if (!isValidEmail(email)) {
    throw new AppError("email is not valid.", 400);
  }
  return email.trim().toLowerCase();
};

// ── Password ──────────────────────────────────────────────────

export const validatePassword = (password: unknown): string => {
  if (typeof password !== "string" || password.length < 8) {
    throw new AppError("password must be at least 8 characters.", 400);
  }
  return password;
};

// ── Register input ────────────────────────────────────────────

export interface RegisterInput {
  email: string;
  password: string;
  display_name?: string;
}

export const validateRegisterInput = (body: unknown): RegisterInput => {
  if (typeof body !== "object" || body === null) {
    throw new AppError("Request body must be a JSON object.", 400);
  }
  const b = body as Record<string, unknown>;
  const email = validateEmail(b.email);
  const password = validatePassword(b.password);
  const display_name =
    typeof b.display_name === "string" && b.display_name.trim() !== ""
      ? b.display_name.trim()
      : undefined;
  return { email, password, display_name };
};

// ── Login input ───────────────────────────────────────────────

export interface LoginInput {
  email: string;
  password: string;
}

export const validateLoginInput = (body: unknown): LoginInput => {
  if (typeof body !== "object" || body === null) {
    throw new AppError("Request body must be a JSON object.", 400);
  }
  const b = body as Record<string, unknown>;
  const email = validateEmail(b.email);
  const password = validatePassword(b.password);
  return { email, password };
};
