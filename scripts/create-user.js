/* eslint-disable no-console */
require("dotenv").config();

const bcrypt = require("bcrypt");
const { Pool } = require("pg");

const SALT_ROUNDS = 12;
const VALID_ROLES = new Set(["admin", "driver", "operator", "user"]);

function requireEnv(name) {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : null;
}

async function main() {
  const role = requireEnv("USER_ROLE");

  if (!VALID_ROLES.has(role)) {
    throw new Error("USER_ROLE must be one of: admin, driver, operator, user.");
  }

  const email = requireEnv("USER_EMAIL").toLowerCase();
  const password = requireEnv("USER_PASSWORD");
  const displayName = optionalEnv("USER_DISPLAY_NAME");
  const assignedBusId = optionalEnv("USER_ASSIGNED_BUS_ID");
  const assignedRouteId = optionalEnv("USER_ASSIGNED_ROUTE_ID");
  const assignedRouteVariantId = optionalEnv("USER_ASSIGNED_ROUTE_VARIANT_ID");
  const pool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (
         email,
         password_hash,
         display_name,
         auth_provider,
         role,
         status,
         assigned_bus_id,
         assigned_route_id,
         assigned_route_variant_id
       )
       VALUES ($1, $2, $3, 'email', $4, 'active', $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         role = EXCLUDED.role,
         status = 'active',
         assigned_bus_id = EXCLUDED.assigned_bus_id,
         assigned_route_id = EXCLUDED.assigned_route_id,
         assigned_route_variant_id = EXCLUDED.assigned_route_variant_id
       RETURNING id, email, display_name, role, status, assigned_bus_id, assigned_route_id, assigned_route_variant_id`,
      [
        email,
        passwordHash,
        displayName,
        role,
        assignedBusId,
        assignedRouteId,
        assignedRouteVariantId,
      ],
    );

    await pool.query("INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
      result.rows[0].id,
    ]);

    console.log(JSON.stringify({ user: result.rows[0] }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
