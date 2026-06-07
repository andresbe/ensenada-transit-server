import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[pg] Unexpected pool error:", err);
});

pool.on("connect", () => {
  console.log("[pg] New client connected to PostgreSQL");
});

export const query = async <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> => {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  if (process.env.NODE_ENV !== "production") {
    console.log(`[pg] query executed in ${duration}ms – rows: ${result.rowCount}`);
  }

  return result;
};

export const getClient = (): Promise<PoolClient> => pool.connect();

export default pool;
