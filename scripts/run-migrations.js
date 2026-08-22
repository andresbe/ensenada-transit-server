/* eslint-disable no-console */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function requireEnv(name) {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
}

async function main() {
  const migrationsDir = path.join(__dirname, "..", "src", "db", "migrations");

  if (!fs.existsSync(migrationsDir)) {
    console.log("[migrate] No migrations directory found.");
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("[migrate] No SQL migrations found.");
    return;
  }

  const pool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  try {
    for (const file of files) {
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, "utf8");
      console.log(`[migrate] Running ${file}`);
      await pool.query(sql);
    }

    console.log("[migrate] Migration complete.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
