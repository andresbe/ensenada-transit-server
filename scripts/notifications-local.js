// Dedicated local database only; never inherit production connection settings.
const fs = require("node:fs");
const path = require("node:path");
const { childEnvironment } = require("./dev-local");

async function main() {
  const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, "../.local/secrets.json"), "utf8"));
  if (!["db", "redis", "jwt", "debug"].every(key => /^[a-f0-9]{64}$/.test(secrets[key]))) {
    throw new Error("Invalid local credentials. Run dev-local.js first.");
  }
  const env = childEnvironment({ host: "127.0.0.1", port: 3000, mobilePort: 8081 }, secrets);
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key];
  }
  Object.assign(process.env, env, { PUSH_NOTIFICATIONS_ENABLED: "true" });
  const { deliverPublishedAlerts } = require("../dist/passengers/push.service");
  const pool = require("../dist/db").default;
  let stopping = false;
  let wake;
  const stop = () => { stopping = true; if (wake) wake(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Notificaciones locales activas: consulta cada 15 segundos; Ctrl+C para detener.");
  try {
    while (!stopping) {
      try { await deliverPublishedAlerts(); }
      catch { console.error("No se pudo procesar el envio local; se reintentara."); }
      if (stopping) break;
      await new Promise(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, 15000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  } finally { await pool.end(); }
}

main().catch(() => { console.error("No se pudo iniciar. Ejecuta dev-local.js y npm run build primero."); process.exitCode = 1; });
