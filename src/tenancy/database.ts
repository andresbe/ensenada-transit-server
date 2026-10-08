import type { PoolClient } from "pg";
import type { LineContext } from "./context";

export async function applyLineContext(client: PoolClient, context: LineContext) {
  // Transaction-local role and settings never survive a pooled connection reuse.
  await client.query("SET LOCAL ROLE et_line_runtime");
  await client.query("SELECT set_config('app.line_id',$1,true),set_config('app.admin_id',$2,true),set_config('app.token_version',$3,true)",
    [context.lineId,context.adminId,String(context.tokenVersion)]);
}
