import { getClient, query } from "../db";
import { driverIdentity } from "./driverSessions.service";
import { checkpointStatus, qualifiesForCheckin } from "./checkpointRules";
import { findNearestPointOnPolyline, haversineDistanceMeters } from "../shared/geo/geometry";
import type { LocationUpdateRequest } from "../modules/locations/locations.types";

type Database = {query:typeof query};
const geometry = (coordinates:[number,number][]) => coordinates.map(([longitude,latitude])=>({latitude,longitude}));

export async function beginCheckpointRun(db:Database,sessionId:string,routeId:string,variantId:string,startedAt:Date|string) {
  const variant=(await db.query("SELECT v.direction,v.coordinates,r.checkpoint_revision FROM route_variants v JOIN routes r ON r.id=v.route_id WHERE v.id=$1 AND v.route_id=$2",[variantId,routeId])).rows[0];
  if(!variant) return;
  const run=(await db.query("INSERT INTO driver_checkpoint_runs(session_id,variant_id,direction,started_at,plan_revision) VALUES($1,$2,$3,$4,$5) RETURNING id",[sessionId,variantId,variant.direction,startedAt,variant.checkpoint_revision])).rows[0];
  const points=(await db.query("SELECT c.*,COALESCE(c.name,s.name) AS name,s.latitude::float8,s.longitude::float8,s.sequence FROM route_checkpoints c JOIN stops s ON s.id=c.stop_id WHERE c.variant_id=$1 ORDER BY s.sequence,s.id",[variantId])).rows;
  const path=geometry(variant.coordinates);
  for(const [sequence,p] of points.entries()) {
    const progress=path.length ? findNearestPointOnPolyline(p as {latitude:number;longitude:number},path).progressMeters : 0;
    await db.query(`INSERT INTO driver_checkins(run_id,session_id,checkpoint_id,sequence,name,latitude,longitude,progress_meters,radius_meters,tolerance_minutes,expected_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz+make_interval(mins=>$12))`,[run.id,sessionId,p.id,sequence,p.name,p.latitude,p.longitude,progress,p.radius_meters,p.tolerance_minutes,startedAt,p.target_minutes]);
  }
}

// Only authenticated driver telemetry reaches this function, never passenger observations.
export async function registerGpsCheckin(subject:string,payload:LocationUpdateRequest) {
  if(payload.sourceType!=="driver" || !Number.isFinite(payload.accuracy) || payload.accuracy!>50 || payload.accuracy!<0 || Date.now()-payload.timestamp>120000 || payload.timestamp>Date.now()+10000) return;
  const db=await getClient();
  try {
    await db.query("BEGIN");
    const identity=await driverIdentity(db,subject);
    const session=(await db.query("SELECT * FROM driver_sessions WHERE status='active' AND bus_id=$1 AND route_id=$2 AND (conductor_id=$3 OR driver_id=$4) FOR UPDATE",[payload.busId,payload.routeId,identity.conductorId,identity.userId])).rows[0];
    if(!session || payload.timestamp<new Date(session.started_at).getTime() || (session.last_checkpoint_gps_at && payload.timestamp<=new Date(session.last_checkpoint_gps_at).getTime())) {await db.query("COMMIT");return;}
    // Lock the route against concurrent checkpoint/geometry edits while taking a snapshot.
    await db.query("SELECT id FROM routes WHERE id=$1 FOR SHARE",[session.route_id]);
    let run=(await db.query("SELECT * FROM driver_checkpoint_runs WHERE session_id=$1 AND ended_at IS NULL",[session.id])).rows[0];
    if(!run) {
      await beginCheckpointRun(db,session.id,session.route_id,session.variant_id,session.started_at);
      run=(await db.query("SELECT * FROM driver_checkpoint_runs WHERE session_id=$1 AND ended_at IS NULL",[session.id])).rows[0];
    }
    if(run && run.variant_id!==payload.routeVariantId) {
      const variants=(await db.query("SELECT id,coordinates,direction FROM route_variants WHERE route_id=$1 AND id=ANY($2::uuid[])",[session.route_id,[run.variant_id,payload.routeVariantId]])).rows;
      const old=variants.find(v=>v.id===run.variant_id),next=variants.find(v=>v.id===payload.routeVariantId);
      const oldEnd=old?.coordinates?.at(-1),newStart=next?.coordinates?.[0];
      // A changed direction flag alone cannot reset the clock; GPS must be at the terminal.
      if(payload.timestamp-new Date(run.started_at).getTime()>=60000 && oldEnd && newStart && old?.direction!==next?.direction && next?.direction===payload.routeVariantDirection && haversineDistanceMeters(payload,{longitude:oldEnd[0],latitude:oldEnd[1]})<=150 && haversineDistanceMeters(payload,{longitude:newStart[0],latitude:newStart[1]})<=150) {
        await db.query("UPDATE driver_checkpoint_runs SET ended_at=$2 WHERE id=$1",[run.id,new Date(payload.timestamp)]);
        await beginCheckpointRun(db,session.id,session.route_id,payload.routeVariantId,new Date(payload.timestamp));
        run=(await db.query("SELECT * FROM driver_checkpoint_runs WHERE session_id=$1 AND ended_at IS NULL",[session.id])).rows[0];
      }
    }
    if(run && run.variant_id===payload.routeVariantId) {
      // Process only the next point: being near a later stop cannot skip prior controls.
      const point=(await db.query("SELECT * FROM driver_checkins WHERE run_id=$1 AND arrived_at IS NULL ORDER BY sequence LIMIT 1",[run.id])).rows[0];
      if(point && qualifiesForCheckin(payload,point as {latitude:number;longitude:number;radius_meters:number},new Date(run.started_at).getTime())) {
        await db.query("UPDATE driver_checkins SET arrived_at=$2,received_at=now(),gps_accuracy=$3 WHERE id=$1 AND arrived_at IS NULL",[point.id,new Date(payload.timestamp),payload.accuracy]);
      }
    }
    if (run && run.variant_id===payload.routeVariantId && payload.timestamp-new Date(run.started_at).getTime()>=60000 && (payload.speed??0)>=1 && Number.isFinite(payload.heading)) {
      const counts=(await db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE arrived_at IS NULL)::int AS pending FROM driver_checkins WHERE run_id=$1",[run.id])).rows[0];
      if(counts.total>0 && counts.pending===0) {
        const variants=(await db.query("SELECT id,direction,coordinates FROM route_variants WHERE route_id=$1",[session.route_id])).rows;
        const old=variants.find(v=>v.id===run.variant_id),next=variants.find(v=>v.id!==run.variant_id);
        const end=old?.coordinates?.at(-1),path=next ? geometry(next.coordinates) : [];
        if(end&&path.length>1&&haversineDistanceMeters(payload,{longitude:end[0],latitude:end[1]})<=150&&haversineDistanceMeters(payload,path[0])<=150) {
          const snap=findNearestPointOnPolyline(payload,path),a=path[snap.segmentIndex],b=path[snap.segmentIndex+1];
          const bearing=b ? (Math.atan2((b.longitude-a.longitude)*Math.cos(a.latitude*Math.PI/180),b.latitude-a.latitude)*180/Math.PI+360)%360 : 0;
          const turn=Math.abs(((payload.heading!-bearing+540)%360)-180);
          if(snap.distanceFromRouteMeters<=50&&snap.progressMeters>=10&&snap.progressMeters<=150&&turn<=45) {
            await db.query("UPDATE driver_checkpoint_runs SET ended_at=$2 WHERE id=$1",[run.id,new Date(payload.timestamp)]);
            await beginCheckpointRun(db,session.id,session.route_id,next!.id,new Date(payload.timestamp));
            run=(await db.query("SELECT * FROM driver_checkpoint_runs WHERE session_id=$1 AND ended_at IS NULL",[session.id])).rows[0];
          }
        }
      }
    }
    await db.query("UPDATE driver_sessions SET last_checkpoint_gps_at=$2 WHERE id=$1",[session.id,new Date(payload.timestamp)]);
    await db.query("COMMIT");
    return run ? {routeVariantId:run.variant_id as string,routeVariantDirection:run.direction as "ida"|"vuelta"} : undefined;
  } catch(error) {await db.query("ROLLBACK");throw error;} finally {db.release();}
}

type CheckinRow = { id:string; run_id:string; name:string; latitude:number; longitude:number; radius_meters:number; progress_meters:number; variant_id:string; expected_at:Date; arrived_at:Date|null; run_ended_at:Date|null; tolerance_minutes:number; session_status:string };

export async function sessionCheckins(db:Database,sessionId:string) {
  const rows=(await db.query<CheckinRow>(`SELECT c.*,r.variant_id,r.direction,r.started_at AS run_started_at,r.ended_at AS run_ended_at,s.status AS session_status
    FROM driver_checkins c JOIN driver_checkpoint_runs r ON r.id=c.run_id JOIN driver_sessions s ON s.id=c.session_id WHERE c.session_id=$1 ORDER BY r.started_at,c.sequence`,[sessionId])).rows;
  const now=Date.now();
  return rows.map(p=>({...p,status:checkpointStatus(p.expected_at,p.arrived_at,p.tolerance_minutes,!!p.run_ended_at||p.session_status!=="active",now),deviation_seconds:p.arrived_at ? Math.round((new Date(p.arrived_at).getTime()-new Date(p.expected_at).getTime())/1000) : null}));
}
