#!/usr/bin/env node
const { Pool } = require("pg");
const { databaseOptions } = require("./database-options");

const usage = `Usage:
  npm run replay:hardware-direction -- --device-id <uuid> [--from <ISO>] [--to <ISO>] [--limit <n>]

Reads valid Teltonika/Ruptela rows in timestamp order inside a PostgreSQL READ ONLY
transaction. Output is JSON Lines on stdout. It never connects to Redis or persists
detector state. Build the project first so dist/tracking/hardwareDirection.js exists.`;

function argumentsFrom(argv) {
  const options = { limit: 50000 };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    const next = argv[index + 1];
    if (value === "--device-id") { options.deviceId = next; index++; }
    else if (value === "--from") { options.from = next; index++; }
    else if (value === "--to") { options.to = next; index++; }
    else if (value === "--limit") { options.limit = Number(next); index++; }
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.deviceId ?? "")) {
    throw new Error("--device-id must be a UUID.");
  }
  for (const name of ["from", "to"]) {
    if (options[name] !== undefined && !Number.isFinite(Date.parse(options[name]))) {
      throw new Error(`--${name} must be an ISO timestamp.`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 250000) {
    throw new Error("--limit must be an integer between 1 and 250000.");
  }
  return options;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required.");
  const {
    createHardwareDirectionVariant,
    defaultHardwareDirectionConfig,
    evaluateHardwareDirection,
    hardwareDirectionGeometryFingerprint,
  } = require("../dist/tracking/hardwareDirection");
  const pool = new Pool({
    ...databaseOptions(),
    statement_timeout: 60000,
    application_name: "hardware-direction-read-only-replay",
    max: 1,
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionOpen = true;
    const parameters = [options.deviceId];
    const conditions = [
      "l.device_id=$1",
      "l.source IN ('TELTONIKA','RUPTELA')",
      "l.is_valid",
      "l.assignment_id IS NOT NULL",
    ];
    if (options.from) {
      parameters.push(new Date(options.from));
      conditions.push(`l.recorded_at >= $${parameters.length}`);
    }
    if (options.to) {
      parameters.push(new Date(options.to));
      conditions.push(`l.recorded_at <= $${parameters.length}`);
    }
    parameters.push(options.limit);
    const rows = (await client.query(
      `SELECT l.id,l.source,l.device_id::text,l.assignment_id::text,l.latitude::float8,
        l.longitude::float8,l.speed_mps,l.heading,l.satellites,l.recorded_at,
        NULLIF(l.telemetry->>'hdop','')::real AS hdop,
        a.route_variant_id::text AS assigned_route_variant_id,
        rv.route_id::text,rv.direction AS assigned_direction
       FROM vehicle_gps_locations l
       JOIN vehicle_device_assignments a ON a.id=l.assignment_id
       JOIN route_variants rv ON rv.id=a.route_variant_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY l.recorded_at,l.id LIMIT $${parameters.length}`,
      parameters,
    )).rows;
    const routeIds = [...new Set(rows.map(row => row.route_id))];
    const variantRows = routeIds.length ? (await client.query(
      `SELECT id::text,route_id::text,direction,coordinates,updated_at
       FROM route_variants WHERE route_id=ANY($1::uuid[]) AND direction IN ('ida','vuelta')
       ORDER BY route_id,direction,id`,
      [routeIds],
    )).rows : [];
    await client.query("ROLLBACK");
    transactionOpen = false;

    const variantsByRoute = new Map();
    for (const row of variantRows) {
      const variant = createHardwareDirectionVariant({
        id: row.id,
        routeId: row.route_id,
        direction: row.direction,
        coordinates: row.coordinates,
        updatedAt: row.updated_at,
      });
      const variants = variantsByRoute.get(row.route_id) ?? [];
      variants.push(variant);
      variantsByRoute.set(row.route_id, variants);
    }

    let state;
    for (const row of rows) {
      const variants = variantsByRoute.get(row.route_id) ?? [];
      const pairIsSafe = variants.length === 2 &&
        variants.filter(variant => variant.direction === "ida").length === 1 &&
        variants.filter(variant => variant.direction === "vuelta").length === 1 &&
        variants.some(variant => variant.id === row.assigned_route_variant_id);
      if (!pairIsSafe) {
        state = undefined;
        console.log(JSON.stringify({
          timestamp: new Date(row.recorded_at).toISOString(),
          deviceId: row.device_id,
          assignedRouteVariantId: row.assigned_route_variant_id,
          assignedDirection: row.assigned_direction,
          confidence: "low",
          reason: "route_variant_pair_ambiguous",
        }));
        continue;
      }
      const evaluation = evaluateHardwareDirection(
        {
          assignmentId: row.assignment_id,
          routeId: row.route_id,
          assignedRouteVariantId: row.assigned_route_variant_id,
          geometryFingerprint: hardwareDirectionGeometryFingerprint(variants),
        },
        variants,
        state,
        {
          timestamp: new Date(row.recorded_at).getTime(),
          latitude: row.latitude,
          longitude: row.longitude,
          speedMps: row.speed_mps === null ? undefined : Number(row.speed_mps),
          heading: row.heading === null ? undefined : Number(row.heading),
          satellites: row.satellites === null ? undefined : Number(row.satellites),
          hdop: row.hdop === null ? undefined : Number(row.hdop),
        },
        defaultHardwareDirectionConfig,
      );
      state = evaluation.state;
      const ida = variants.find(variant => variant.direction === "ida");
      const vuelta = variants.find(variant => variant.direction === "vuelta");
      console.log(JSON.stringify({
        timestamp: new Date(row.recorded_at).toISOString(),
        deviceId: row.device_id,
        provider: row.source,
        latitude: row.latitude,
        longitude: row.longitude,
        assignedRouteVariantId: row.assigned_route_variant_id,
        assignedDirection: row.assigned_direction,
        candidateRouteVariantId: state.candidateRouteVariantId ?? null,
        detectedRouteVariantId: state.detectedRouteVariantId ?? null,
        idaProgressMeters: ida ? evaluation.metrics[ida.id]?.progressMeters ?? null : null,
        vueltaProgressMeters: vuelta ? evaluation.metrics[vuelta.id]?.progressMeters ?? null : null,
        confidence: state.detectionConfidence,
        reason: evaluation.reason,
        switched: evaluation.switched,
      }));
    }
    console.error(JSON.stringify({
      event: "replay_complete",
      deviceId: options.deviceId,
      records: rows.length,
      readOnly: true,
      geometryBasis: "current_route_variants",
    }));
  } finally {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 1;
});
