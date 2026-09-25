export const DRIVER_PACKAGE = "com.ensenadatransit.driver";

export interface AppUpdateManifest {
  packageName: string;
  versionName: string;
  versionCode: number;
  minSupportedVersionCode: number;
  apkUrl: string;
  sha256: string;
  sizeBytes: number;
  releaseNotes: string[];
}

export function validateManifest(input: unknown): AppUpdateManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Manifest must be a JSON object.");
  }
  const m = input as Record<string, unknown>;
  const integer = (value: unknown, max: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
  if (typeof m.packageName !== "string" || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(m.packageName)) {
    throw new Error("Invalid packageName.");
  }
  if (typeof m.versionName !== "string" || !m.versionName.trim()) throw new Error("Invalid versionName.");
  if (!integer(m.versionCode, 2147483647)) throw new Error("Invalid versionCode.");
  if (!integer(m.minSupportedVersionCode, m.versionCode)) throw new Error("Invalid minSupportedVersionCode.");
  if (!integer(m.sizeBytes, Number.MAX_SAFE_INTEGER)) throw new Error("Invalid sizeBytes.");
  if (typeof m.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(m.sha256)) throw new Error("Invalid sha256.");
  if (typeof m.apkUrl !== "string") throw new Error("Invalid apkUrl.");
  const url = new URL(m.apkUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("apkUrl must use public HTTPS without credentials or a fragment.");
  }
  if (!Array.isArray(m.releaseNotes) || !m.releaseNotes.every((note: unknown) => typeof note === "string" && note.trim().length > 0)) {
    throw new Error("releaseNotes must be an array of non-empty strings.");
  }
  return {
    packageName: m.packageName, versionName: m.versionName,
    versionCode: m.versionCode, minSupportedVersionCode: m.minSupportedVersionCode,
    apkUrl: m.apkUrl, sha256: m.sha256.toLowerCase(), sizeBytes: m.sizeBytes,
    releaseNotes: m.releaseNotes as string[],
  };
}
