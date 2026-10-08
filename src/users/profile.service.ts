import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { getClient, query } from "../db";
import { AppError } from "../shared/errors";
import { USER_COLUMNS } from "./users.service";
import type { User } from "../types";

export async function validateProfile(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Invalid profile.", 400);
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["display_name", "avatar"].includes(key))) throw new AppError("Unsupported profile field.", 400);
  if (typeof input.display_name !== "string" || !input.display_name.trim() || input.display_name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(input.display_name)) throw new AppError("Name must contain 1 to 100 characters.", 400);
  let avatar: Buffer | null | undefined;
  if (input.avatar === null) avatar = null;
  else if (input.avatar !== undefined) {
    if (typeof input.avatar !== "string" || input.avatar.length > 90000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.avatar)) throw new AppError("Invalid avatar.", 400);
    try {
      const image = sharp(Buffer.from(input.avatar, "base64"), { limitInputPixels: 1048576, animated: false });
      const meta = await image.metadata();
      if (!["jpeg", "png", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) > 1) throw new Error("Unsupported image");
      // Decode, resize and re-encode; discard metadata and never retain the original upload.
      avatar = await image.rotate().resize(256, 256, { fit: "cover" }).jpeg({ quality: 75 }).toBuffer();
      if (avatar.length > 65536) throw new Error("Image too large");
    } catch { throw new AppError("Invalid avatar image.", 400); }
  }
  return { name: input.display_name.trim(), avatar };
}

export async function saveProfile(userId: string, body: unknown) {
  const input = await validateProfile(body);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const account = await client.query("SELECT id FROM users WHERE id=$1 AND status='active' AND role='user' AND auth_provider<>'guest' FOR UPDATE", [userId]);
    if (!account.rows.length) throw new AppError("A passenger account is required.", 403);
    let photo: string | null | undefined;
    if (input.avatar === null) {
      await client.query("DELETE FROM user_avatars WHERE user_id=$1", [userId]);
      photo = null;
    } else if (input.avatar) {
      await client.query("INSERT INTO user_avatars(user_id,image) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET image=EXCLUDED.image,updated_at=NOW()", [userId, input.avatar]);
      photo = `/users/me/avatar?v=${randomUUID()}`;
    }
    const result = await client.query<User>(`UPDATE users SET display_name=$2,updated_at=NOW()${photo === undefined ? "" : ",photo_url=$3"} WHERE id=$1 RETURNING ${USER_COLUMNS}`, photo === undefined ? [userId, input.name] : [userId, input.name, photo]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function readAvatar(userId: string) {
  const result = await query<{ image: Buffer }>("SELECT image FROM user_avatars WHERE user_id=$1", [userId]);
  return result.rows[0] ? `data:image/jpeg;base64,${result.rows[0].image.toString("base64")}` : null;
}
