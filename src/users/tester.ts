import { query } from "../db";

export async function isTesterAccount(id: string): Promise<boolean> {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return false;
  const result = await query("SELECT is_tester FROM users WHERE id=$1 AND status='active'", [id]);
  return result.rows[0]?.is_tester === true;
}
