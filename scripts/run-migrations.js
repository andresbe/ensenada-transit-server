const { databaseOptions } = require("./database-options");
require("dotenv").config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });
const path = require("node:path");
const { Pool } = require("pg");
const { migrate } = require("./migration-runner");

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({
    ...databaseOptions(),
  });
  try {
    const client = await pool.connect();
    try {
      await migrate(client, path.join(__dirname, "..", "src", "db", "migrations"));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
