const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function privateIp(address) {
  if (!net.isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function options(args, interfaces = os.networkInterfaces()) {
  const result = { port: 3000, mobilePort: 8081, mobile: path.resolve(root, "../ensenada-transit-users"), check: false, noMobile: false, stop: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") result.check = true;
    else if (arg === "--no-mobile") result.noMobile = true;
    else if (arg === "--stop") result.stop = true;
    else if (["--host", "--port", "--mobile-port", "--mobile"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Falta valor para ${arg}.`);
      if (arg === "--host") result.host = value;
      if (arg === "--port") result.port = Number(value);
      if (arg === "--mobile-port") result.mobilePort = Number(value);
      if (arg === "--mobile") result.mobile = path.resolve(value);
    } else throw new Error(`Opcion desconocida: ${arg}`);
  }
  for (const port of [result.port, result.mobilePort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Puerto invalido; usa 1024-65535.");
  }
  if (result.port === result.mobilePort) throw new Error("API y Expo necesitan puertos distintos.");
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) =>
    /docker|vEthernet|virtual|vmware|wsl|vpn|tailscale/i.test(name) ? [] :
      (entries ?? []).filter((entry) => !entry.internal && entry.family === "IPv4" && privateIp(entry.address)).map((entry) => entry.address));
  const unique = [...new Set(addresses)];
  if (!result.host && unique.length === 1) result.host = unique[0];
  if (!result.stop && (!privateIp(result.host ?? "") || !Object.values(interfaces).flat().some((entry) => entry?.address === result.host))) {
    throw new Error(`Selecciona la IPv4 privada de esta PC con --host. Candidatas: ${unique.join(", ") || "ninguna"}.`);
  }
  return result;
}

function childEnvironment(settings, secrets, inherited = process.env) {
  // Preserve OS/tooling variables, but never inherit remote services or credentials.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(DATABASE_|PG|REDIS_|JWT_|SMTP_|PUSH_|EXPO_ACCESS_TOKEN$|LOCATION_|DOTENV_|NODE_OPTIONS$|NODE_ENV$|PORT$|HOST$|CORS_)/i.test(key)));
  return {
    ...env, NODE_ENV: "development", HOST: "0.0.0.0", PORT: String(settings.port),
    DATABASE_URL: `postgresql://transit_local:${secrets.db}@127.0.0.1:55432/transit_local`,
    DATABASE_SSL_MODE: "disable", REDIS_URL: `redis://:${secrets.redis}@127.0.0.1:56379`,
    LOCAL_SIMULATION_ENABLED: "true", JWT_SECRET: secrets.jwt, JWT_EXPIRES_IN: "1d", LOCATION_UPDATE_AUTH_MODE: "required",
    LOCATION_DEBUG_TOKEN: secrets.debug, PUSH_NOTIFICATIONS_ENABLED: "false",
    SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "",
    DOTENV_CONFIG_PATH: path.join(root, ".local", "empty.env"),
    CORS_ORIGIN: `http://${settings.host}:${settings.mobilePort}`,
  };
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`El proceso termino con codigo ${code}.`)));
  });
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Puerto ${port} ocupado. Deten el proceso anterior o elige otro puerto.`)));
    server.listen(port, "0.0.0.0", () => server.close(resolve));
  });
}

function localDockerEndpoint(endpoint) {
  return typeof endpoint === "string" && /^(npipe:\/\/|unix:\/\/)/.test(endpoint.trim());
}

async function waitForApi(port, alive) {
  for (let i = 0; i < 60; i++) {
    if (!alive()) throw new Error("El backend se detuvo durante el arranque.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/catalog`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).schema_version === 1) return;
    } catch { /* Server recompiling or not listening yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("El backend no respondio con un catalogo valido en el tiempo esperado.");
}


function mobileLaunch(settings, inherited = process.env, exists = fs.existsSync) {
  const cli = path.join(settings.mobile, "node_modules", "expo", "bin", "cli");
  const missing = [];
  if (!exists(path.join(settings.mobile, "package.json"))) missing.push("package.json");
  if (!["app", "src/app"].some(entry => exists(path.join(settings.mobile, entry)))) missing.push("app/ o src/app/");
  if (!["app.json", "app.config.js", "app.config.ts"].some(entry => exists(path.join(settings.mobile, entry)))) missing.push("app.json o app.config.js/ts");
  if (!exists(cli)) missing.push("dependencias de Expo (node_modules)");
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(DATABASE_|PG|REDIS_|JWT_|SMTP_|PUSH_|EXPO_ACCESS_TOKEN$|LOCATION_|DOTENV_|NODE_OPTIONS$|NODE_ENV$|PORT$|HOST$|CORS_|LOCAL_SIMULATION_)/i.test(key)));
  return {
    missing,
    args: [cli, "start", "--clear", "--lan", "--port", String(settings.mobilePort)],
    env: { ...env, NODE_ENV: "development", EXPO_PUBLIC_TRANSIT_API_URL: "http://" + settings.host + ":" + settings.port, REACT_NATIVE_PACKAGER_HOSTNAME: settings.host },
  };
}

async function main(args = process.argv.slice(2)) {
  const settings = options(args);
  const dockerPaths = [
    path.join(process.env.LOCALAPPDATA ?? "", "Programs/DockerDesktop/resources/bin/docker.exe"),
    "C:/Program Files/Docker/Docker/resources/bin/docker.exe",
  ];
  const docker = dockerPaths.find((candidate) => fs.existsSync(candidate)) ?? "docker";
  // Compose uses credential helpers from this directory on Windows.
  if (path.isAbsolute(docker)) process.env.PATH = `${path.dirname(docker)}${path.delimiter}${process.env.PATH ?? ""}`;
  const dockerReady = spawnSync(docker, ["compose", "version"], { windowsHide: true, stdio: "ignore", timeout: 10000 }).status === 0;
  const engineReady = dockerReady && spawnSync(docker, ["info", "--format", "{{.ServerVersion}}"], { windowsHide: true, stdio: "ignore", timeout: 15000 }).status === 0;
  const mobile = mobileLaunch(settings);
  const dependenciesReady = fs.existsSync(path.join(root, "node_modules", "ts-node-dev", "lib", "bin.js"));
  const mobileReady = settings.noMobile || mobile.missing.length === 0;
  if (settings.check) {
    console.log(`IP local: ${settings.host}\nAPI: http://${settings.host}:${settings.port}\nExpo: ${settings.mobilePort}\nDocker Compose: ${dockerReady ? "OK" : "FALTA: instala Docker Desktop y abrelo"}\nDependencias backend: ${dependenciesReady ? "OK" : "FALTA: npm ci"}\nApp movil: ${mobileReady ? "OK" : "FALTA: revisa --mobile e instala dependencias"}`);
    console.log(`Motor Docker: ${engineReady ? "OK" : "NO DISPONIBLE: abre Docker Desktop y espera a que el motor termine de iniciar"}`);
    if (!mobileReady) console.log("App incompleta en " + settings.mobile + ": falta " + mobile.missing.join(", ") + ". Usa --mobile para otra carpeta o --no-mobile para iniciar solo el backend.");
    if (!dockerReady || !engineReady || !dependenciesReady || !mobileReady) process.exitCode = 1;
    return;
  }
  if (!dockerReady) throw new Error("Falta Docker Desktop/Compose. Instalalo y abrelo; despues ejecuta npm run dev:local otra vez.");
  if (!engineReady) throw new Error("Docker esta instalado, pero su motor no responde. Abre Docker Desktop y completa su configuracion inicial.");
  const endpoint = process.env.DOCKER_HOST || spawnSync(docker, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { windowsHide: true, encoding: "utf8" }).stdout?.trim();
  if (!localDockerEndpoint(endpoint)) throw new Error("Selecciona un contexto Docker local (Docker Desktop). No se permiten daemons remotos para estas pruebas.");
  const state = path.join(root, ".local");
  const envFile = path.join(state, "compose.env");
  const compose = ["compose", "--project-name", "ensenada-transit-local", "--env-file", envFile, "-f", path.join(root, "compose.local.yml")];
  if (settings.stop) {
    if (!fs.existsSync(envFile)) throw new Error("No hay entorno local inicializado.");
    await run(docker, [...compose, "stop"]);
    return;
  }
  if (!mobileReady) throw new Error("App incompleta en " + settings.mobile + ": falta " + mobile.missing.join(", ") + ". Recupera sus archivos, usa --mobile con otra carpeta o --no-mobile para iniciar solo el backend.");
  if (!dependenciesReady) throw new Error("Faltan dependencias del backend. Ejecuta --check para ver requisitos.");
  await checkPort(settings.port);
  if (!settings.noMobile) await checkPort(settings.mobilePort);
  fs.mkdirSync(state, { recursive: true });
  const secretsFile = path.join(state, "secrets.json");
  let secrets;
  if (fs.existsSync(secretsFile)) secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  else {
    secrets = Object.fromEntries(["db", "redis", "jwt", "debug"].map((key) => [key, randomBytes(32).toString("hex")]));
    fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  }
  if (!["db", "redis", "jwt", "debug"].every((key) => /^[a-f0-9]{64}$/.test(secrets[key]))) throw new Error("Configuracion local invalida; no se sobrescribieron credenciales.");
  fs.writeFileSync(envFile, `LOCAL_DB_PASSWORD=${secrets.db}\nLOCAL_REDIS_PASSWORD=${secrets.redis}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(state, "empty.env"), "# Intentionally empty: never load the production .env.\n");
  const env = childEnvironment(settings, secrets);
  // Public OAuth audience, shared with the local mobile configuration.
  const googleFile = path.join(settings.mobile, "google-services.json");
  if (fs.existsSync(googleFile)) {
    const google = JSON.parse(fs.readFileSync(googleFile, "utf8"));
    const mobileConfig = JSON.parse(fs.readFileSync(path.join(settings.mobile, "app.json"), "utf8"));
    const android = google.client?.find(client => client.client_info?.android_client_info?.package_name === mobileConfig.expo.android.package);
    env.GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || android?.oauth_client?.find(client => client.client_type === 3)?.client_id || "";
  }
  await run(docker, [...compose, "up", "-d", "--wait"], {
    ...process.env, LOCAL_DB_PASSWORD: secrets.db, LOCAL_REDIS_PASSWORD: secrets.redis,
  });
  // This child receives only loopback URLs for the dedicated local containers.
  await run(process.execPath, [path.join(__dirname, "run-migrations.js")], env);
  const children = new Set();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (!child.pid || child.exitCode !== null) continue;
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ } }
    }
    console.log("API y Expo detenidos. Los datos locales se conservan; usa npm run local:stop para detener PostgreSQL/Redis.");
  };
  const launch = (args, cwd, childEnv) => {
    const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: "inherit", windowsHide: true, detached: process.platform !== "win32" });
    children.add(child);
    child.on("error", (error) => { console.error(error.message); process.exitCode = 1; stop(); });
    child.on("exit", (code) => { children.delete(child); if (!stopping) { process.exitCode = code ?? 1; stop(); } });
    return child;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log(`Backend local: http://${settings.host}:${settings.port}\nPostgreSQL/Redis: solo loopback; produccion excluida.`);
    const server = launch([path.join(root, "node_modules/ts-node-dev/lib/bin.js"), "--respawn", "--transpile-only", "src/server.ts"], root, env);
    await waitForApi(settings.port, () => !stopping && server.exitCode === null);
    console.log(`Abre http://${settings.host}:${settings.port}/health desde el telefono conectado al mismo Wi-Fi.`);
    if (!settings.noMobile) {
      console.log("Iniciando app de usuarios desde " + settings.mobile + " con API " + mobile.env.EXPO_PUBLIC_TRANSIT_API_URL + ". Escanea el QR de Expo con el teléfono en la misma red.");
      launch(mobile.args, settings.mobile, mobile.env);
    }
  } catch (error) { stop(); throw error; }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, privateIp, childEnvironment, localDockerEndpoint, mobileLaunch };
