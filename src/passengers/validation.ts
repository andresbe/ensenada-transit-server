import { AppError } from "../shared/errors";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("JSON object required.", 400);
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new AppError(`${name} must contain 1-${max} characters.`, 400);
  return value.trim();
}
export function uuid(value: unknown, name = "id"): string {
  const result = text(value, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new AppError(`${name} must be a UUID.`, 400);
  return result;
}
export function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) throw new AppError(`${name} must be one of ${values.join(", ")}.`, 400);
  return value as T;
}
export function coordinate(value: unknown, name: "latitude" | "longitude"): number {
  const limit = name === "latitude" ? 90 : 180;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) throw new AppError(`Invalid ${name}.`, 400);
  return value;
}
export function page(query: Record<string, unknown>) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new AppError("Invalid pagination.", 400);
  return { limit, offset };
}
