import { query } from "../db";
import type { LiveBus } from "../modules/locations/locations.types";
import { localSimulationAllowed } from "./localSimulation";
export async function publicBuses<T extends LiveBus>(buses:T[]) {
  const routes=(await query(`SELECT id FROM routes r WHERE r.active AND r.visible_in_app
    AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=r.transport_line_id AND l.active))`)).rows;
  const visible=new Set(routes.map(r=>r.id));
  const candidates=buses.filter(b=>visible.has(b.routeId));
  if(!candidates.length)return [];
  const active=(await query(`SELECT s.id,s.bus_id,s.route_id,s.started_at,
    COALESCE(c.correo,s.driver_id::text) AS source_id,v.economic_number
    FROM driver_sessions s LEFT JOIN conductores c ON c.id=s.conductor_id
    LEFT JOIN fleet_vehicles v ON v.id=s.vehicle_id
    WHERE s.status='active' AND s.bus_id=ANY($1::text[])
    AND (s.vehicle_id IS NULL OR (v.archived_at IS NULL AND v.operational_status='available'))`,[candidates.map(b=>b.busId)])).rows;
  const sessions=new Map(active.map(s=>[s.id,s]));
  const localSimulation=localSimulationAllowed(process.env,'127.0.0.1',process.env.LOCATION_DEBUG_TOKEN);
  return candidates.flatMap(({sourceId,...bus})=>{
    const session=bus.sessionId ? sessions.get(bus.sessionId) : undefined;
    if(session && session.bus_id===bus.busId && session.route_id===bus.routeId && session.source_id===sourceId && bus.timestamp>=new Date(session.started_at).getTime()) {
      const {sessionId: _sessionId,...publicBus}=bus;
      return [{...publicBus,economicNumber:session.economic_number??null}];
    }
    // Isolated dev-local simulation is deliberately outside real driver sessions.
    if(localSimulation && /^SIM-[a-f0-9]{8}-[0-9]{3}$/.test(bus.busId) && sourceId===bus.busId) {
      const {sessionId: _sessionId,...publicBus}=bus;
      return [{...publicBus,economicNumber:null}];
    }
    return [];
  });
}
