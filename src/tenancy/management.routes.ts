import bcrypt from "bcrypt";
import { validateEmail, validatePassword } from "../auth/validators";
import { Router } from "express";
import { query,getClient } from "../db";
import { authMiddleware } from "../auth/auth.middleware";
import { getActiveAdmin } from "../auth/admin.service";
import { asyncHandler } from "../middleware/errorHandler";
import { apiRateLimiter } from "../middleware/rateLimiter";
import { AppError } from "../shared/errors";
import { record,text,uuid,choice } from "../passengers/validation";
import { lineAccess,requireSuperadmin } from "./access";

export const lineManagementRouter=Router();
lineManagementRouter.use(authMiddleware,apiRateLimiter);
lineManagementRouter.get("/",asyncHandler(async(req,res)=>{
  const admin=await getActiveAdmin(req.user!);
  const rows=await query(`SELECT l.*,CASE WHEN $2 THEN 'admin' ELSE m.role END AS role
    FROM transport_lines l LEFT JOIN admin_line_memberships m ON m.line_id=l.id AND m.admin_id=$1 AND m.active
    WHERE ($2 OR (m.admin_id IS NOT NULL AND l.active)) ORDER BY l.name`,[admin.id,admin.is_superadmin]);
  res.json({lines:rows.rows,is_superadmin:admin.is_superadmin});
}));
lineManagementRouter.post("/",requireSuperadmin,asyncHandler(async(req,res)=>{
  const body=record(req.body),color=text(body.color,"color",7);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new AppError("Color inválido.",400);
  const client=await getClient();
  try {
    await client.query("BEGIN");
    const line=(await client.query("INSERT INTO transport_lines(name,short_code,color) VALUES($1,$2,$3) RETURNING *",[text(body.name,"Nombre",100),(body.short_code === undefined ? "" : text(body.short_code,"Código",12).toUpperCase()),color])).rows[0];
    await client.query("INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id) VALUES($1::uuid,$2,'CREATE','line',($1::uuid)::text)",[line.id,req.user!.sub]);
    await client.query("COMMIT");res.status(201).json({line});
  } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
}));
lineManagementRouter.put("/:lineId",requireSuperadmin,asyncHandler(async(req,res)=>{
  const body=record(req.body),id=uuid(req.params.lineId),color=text(body.color,"color",7);
  if (!/^#[0-9a-f]{6}$/i.test(color)||typeof body.active!=="boolean"||!Number.isInteger(body.revision)) throw new AppError("Datos de línea inválidos.",400);
  const result=await query(`WITH changed AS (UPDATE transport_lines SET name=$2,short_code=COALESCE($3,short_code),color=$4,active=$5,revision=revision+1
    WHERE id=$1 AND revision=$6 RETURNING *), audit AS (
    INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id) SELECT id,$7,'UPDATE','line',id::text FROM changed)
    SELECT * FROM changed`,[id,text(body.name,"Nombre",100),(body.short_code === undefined ? null : text(body.short_code,"Código",12).toUpperCase()),color,body.active,body.revision,req.user!.sub]);
  if (!result.rows.length) throw new AppError("La línea cambió. Actualiza la lista.",409);
  res.json({line:result.rows[0]});
}));
lineManagementRouter.get("/:lineId/members",asyncHandler(async(req,res)=>{
  await getActiveAdmin(req.user!);const id=uuid(req.params.lineId);await lineAccess(req.user!.sub,id,false,true);
  const rows=await query(`SELECT m.admin_id,m.role,m.active,a.email,a.display_name FROM admin_line_memberships m
    JOIN admins a ON a.id=m.admin_id WHERE m.line_id=$1 ORDER BY a.email`,[id]);
  res.json({members:rows.rows});
}));
lineManagementRouter.put("/:lineId/members",asyncHandler(async(req,res)=>{
  const actor=await getActiveAdmin(req.user!);const id=uuid(req.params.lineId);await lineAccess(req.user!.sub,id,true,true);
  const b=record(req.body),role=choice(b.role,["admin","operator","viewer"] as const,"Rol");
  if (typeof b.active!=="boolean") throw new AppError("Estado inválido.",400);
  const email=validateEmail(b.email);
  const newAccount=b.new_account === undefined ? null : record(b.new_account);
  let accountName="", passwordHash="";
  if (newAccount) {
    if (!actor.is_superadmin) throw new AppError("Solo el superadministrador puede crear cuentas administrativas.",403);
    accountName=text(newAccount.name,"Nombre",100);
    const password=validatePassword(newAccount.password);
    if (Buffer.byteLength(password,"utf8")>72) throw new AppError("La contraseña excede 72 bytes.",400);
    passwordHash=await bcrypt.hash(password,12);
  }
  const client=await getClient();
  try {
    await client.query("BEGIN");
    // Serialize membership edits and recheck access after obtaining the lock.
    const currentLine=await client.query("SELECT id FROM transport_lines WHERE id=$1 AND active FOR UPDATE",[id]);
    if (!currentLine.rows.length) throw new AppError("La línea ya no está activa. Actualiza la lista.",409);
    const allowed=await client.query(`SELECT a.id,a.is_superadmin FROM admins a LEFT JOIN admin_line_memberships m ON m.admin_id=a.id AND m.line_id=$2
      WHERE a.id=$1 AND a.status='active' AND a.token_version=$3 AND (a.is_superadmin OR (m.active AND m.role='admin')) FOR SHARE OF a`,[req.user!.sub,id,req.user!.tokenVersion]);
    if (!allowed.rows.length) throw new AppError("Permiso revocado.",403);
    let target;
    if (newAccount) {
      if (!allowed.rows[0].is_superadmin) throw new AppError("Permiso de superadministrador revocado.",403);
      target=(await client.query("INSERT INTO admins(email,password_hash,display_name) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING id",[email,passwordHash,accountName])).rows[0];
      if (!target) throw new AppError("Este correo ya tiene una cuenta administrativa. Selecciona Cuenta existente para asignarle acceso.",409);
    } else {
      target=(await client.query("SELECT id FROM admins WHERE email=$1 AND status='active' FOR SHARE",[email])).rows[0];
    }
    if (!target) throw new AppError("La cuenta administrativa no existe o está desactivada. Primero debe registrarla el superadministrador.",400);
    if (target.id===req.user!.sub && (!b.active||role!=="admin")) throw new AppError("Solicita a otro administrador que cambie tu propio acceso.",400);
    await client.query(`INSERT INTO admin_line_memberships(admin_id,line_id,role,active) VALUES($1,$2,$3,$4)
      ON CONFLICT(admin_id,line_id) DO UPDATE SET role=EXCLUDED.role,active=EXCLUDED.active`,[target.id,id,role,b.active]);
    await client.query("INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'MEMBERSHIP','admin',$3)",[id,req.user!.sub,target.id]);
    await client.query("COMMIT");res.json({saved:true});
  } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
}));
