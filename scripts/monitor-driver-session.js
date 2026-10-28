// Read-only local field monitor; records no coordinates, account data, or credentials.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const dev = require('./dev-local');

const args = process.argv.slice(2);
const sessionId = args[1];
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const intervalSeconds = Number(option('--interval', 30));
const samples = Number(option('--samples', 780)); // 6.5 hours at 30 seconds.
const output = path.resolve(option('--output', path.join(__dirname, '../.local/driver-session-monitor.jsonl')));

if (args[0] !== '--local' || !/^[0-9a-f-]{36}$/i.test(sessionId || '') ||
    !Number.isInteger(samples) || samples < 1 || !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 1 || intervalSeconds > 300) {
  console.error('Usage: node scripts/monitor-driver-session.js --local SESSION_UUID [--interval SECONDS] [--samples N] [--output FILE]');
  process.exit(1);
}

const settings = dev.options(['--no-mobile']);
const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, '../.local/secrets.json'), 'utf8'));
const env = dev.childEnvironment(settings, secrets);
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });

async function observe() {
  const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await db.connect();
    const result = await db.query(`SELECT status, last_heartbeat_at, last_gps_at,
      tracking_diagnostics->>'trackingMode' AS tracking_mode,
      jsonb_array_length(tracking_samples) AS retained_samples,
      last_location->>'timestamp' AS last_accepted_location_at
      FROM driver_sessions WHERE id=$1`, [sessionId]);
    const row = result.rows[0];
    if (!row) return { found: false };
    const now = Date.now();
    const age = value => value ? Math.max(0, Math.round((now - new Date(value).getTime()) / 1000)) : null;
    return {
      found: true,
      status: row.status,
      heartbeatAgeSeconds: age(row.last_heartbeat_at),
      gpsAgeSeconds: age(row.last_gps_at),
      acceptedLocationAgeSeconds: row.last_accepted_location_at ?
        Math.max(0, Math.round((now - Number(row.last_accepted_location_at)) / 1000)) : null,
      trackingMode: row.tracking_mode,
      retainedSamples: Number(row.retained_samples),
    };
  } finally {
    await db.end().catch(() => {});
  }
}

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log(`Monitoring local driver session; report: ${output}`);
  let previousState = '';
  for (let index = 0; index < samples && !stopped; index++) {
    const started = Date.now();
    let observation;
    try { observation = await observe(); }
    catch (error) { observation = { databaseReachable: false, error: error.code || error.name }; }
    const entry = { at: new Date(started).toISOString(), ...observation };
    fs.appendFileSync(output, JSON.stringify(entry) + '\n');
    const state = `${observation.databaseReachable !== false}/${observation.found}/${observation.status}/${observation.trackingMode}`;
    if (state !== previousState || index % Math.max(1, Math.round(600 / intervalSeconds)) === 0) {
      console.log(`${entry.at} status=${observation.status || '-'} heartbeat=${observation.heartbeatAgeSeconds ?? '-'}s gps=${observation.gpsAgeSeconds ?? '-'}s accepted=${observation.acceptedLocationAgeSeconds ?? '-'}s`);
      previousState = state;
    }
    if (index + 1 < samples && !stopped) await new Promise(resolve => setTimeout(resolve, Math.max(0, intervalSeconds * 1000 - (Date.now() - started))));
  }
  console.log(`Monitoring ended; report: ${output}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
