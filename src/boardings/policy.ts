import { AppError } from "../shared/errors";
import type { LocationUpdateRequest, LiveBusLocation } from "../modules/locations/locations.types";

export function distance(a: {latitude:number;longitude:number}, b: {latitude:number;longitude:number}) {
  const rad=Math.PI/180, dlat=(b.latitude-a.latitude)*rad, dlng=(b.longitude-a.longitude)*rad;
  const v=Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlng/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));
}

export function validateBoardingEvidence(p:LocationUpdateRequest,b:LiveBusLocation|null,now=Date.now()) {
  if(!Number.isFinite(p.timestamp)||now-p.timestamp>30000||p.timestamp>now+5000) throw new AppError("Obtén una ubicación GPS reciente para confirmar el abordaje.",422);
  if(!Number.isFinite(p.accuracy)||p.accuracy!<=0||p.accuracy!>50) throw new AppError("Necesitamos una ubicación precisa (50 metros o menos).",422);
  if(!b||b.sourceType!=="driver"||b.busId!==p.busId||!Number.isFinite(b.updatedAt)||now-b.updatedAt>45000||!Number.isFinite(b.timestamp)||now-b.timestamp>45000||b.timestamp>now+5000)
    throw new AppError("El autobús no tiene señal reciente del conductor.",409);
  if(b.routeId!==p.routeId||b.routeVariantId!==p.routeVariantId||b.routeVariantDirection!==p.routeVariantDirection) throw new AppError("El autobús no está recorriendo la ruta seleccionada.",409);
  if(!Number.isFinite(b.latitude)||!Number.isFinite(b.longitude)||!Number.isFinite(b.accuracy)||b.accuracy!<=0||b.accuracy!>50) throw new AppError("La ubicación del autobús no es suficientemente precisa.",409);
  if(distance(p,b)>100) throw new AppError("Debes estar cerca del autobús para confirmar que lo abordaste.",403);
}
