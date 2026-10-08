export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret?.trim() || secret === "change_me_in_production") {
    throw new Error("Configure JWT_SECRET; a default signing secret is not allowed.");
  }
  if (process.env.NODE_ENV === "production" && Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_SECRET must contain at least 32 bytes in production.");
  }
  return secret;
}
