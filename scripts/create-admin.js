const { databaseOptions } = require("./database-options");
require("dotenv").config();
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

function adminInput(env) {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid ADMIN_EMAIL is required.");
  }
  if (!password || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("ADMIN_PASSWORD must contain at least 8 characters and at most 72 UTF-8 bytes.");
  }
  return { email, password, displayName: env.ADMIN_DISPLAY_NAME?.trim() || null };
}

async function main() {
  const input = adminInput(process.env);
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required.");
  const passwordHash = await bcrypt.hash(input.password, 12);
  const pool = new Pool({
    ...databaseOptions(),
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await pool.query(
      `INSERT INTO admins (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, status, created_at`,
      [input.email, passwordHash, input.displayName],
    );
    console.log(JSON.stringify({ admin: result.rows[0] }, null, 2));
  } catch (error) {
    if (error.code === "23505") throw new Error("An admin with this email already exists; no changes were made.");
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { adminInput };
