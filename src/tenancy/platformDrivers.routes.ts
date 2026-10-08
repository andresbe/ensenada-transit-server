import { Router } from "express";
import bcrypt from "bcrypt";
import { query,getClient } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { AppError } from "../shared/errors";
import { record,text,uuid } from "../passengers/validation";
import { validateEmail,validatePassword } from "../auth/validators";

// Only mounted below the platform's requireSuperadmin middleware.
export const platformDriversRouter=Router();
platformDriversRouter.get("/drivers",asyncHandler(async(req,res)=>{
  const page=Number(req.query.page??1),limit=Number(req.query.limit??25),status=String(req.query.status??"all");
  if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(limit)||limit<1||limit>100||!["all","active","suspended"].includes(status))throw new AppError("Filtros inválidos.",400);
  const from=`FROM conductores c LEFT JOIN fleet_vehicles v ON v.assigned_driver_id=c.id AND v.archived_at IS NULL
    WHERE (c.nombre_usuario ILIKE $1 OR c.correo ILIKE $1)
    AND ($2='all' OR ($2='active')=EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=c.id AND m.active))`;
  const params=["%"+String(req.query.q??"").trim().slice(0,100)+"%",status];
  const [rows,count]=await Promise.all([
    query(`SELECT c.id,c.correo,c.nombre_usuario,c.revision,v.economic_number,v.id AS vehicle_id,
      EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=c.id AND m.active) AS active,
      NOT EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=c.id) AS unassigned
      ${from} ORDER BY c.nombre_usuario,c.id LIMIT $3 OFFSET $4`,[...params,limit,(page-1)*limit]),
    query(`SELECT count(*)::int AS total ${from}`,params),
  ]);
  res.json({drivers:rows.rows,total:count.rows[0].total,page,limit});
}));
platformDriversRouter.post("/drivers",asyncHandler(async(req,res)=>{
  const b=record(req.body),email=validateEmail(b.email),password=validatePassword(b.password),name=text(b.name,"Nombre",100);
  if(Buffer.byteLength(password,"utf8")>72)throw new AppError("La contraseña excede 72 bytes.",400);
  const hash=await bcrypt.hash(password,12),line=b.transport_line_id?uuid(b.transport_line_id):null,db=await getClient();
  try{
    await db.query("BEGIN");
    if(line && !(await db.query("SELECT id FROM transport_lines WHERE id=$1 AND active FOR SHARE",[line])).rows.length)throw new AppError("Línea no disponible.",400);
    const driver=(await db.query("INSERT INTO conductores(correo,password,nombre_usuario) VALUES($1,$2,$3) RETURNING id,correo,nombre_usuario",[email,hash,name])).rows[0];
    if(line)await db.query("INSERT INTO driver_line_memberships(conductor_id,line_id) VALUES($1,$2)",[driver.id,line]);
    await db.query("INSERT INTO line_audit_log(line_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'CREATE','driver',$3)",[line,req.user!.sub,driver.id]);
    await db.query("COMMIT");res.status(201).json({driver});
  }catch(e){await db.query("ROLLBACK");if((e as {code?:string}).code==="23505")throw new AppError("Ya existe un conductor con ese correo.",409);throw e;}finally{db.release();}
}));
platformDriversRouter.put("/drivers/:id",asyncHandler(async(req,res)=>{
  const b=record(req.body),id=uuid(req.params.id),name=text(b.name,"Nombre",100);
  if(!Number.isInteger(b.revision))throw new AppError("Revisión inválida.",400);
  let hash:string|null=null;
  if(b.password!==undefined){const password=validatePassword(b.password);if(Buffer.byteLength(password,"utf8")>72)throw new AppError("La contraseña excede 72 bytes.",400);hash=await bcrypt.hash(password,12);}
  const db=await getClient();
  try{
    await db.query("BEGIN");
    const driver=(await db.query("SELECT revision FROM conductores WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!driver)throw new AppError("Conductor no encontrado.",404);
    if(driver.revision!==b.revision)throw new AppError("El conductor cambió. Actualiza la lista.",409);
    if(hash && (await db.query("SELECT id FROM driver_sessions WHERE conductor_id=$1 AND status='active'",[id])).rows.length)throw new AppError("Finaliza el recorrido antes de cambiar la contraseña.",409);
    await db.query("UPDATE conductores SET nombre_usuario=$2,password=COALESCE($3,password),token_version=token_version+CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END,revision=revision+1 WHERE id=$1",[id,name,hash]);
    await db.query("INSERT INTO line_audit_log(actor_id,action,entity_type,entity_id) VALUES($1,$2,'driver',$3)",[req.user!.sub,hash?"CREDENTIAL_RESET":"UPDATE",id]);
    await db.query("COMMIT");res.json({saved:true});
  }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}));
