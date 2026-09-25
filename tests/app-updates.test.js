const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const express = require("express");
const { validateManifest } = require("../dist/app-updates/manifest");
const { verifyDownload, activateRelease } = require("../scripts/publish-app-update");

const bytes = Buffer.from("test APK bytes");
const manifest = {
  packageName: "com.ensenadatransit.driver", versionName: "1.0.30", versionCode: 31,
  minSupportedVersionCode: 1, apkUrl: "https://downloads.example.com/driver-31.apk",
  sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
  releaseNotes: ["Mejoras de estabilidad."],
};

test("manifest rejects invalid fields and preserves the wire contract", () => {
  assert.deepEqual(validateManifest({ ...manifest, active: true }), manifest);
  for (const patch of [
    { versionCode: "31" }, { versionCode: 0 }, { versionCode: 1.5 },
    { minSupportedVersionCode: 32 }, { minSupportedVersionCode: 0 },
    { sizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { sizeBytes: -1 },
    { sha256: "invalid" }, { apkUrl: "http://example.com/app.apk" },
    { apkUrl: "https://user:password@example.com/app.apk" },
    { releaseNotes: "notes" }, { releaseNotes: [1] }, { versionName: " " },
    { packageName: "invalid" },
  ]) assert.throws(() => validateManifest({ ...manifest, ...patch }));
});

test("download verification detects corrupt, truncated, oversized and failed downloads", async () => {
  await verifyDownload(manifest, async () => new Response(bytes));
  for (const body of [Buffer.alloc(bytes.length), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
    await assert.rejects(verifyDownload(manifest, async () => new Response(body)));
  }
  await assert.rejects(verifyDownload(manifest, async () => new Response("missing", { status: 404 })));
  await assert.rejects(verifyDownload(manifest, async () => { throw new Error("interrupted"); }));
  await assert.rejects(verifyDownload(manifest, async () => new Response(null, {
    status: 302, headers: { location: "http://example.com/app.apk" },
  })), /HTTPS/);
  let requests = 0;
  await verifyDownload(manifest, async () => ++requests === 1
    ? new Response(null, { status: 302, headers: { location: "/new.apk" } })
    : new Response(bytes));
  assert.equal(requests, 2);
});

test("publication commits atomically and rolls back duplicates", async () => {
  for (const duplicate of [false, true]) {
    const queries = [];
    let released = false;
    const pool = { connect: async () => ({
      query: async (sql) => {
        queries.push(sql);
        if (duplicate && sql.startsWith("INSERT")) throw Object.assign(new Error("duplicate"), { code: "23505" });
      },
      release: () => { released = true; },
    }) };
    if (duplicate) await assert.rejects(activateRelease(pool, manifest), /already been published/);
    else await activateRelease(pool, manifest);
    assert.equal(queries[0], "BEGIN");
    assert.match(queries[1], /pg_advisory_xact_lock/);
    assert.equal(queries.at(-1), duplicate ? "ROLLBACK" : "COMMIT");
    assert.equal(released, true);
  }
});

test("public endpoint returns exact JSON, numeric size, no-cache, 404 and 503", async (t) => {
  const db = require("../dist/db");
  const originalQuery = db.query;
  t.after(() => { db.query = originalQuery; });
  const { appUpdatesRouter } = require("../dist/app-updates/appUpdates.routes");
  const { errorHandler } = require("../dist/shared/errors");
  const app = express();
  app.use("/updates", appUpdatesRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/updates/android/latest.json`;
  db.query = async (_sql, params) => {
    assert.deepEqual(params, [manifest.packageName]);
    return { rows: [{ ...manifest, sizeBytes: String(manifest.sizeBytes) }] };
  };
  const success = await fetch(url);
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "no-cache");
  assert.deepEqual(await success.json(), manifest);
  db.query = async () => ({ rows: [] });
  const missing = await fetch(url);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-cache");
  db.query = async () => { throw new Error("test database failure"); };
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-cache");
  assert.deepEqual(await unavailable.json(), { error: { message: "Update metadata temporarily unavailable" } });
});
