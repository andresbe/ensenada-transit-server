const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mobileLaunch, options } = require("../scripts/dev-local");
const settings = { mobile: path.resolve("test-mobile"), host: "192.168.100.7", port: 3000, mobilePort: 8081 };
test("starts Expo directly with LAN API, clean cache and no backend secrets", () => {
  const result = mobileLaunch(settings, { PATH: "tools", DATABASE_URL: "secret", JWT_SECRET: "secret", REDIS_URL: "secret", EXPO_PUBLIC_TRANSIT_API_URL: "https://production.example", REACT_NATIVE_PACKAGER_HOSTNAME: "old" }, () => true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.args.slice(1), ["start", "--clear", "--lan", "--port", "8081"]);
  assert.equal(result.env.EXPO_PUBLIC_TRANSIT_API_URL, "http://192.168.100.7:3000");
  assert.equal(result.env.REACT_NATIVE_PACKAGER_HOSTNAME, settings.host);
  assert.equal(result.env.DATABASE_URL, undefined);
  assert.equal(result.env.JWT_SECRET, undefined);
  assert.equal(result.env.REDIS_URL, undefined);
  assert.equal(result.env.PATH, "tools");
});
test("reports incomplete mobile source before trying to start Expo", () => {
  const result = mobileLaunch(settings, {}, file => file.endsWith("package.json"));
  assert.ok(result.missing.includes("app/ o src/app/"));
  assert.ok(result.missing.includes("app.json o app.config.js/ts"));
  assert.ok(result.missing.includes("dependencias de Expo (node_modules)"));
});
test("mobile remains enabled by default and can be explicitly skipped", () => {
  const interfaces = { wifi: [{ family: "IPv4", internal: false, address: settings.host }] };
  assert.equal(options([], interfaces).noMobile, false);
  assert.equal(options(["--no-mobile"], interfaces).noMobile, true);
});
