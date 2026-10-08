import { getClient } from "../db";
import redis from "../redis/client";
import { busLocationKey } from "../redis/cache";
import { AppError } from "../shared/errors";
import type { LocationUpdateRequest, LiveBusLocation } from "../modules/locations/locations.types";
import { distance, validateBoardingEvidence } from "./policy";

export async function recordBoarding(userId:string,p:LocationUpdateRequest,boardingId?:unknown) {
  if(boardingId!==undefined && (typeof boardingId!=="string" || !/^[\da-f-]{36}$/i.test(boardingId))) throw new AppError("Abordaje inválido.",400);
  const db=await getClient();
  try {
    await db.query("BEGIN");
    // Serialize per passenger across processes; never trust the supplied sourceId.
    const user=await db.query("SELECT id,is_tester FROM users WHERE id=$1 AND status='active' FOR UPDATE",[userId]);
    if(!user.rows.length) throw new AppError("La sesión no es válida.",401);
    if(user.rows[0].is_tester) {
      // Test sessions never contribute to real occupancy or authoritative bus GPS.
      let receipt;
      if(boardingId) {
        receipt=(await db.query("UPDATE passenger_boardings SET last_lat=$3,last_lng=$4,last_timestamp=$5,expires_at=now()+interval '12 hours' WHERE id=$1 AND user_id=$2 AND is_test AND status IN ('pending','verified') RETURNING id,status,expires_at,is_test",[boardingId,userId,p.latitude,p.longitude,p.timestamp])).rows[0];
        if(!receipt) throw new AppError("El abordaje terminó. Confirma nuevamente.",409);
      } else {
        await db.query("UPDATE passenger_boardings SET status='ended',ended_at=now(),expires_at=now() WHERE user_id=$1 AND status IN ('pending','verified')",[userId]);
        receipt=(await db.query(`INSERT INTO passenger_boardings(user_id,route_id,is_test,test_bus_id,status,first_lat,first_lng,first_bus_lat,first_bus_lng,last_lat,last_lng,last_timestamp,expires_at)
          VALUES($1,$2,true,$3,'verified',$4,$5,$4,$5,$4,$5,$6,now()+interval '12 hours') RETURNING id,status,expires_at,is_test`,[userId,p.routeId,p.busId,p.latitude,p.longitude,p.timestamp])).rows[0];
      }
      await db.query("COMMIT");return receipt;
    }
    // A revoked tester cannot continue renewing a test session as a real passenger.
    if(boardingId && (await db.query("SELECT id FROM passenger_boardings WHERE id=$1 AND user_id=$2 AND is_test",[boardingId,userId])).rows.length) throw new AppError("El modo tester fue desactivado. Inicia un nuevo abordaje.",403);
    if(!redis.isReady) throw new AppError("No se puede verificar el autobús en este momento.",503);
    const raw=await redis.get(busLocationKey(p.busId));
    const bus:LiveBusLocation|null=raw?JSON.parse(raw):null;
    validateBoardingEvidence(p,bus);
    const vehicle=(await db.query(
      `SELECT v.id,s.id AS session_id,c.correo,s.started_at FROM fleet_vehicles v
       JOIN driver_sessions s ON s.vehicle_id=v.id AND s.conductor_id=v.assigned_driver_id AND s.status='active' AND s.route_id=$2
       JOIN conductores c ON c.id=v.assigned_driver_id
       WHERE v.tracking_id=$1 AND v.archived_at IS NULL AND v.operational_status='available'`,[p.busId,p.routeId])).rows[0];
    if(!vehicle||bus!.sourceId!==vehicle.correo||bus!.timestamp<new Date(vehicle.started_at).getTime()) throw new AppError("El camión no tiene un servicio verificado activo.",409);
    validateBoardingEvidence(p,bus);
    await db.query("UPDATE passenger_boardings SET status='expired',ended_at=now() WHERE user_id=$1 AND status IN ('pending','verified') AND (expires_at<=now() OR created_at<now()-interval '12 hours')",[userId]);
    const previous=(await db.query("SELECT * FROM passenger_boardings WHERE user_id=$1 AND status IN ('pending','verified') FOR UPDATE",[userId])).rows[0];
    if(boardingId && previous?.id!==boardingId) throw new AppError("El abordaje terminó o expiró. Confirma nuevamente.",409);
    let row;
    if(previous) {
      if(previous.vehicle_id!==vehicle.id||previous.driver_session_id!==vehicle.session_id) throw new AppError("Finaliza tu abordaje actual antes de elegir otro autobús.",409);
      if(p.timestamp<=Number(previous.last_timestamp)) throw new AppError("Esta ubicación ya fue utilizada.",409);
      if(Date.now()-new Date(previous.last_received_at).getTime()<5000) throw new AppError("Espera antes de enviar otra ubicación.",429);
      const dt=(p.timestamp-Number(previous.last_timestamp))/1000;
      if(distance({latitude:previous.last_lat,longitude:previous.last_lng},p)>dt*40+50) throw new AppError("El cambio de ubicación no es coherente con el viaje.",422);
      const passengerTravel=distance({latitude:previous.first_lat,longitude:previous.first_lng},p);
      const busTravel=distance({latitude:previous.first_bus_lat,longitude:previous.first_bus_lng},bus!);
      const together=Date.now()-new Date(previous.created_at).getTime()>=20000 && passengerTravel>=30 && busTravel>=30 && Math.abs(passengerTravel-busTravel)<=60;
      row=(await db.query(`UPDATE passenger_boardings SET status=$2,last_lat=$3,last_lng=$4,last_timestamp=$5,last_received_at=now(),expires_at=now()+interval '2 minutes'
        WHERE id=$1 RETURNING id,status,expires_at`,[previous.id,previous.status==='verified'||together?'verified':'pending',p.latitude,p.longitude,p.timestamp])).rows[0];
    } else {
      const recent=(await db.query("SELECT count(*)::int AS count FROM passenger_boardings WHERE user_id=$1 AND created_at>now()-interval '1 hour'",[userId])).rows[0];
      if(recent.count>=6) throw new AppError("Has realizado demasiados intentos de abordaje. Intenta más tarde.",429);
      row=(await db.query(`INSERT INTO passenger_boardings(user_id,vehicle_id,driver_session_id,route_id,first_lat,first_lng,first_bus_lat,first_bus_lng,last_lat,last_lng,last_timestamp)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$5,$6,$9) RETURNING id,status,expires_at`,[userId,vehicle.id,vehicle.session_id,p.routeId,p.latitude,p.longitude,bus!.latitude,bus!.longitude,p.timestamp])).rows[0];
    }
    await db.query("COMMIT");return row;
  }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}

export async function endBoarding(userId:string,id:string) {
  if(!/^[\da-f-]{36}$/i.test(id)) throw new AppError("Abordaje inválido.",400);
  const db=await getClient();
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[userId]);
    await db.query("UPDATE passenger_boardings SET status='ended',ended_at=now(),expires_at=now() WHERE user_id=$1 AND id=$2 AND status IN ('pending','verified')",[userId,id]);
    await db.query("COMMIT");
  }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}
