// Read-only diagnostics for a local test session; never prints coordinates or credentials.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const dev = require('./dev-local');
const id = process.argv[3];
if (process.argv[2] !== '--local' || !/^[0-9a-f-]{36}$/i.test(id || '')) {
  console.error('Usage: node scripts/tracking-report.js --local SESSION_UUID');
  process.exit(1);
}
(async () => {
  const settings = dev.options(['--no-mobile']);
  const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, '../.local/secrets.json'), 'utf8'));
  const env = dev.childEnvironment(settings, secrets);
  const db = new Client({ connectionString: env.DATABASE_URL });
  await db.connect();
  try {
    const result = await db.query('SELECT status,started_at,ended_at,last_heartbeat_at,last_gps_at,tracking_diagnostics,tracking_samples FROM driver_sessions WHERE id=$1', [id]);
    if (!result.rows.length) throw new Error('Local session not found.');
    const { tracking_samples: samples, ...summary } = result.rows[0];
    const times = samples.map(p => p.timestamp).sort((a,b) => a-b);
    const gaps = times.slice(1).map((time,i) => time-times[i]);
    console.log(JSON.stringify({ ...summary, retainedSamples: times.length, retainedSpanMinutes: times.length ? (times.at(-1)-times[0])/60000 : 0, maximumRetainedGpsGapSeconds: Math.max(0,...gaps)/1000, retainedGapsOver120Seconds: gaps.filter(g => g>120000).length, note: 'Bounded GPS sample window, not complete connection history or proof of uninterrupted tracking.' }, null, 2));
  } finally { await db.end(); }
})().catch(error => { console.error(error.message); process.exitCode=1; });
