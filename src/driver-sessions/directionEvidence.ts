import { findNearestPointOnPolyline, haversineDistanceMeters } from "../shared/geo/geometry";

type Point = {latitude:number; longitude:number};
type Variant = {id:string; coordinates:[number,number][]};
export type DirectionEvidence = {
  runId?:string; lastAt?:number; latitude?:number; longitude?:number;
  progress?:number; candidate?:string; candidateAt?:number; candidateProgress?:number;
  count?:number;
};
const path = (v:Variant) => v.coordinates.map(([longitude,latitude])=>({latitude,longitude}));
const difference = (a:number,b:number) => Math.abs(((a-b+540)%360)-180);
function bearing(a:Point,b:Point) {
  return (Math.atan2((b.longitude-a.longitude)*Math.cos(a.latitude*Math.PI/180),b.latitude-a.latitude)*180/Math.PI+360)%360;
}
/** A driver chooses the initial leg. Only sequential, plausible GPS evidence can change it. */
export function directionEvidence(previous:DirectionEvidence, runId:string, startedAt:number,
  current:Variant, next:Variant|undefined, gps:Point & {timestamp:number;accuracy?:number;speed?:number;heading?:number}) {
  const oldPath=path(current), nextPath=next ? path(next) : [];
  if(oldPath.length<2) return {state:previous,switchTo:undefined};
  const oldSnap=findNearestPointOnPolyline(gps,oldPath);
  const prior=previous.runId===runId ? previous : {};
  const state:DirectionEvidence={runId,lastAt:gps.timestamp,latitude:gps.latitude,longitude:gps.longitude,progress:oldSnap.progressMeters};
  if(!next || nextPath.length<2 || !prior.lastAt || gps.timestamp<=prior.lastAt ||
    gps.timestamp-startedAt<60000 || gps.accuracy===undefined || gps.accuracy>50 ||
    gps.heading===undefined || (gps.speed??0)<1) return {state,switchTo:undefined};
  const elapsed=(gps.timestamp-prior.lastAt)/1000;
  if(prior.latitude!==undefined && prior.longitude!==undefined &&
    haversineDistanceMeters(gps,{latitude:prior.latitude,longitude:prior.longitude})/elapsed>40) return {state,switchTo:undefined};
  const snap=findNearestPointOnPolyline(gps,nextPath);
  const a=nextPath[snap.segmentIndex],b=nextPath[snap.segmentIndex+1];
  const oldA=oldPath[oldSnap.segmentIndex],oldB=oldPath[oldSnap.segmentIndex+1];
  const nextAligned=!!b && difference(gps.heading,bearing(a,b))<=45;
  const oldAligned=!!oldB && difference(gps.heading,bearing(oldA,oldB))<=60;
  const nearTerminal=haversineDistanceMeters(gps,oldPath[oldPath.length-1])<=180;
  // After a gap allow recovery beyond the terminal only when the old leg is inconsistent.
  // Shared streets with the same bearing remain ambiguous and preserve the confirmed leg.
  const distinguishable=oldSnap.distanceFromRouteMeters>snap.distanceFromRouteMeters+25 || !oldAligned;
  const candidate=nextAligned && snap.distanceFromRouteMeters<=50 && snap.progressMeters>=10 &&
    (nearTerminal || distinguishable);
  if(!candidate) return {state,switchTo:undefined};
  const continuing=prior.candidate===next.id && gps.timestamp-(prior.candidateAt??0)<=180000 &&
    snap.progressMeters>(prior.candidateProgress??Infinity)+5;
  state.candidate=next.id;
  state.candidateAt=continuing ? prior.candidateAt : gps.timestamp;
  state.candidateProgress=snap.progressMeters;
  state.count=continuing ? (prior.count??0)+1 : 1;
  return {state,switchTo:(state.count>=3 && gps.timestamp-(state.candidateAt??gps.timestamp)>=10000) ? next.id : undefined};
}
