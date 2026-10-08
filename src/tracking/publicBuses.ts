import { query } from "../db";
import type { LiveBus } from "../modules/locations/locations.types";
export async function publicBuses<T extends LiveBus>(buses:T[]) {
  const routes=(await query(`SELECT id FROM routes r WHERE r.active AND r.visible_in_app
    AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=r.transport_line_id AND l.active))`)).rows;
  const visible=new Set(routes.map(r=>r.id));
  const publicLocations=buses.filter(b=>visible.has(b.routeId));
  const vehicles=publicLocations.length ? (await query(
    "SELECT tracking_id,economic_number FROM fleet_vehicles WHERE tracking_id=ANY($1::text[]) AND archived_at IS NULL",
    [publicLocations.map(bus=>bus.busId)],
  )).rows : [];
  const numbers=new Map(vehicles.map(vehicle=>[vehicle.tracking_id,vehicle.economic_number]));
  return publicLocations.map(({sourceId:_sourceId,...bus})=>({...bus,economicNumber:numbers.get(bus.busId)??null}));
}
