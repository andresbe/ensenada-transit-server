import { query } from "../db";
import type { LiveBus } from "../modules/locations/locations.types";
import { localSimulationAllowed } from "./localSimulation";
import {
  hardwareDeviceMappingSql,
  hardwareUnavailableReason,
  isHardwareProvider,
} from "./hardwareStore";
export async function publicBuses<T extends LiveBus>(buses:T[]) {
  const routes=(await query(`SELECT id FROM routes r WHERE r.active AND r.visible_in_app
    AND (r.transport_line_id IS NULL OR EXISTS(SELECT 1 FROM transport_lines l WHERE l.id=r.transport_line_id AND l.active))`)).rows;
  const visible=new Set(routes.map(r=>r.id));
  const candidates=buses.filter(b=>visible.has(b.routeId));
  if(!candidates.length)return [];
  const publicTestVehicleIds = new Set((process.env.PUBLIC_TEST_VEHICLE_IDS ?? "")
    .split(",").map(id=>id.trim()).filter(Boolean));
  const testVehicles = new Set((await query(`SELECT tracking_id FROM fleet_vehicles
    WHERE is_test_vehicle AND tracking_id=ANY($1::text[])`, [candidates.map(b=>b.busId)])).rows.map(v=>v.tracking_id));
  const active=(await query(`SELECT s.id,s.bus_id,s.route_id,s.started_at,
    COALESCE(c.correo,s.driver_id::text) AS source_id,v.economic_number
    FROM driver_sessions s LEFT JOIN conductores c ON c.id=s.conductor_id
    LEFT JOIN fleet_vehicles v ON v.id=s.vehicle_id OR (s.vehicle_id IS NULL AND v.tracking_id=s.bus_id)
    WHERE s.status='active' AND s.bus_id=ANY($1::text[])
    AND (v.id IS NULL OR (v.archived_at IS NULL AND v.operational_status='available' AND NOT v.is_test_vehicle))
    AND NOT EXISTS(SELECT 1 FROM fleet_vehicles test WHERE test.tracking_id=s.bus_id AND test.is_test_vehicle)`,[candidates.map(b=>b.busId)])).rows;
  const sessions=new Map(active.map(s=>[s.id,s]));
  const deviceIds = candidates.filter(b => isHardwareProvider(b.provider) && b.deviceId).map(b => b.deviceId);
  const devices = deviceIds.length ? (await query(`${hardwareDeviceMappingSql} WHERE d.id=ANY($1::uuid[])`, [deviceIds])).rows : [];
  const deviceMap = new Map(devices.map(d => [d.id, d]));
  const localSimulation=localSimulationAllowed(process.env,'127.0.0.1',process.env.LOCATION_DEBUG_TOKEN);
  return candidates.flatMap(({sourceId,deviceId,deviceRevision,...bus})=>{
    // Temporary read-only exception for exact hardware test IDs, never Android sessions.
    const hardwareProvider = isHardwareProvider(bus.provider) ? bus.provider : null;
    const allowlistedTestVehicle = hardwareProvider !== null && testVehicles.has(bus.busId) && publicTestVehicleIds.has(bus.busId);
    if (testVehicles.has(bus.busId) && !allowlistedTestVehicle) return [];
    if (hardwareProvider) {
      const device = deviceId ? deviceMap.get(deviceId) : undefined;
      const temporaryVisibility = allowlistedTestVehicle && device?.is_test_vehicle === true;
      if (!device || ((!device.public_visible || device.is_test_vehicle) && !temporaryVisibility) || hardwareUnavailableReason(device, hardwareProvider) ||
          device.revision !== deviceRevision || device.id !== sourceId || device.tracking_id !== bus.busId ||
          device.route_id !== bus.routeId || device.route_variant_id !== bus.routeVariantId) return [];
      const {sessionId: _sessionId,...publicBus}=bus;
      return [{...publicBus,economicNumber:device.economic_number??null}];
    }
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
