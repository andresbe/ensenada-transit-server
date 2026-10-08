import { OAuth2Client } from "google-auth-library";
import bcrypt from "bcrypt";
import { getClient } from "../db";
import { AppError } from "../shared/errors";
import type { User } from "../types";

const verifier = new OAuth2Client();
export async function verifyGoogleIdentity(token: string) {
  const audience = process.env.GOOGLE_WEB_CLIENT_ID?.trim();
  if (!audience) throw new AppError("Google sign-in is not configured.", 503);
  if (!token || token.length > 16000) throw new AppError("Invalid Google token.", 401);
  try {
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const claims = ticket.getPayload();
    if (!claims?.sub || !claims.email || claims.email_verified !== true || claims.sub.length > 255) throw new Error("Invalid identity");
    const email = claims.email.toLowerCase();
    const authoritativeEmail = email.endsWith("@gmail.com") || (typeof claims.hd === "string" && claims.hd.length > 0);
    return { subject: claims.sub, email, authoritativeEmail, name: claims.name?.slice(0, 200) ?? null, picture: claims.picture ?? null };
  } catch { throw new AppError("Invalid or expired Google token.", 401); }
}

export async function googleUser(token: string, password?: string): Promise<User> {
  const identity = await verifyGoogleIdentity(token);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    // Serialize simultaneous logins for the same verified Google identity.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["google:" + identity.subject]);
    const existing = await client.query<User>(`SELECT u.id,u.email,u.display_name,u.photo_url,u.auth_provider,u.role,u.status,u.is_tester,u.created_at,u.updated_at
      FROM user_social_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='google' AND i.subject=$1 FOR UPDATE OF u`, [identity.subject]);
    let user = existing.rows[0];
    if (user && (user.status !== "active" || user.role !== "user")) throw new AppError("Account unavailable.", 403);
    if (!user) {
      const collision = await client.query<User & { password_hash: string | null }>(`SELECT id,email,display_name,photo_url,auth_provider,role,status,is_tester,created_at,updated_at,password_hash
        FROM users WHERE lower(email)=$1 FOR UPDATE`, [identity.email]);
      if (collision.rows.length > 1) throw new AppError("Use your original sign-in method.", 409);
      const account = collision.rows[0];
      if (account) {
        if (account.status !== "active" || account.role !== "user") throw new AppError("Account unavailable.", 403);
        const linked = await client.query("SELECT subject FROM user_social_identities WHERE user_id=$1 AND provider='google'", [account.id]);
        if (linked.rows.length || account.auth_provider !== "email") throw new AppError("Use your original sign-in method.", 409);
        if (!identity.authoritativeEmail) {
          if (password === undefined) throw new AppError("Confirm your password to link Google.", 428);
          if (!account.password_hash || !password || Buffer.byteLength(password, "utf8") > 72 || !await bcrypt.compare(password, account.password_hash)) throw new AppError("Invalid password.", 401);
        }
        const { password_hash: _hash, ...publicUser } = account;
        user = publicUser;
      } else {
        const inserted = await client.query<User>(`INSERT INTO users(email,display_name,photo_url,auth_provider,role,status)
        VALUES($1,$2,$3,'google','user','active') RETURNING id,email,display_name,photo_url,auth_provider,role,status,is_tester,created_at,updated_at`, [identity.email, identity.name, identity.picture]);
        user = inserted.rows[0];
      }
      await client.query("INSERT INTO user_social_identities(provider,subject,user_id) VALUES('google',$1,$2)", [identity.subject, user.id]);
    }
    await client.query("INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING", [user.id]);
    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as {code?: string}).code === "23505") throw new AppError("An account with this email already exists.", 409);
    throw error;
  } finally { client.release(); }
}
