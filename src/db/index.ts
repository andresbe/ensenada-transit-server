import { currentLine } from "../tenancy/context";
import { applyLineContext } from "../tenancy/database";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const { databaseOptions }: { databaseOptions: () => import("pg").PoolConfig } = require("../../scripts/database-options");

const pool = new Pool({
  ...databaseOptions(),
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 15_000,
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
  const context = currentLine();
  let result: QueryResult<T>;
  if (context) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyLineContext(client, context);
      result = await client.query<T>(text, params);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } else { result = await pool.query<T>(text, params); }
  const duration = Date.now() - start;

  if (process.env.NODE_ENV !== "production") {
    console.log(`[pg] query executed in ${duration}ms – rows: ${result.rowCount}`);
  }

  return result;
};

export const getClient = async (): Promise<PoolClient> => {
  const client = await pool.connect();
  const context = currentLine();
  if (!context) return client;
  const execute = client.query.bind(client);
  // Existing services control transactions. Set RLS context immediately after BEGIN.
  let transactionOpen = false;
  const scopedQuery = async (sql: string, params?: unknown[]) => {
    const beginning = /^\s*BEGIN\s*;?\s*$/i.test(sql);
    if (!transactionOpen && !beginning) throw new Error("Line-scoped clients require BEGIN before querying.");
    const result = await execute(sql, params);
    if (beginning) {
      transactionOpen = true;
      await applyLineContext({query:execute} as PoolClient, context);
    }
    if (/^\s*(COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) transactionOpen = false;
    return result;
  };
  return new Proxy(client, {
    get(target, key) {
      if (key === "query") return scopedQuery;
      if (key === "release") return () => client.release(transactionOpen ? new Error("Unfinished line transaction") : undefined);
      const value = Reflect.get(target,key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

export default pool;
