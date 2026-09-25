require("dotenv").config();
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { Pool } = require("pg");
const { validateManifest, DRIVER_PACKAGE } = require("../dist/app-updates/manifest");

async function verifyDownload(manifest, fetchImpl = fetch) {
  // One deadline covers headers, redirects and the streamed body. Never buffer the APK.
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  let url = manifest.apkUrl;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("APK download and redirects must use HTTPS without credentials.");
    }
    const response = await fetchImpl(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("APK redirect has no Location header.");
      url = new URL(location, url).href;
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`APK download failed (HTTP ${response.status}).`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > manifest.sizeBytes) throw new Error("APK exceeds declared sizeBytes.");
      hash.update(chunk);
    }
    if (bytes !== manifest.sizeBytes) throw new Error("APK sizeBytes mismatch.");
    if (hash.digest("hex") !== manifest.sha256) throw new Error("APK sha256 mismatch.");
    return;
  }
  throw new Error("Too many APK redirects.");
}

async function activateRelease(pool, manifest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializes publishers even when this package has no rows yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [manifest.packageName]);
    await client.query("UPDATE app_releases SET active = FALSE WHERE package_name = $1 AND active = TRUE", [manifest.packageName]);
    await client.query(`INSERT INTO app_releases
      (package_name, version_name, version_code, min_supported_version_code,
       apk_url, sha256, size_bytes, release_notes, active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, TRUE)`, [
      manifest.packageName, manifest.versionName, manifest.versionCode,
      manifest.minSupportedVersionCode, manifest.apkUrl, manifest.sha256,
      manifest.sizeBytes, JSON.stringify(manifest.releaseNotes),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw new Error("This package/versionCode has already been published.");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: npm run updates:publish -- ./latest.json");
  const manifest = validateManifest(JSON.parse(await fs.readFile(args[0], "utf8")));
  if (manifest.packageName !== DRIVER_PACKAGE) throw new Error(`Expected packageName ${DRIVER_PACKAGE}.`);
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required.");
  console.log("[updates] Verifying public APK download, size and SHA-256...");
  await verifyDownload(manifest);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
  });
  try {
    await activateRelease(pool, manifest);
    console.log(`[updates] Published ${manifest.packageName} ${manifest.versionName} (${manifest.versionCode}).`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[updates] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { verifyDownload, activateRelease };
