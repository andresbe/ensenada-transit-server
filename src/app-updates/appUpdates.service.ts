import { query } from "../db";
import { AppError } from "../shared/errors";
import { AppUpdateManifest, DRIVER_PACKAGE, validateManifest } from "./manifest";

export async function getLatestAndroidRelease(): Promise<AppUpdateManifest | null> {
  try {
    const result = await query(`
      SELECT package_name AS "packageName", version_name AS "versionName",
        version_code AS "versionCode", min_supported_version_code AS "minSupportedVersionCode",
        apk_url AS "apkUrl", sha256, size_bytes AS "sizeBytes", release_notes AS "releaseNotes"
      FROM app_releases WHERE package_name = $1 AND active = TRUE LIMIT 1
    `, [DRIVER_PACKAGE]);
    const row = result.rows[0];
    // pg returns BIGINT as a string; the manifest contract requires a JSON number.
    return row ? validateManifest({ ...row, sizeBytes: Number(row.sizeBytes) }) : null;
  } catch (error) {
    console.error("[app-updates] Cannot read release metadata:", error);
    throw new AppError("Update metadata temporarily unavailable", 503);
  }
}
