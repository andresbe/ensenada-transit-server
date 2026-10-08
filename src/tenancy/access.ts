import type { RequestHandler } from "express";
import { query } from "../db";
import { getActiveAdmin } from "../auth/admin.service";
import { AppError } from "../shared/errors";
import { uuid } from "../passengers/validation";
import { lineContext, type LineRole } from "./context";

export async function lineAccess(adminId: string, lineId: string, write = false, manage = false) {
  const result = await query<{role:LineRole}>(`SELECT CASE WHEN a.is_superadmin THEN 'admin' ELSE m.role END AS role
    FROM admins a CROSS JOIN transport_lines l LEFT JOIN admin_line_memberships m ON m.admin_id=a.id AND m.line_id=l.id AND m.active
    WHERE a.id=$1 AND a.status='active' AND l.id=$2 AND l.active AND (a.is_superadmin OR m.admin_id IS NOT NULL)`,[adminId,lineId]);
  const role=result.rows[0]?.role;
  if (!role || (write && role==='viewer') || (manage && role!=='admin')) throw new AppError("No tienes permiso para esta línea u operación.",403);
  return role;
}
export const requireLine: RequestHandler = (req,_res,next) => {
  (async()=>{
    if (!req.user) throw new AppError("Authentication required.",401);
    await getActiveAdmin(req.user);
    const lineId=uuid(req.params.lineId);
    const role=await lineAccess(req.user.sub,lineId,!['GET','HEAD'].includes(req.method));
    lineContext.run({lineId,adminId:req.user.sub,role,tokenVersion:req.user.tokenVersion!},next);
  })().catch(next);
};
export const requireSuperadmin: RequestHandler = (req,_res,next) => {
  (async()=>{
    if (!req.user) throw new AppError("Authentication required.",401);
    const admin=await getActiveAdmin(req.user);
    if (!admin.is_superadmin) throw new AppError("Esta operación requiere superadministrador.",403);
    next();
  })().catch(next);
};
