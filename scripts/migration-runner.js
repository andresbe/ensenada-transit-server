const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

async function migrate(client, directory, log = console.log) {
  await client.query("SELECT pg_advisory_lock(875413029)");
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const files = (await fs.readdir(directory)).filter(name => name.endsWith(".sql")).sort();
    for (const name of files) {
      const sql = await fs.readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
      const prior = await client.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
      if (prior.rows.length) {
        if (prior.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}. Create a new migration instead.`);
        log(`[migrate] Already applied ${name}`);
        continue;
      }
      log(`[migrate] Applying ${name}`);
      await client.query("BEGIN");
      try {
        // Keep the migration and its journal record inside one transaction.
        await client.query(sql.replace(/^\s*(?:BEGIN|COMMIT);\s*$/gm, ""));
        await client.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [name,checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally { await client.query("SELECT pg_advisory_unlock(875413029)"); }
}
module.exports = { migrate };
