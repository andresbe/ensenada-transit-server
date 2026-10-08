import { getClient } from "../db";
import { invalidateRoutesCache, invalidateRouteCache, invalidateVariantCache } from "../redis/cache";
import { AppError } from "../shared/errors";
import { object, parseRouteGeoJson, requiredText } from "./geojson";
import { uuid, coordinate } from "../passengers/validation";

export async function updateRoute(routeId: string, input: unknown) {
  const id = uuid(routeId), body = object(input);
  const name = requiredText(body.name, "name"), shortName = requiredText(body.short_name, "short_name");
  if (typeof body.color !== "string" || !/^#[0-9a-f]{6}$/i.test(body.color)) throw new AppError("Color inválido (#RRGGBB).", 400);
  if (typeof body.visible_in_app !== "boolean") throw new AppError("Indica si la ruta debe publicarse.", 400);
  if (!Array.isArray(body.variants) || body.variants.length > 2) throw new AppError("Máximo dos recorridos por ruta.", 400);
  if (body.visible_in_app && body.variants.length === 0) throw new AppError("Carga un recorrido antes de publicar.", 400);
  if (body.version !== undefined && (typeof body.version !== "string" || !Number.isFinite(Date.parse(body.version)))) throw new AppError("Versión de ruta inválida.", 400);
  const variants = body.variants.map(raw => {
    const v = object(raw);
    if (v.direction !== "ida" && v.direction !== "vuelta") throw new AppError("El sentido debe ser ida o vuelta.", 400);
    if (!Array.isArray(v.stops) || v.stops.length > 500) throw new AppError("Máximo 500 paradas por recorrido.", 400);
    return { id: v.id === undefined ? undefined : uuid(v.id), name: requiredText(v.name, "variant.name"), direction: v.direction,
      ...parseRouteGeoJson(v.geojson), stops: v.stops.map(rawStop => {
        const s = object(rawStop);
        return { id: s.id === undefined ? undefined : uuid(s.id), name: requiredText(s.name, "stop.name"), longitude: coordinate(s.longitude, "longitude"), latitude: coordinate(s.latitude, "latitude") };
      }) };
  });
  if (new Set(variants.map(v => v.direction)).size !== variants.length) throw new AppError("No repitas el sentido de los recorridos.", 400);
  const ids = variants.flatMap(v => v.id ? [v.id] : []);
  const stopIds = variants.flatMap(v => v.stops.flatMap(s => s.id ? [s.id] : []));
  if (new Set(ids).size !== ids.length || new Set(stopIds).size !== stopIds.length) throw new AppError("Identificadores duplicados.", 400);
  const client = await getClient();
  const changedVariants: string[] = [];
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT id, updated_at FROM routes WHERE id=$1 AND active FOR UPDATE", [id]);
    if (!current.rows.length) throw new AppError("Ruta no encontrada.", 404);
    // Compare the database timestamp text to avoid losing PostgreSQL microseconds.
    if (body.version !== undefined) {
      const match = await client.query("SELECT id FROM routes WHERE id=$1 AND updated_at=$2::timestamptz", [id, requiredText(body.version, "version")]);
      if (!match.rows.length) throw new AppError("La ruta cambió. Cierra y vuelve a abrir el editor.", 409);
    }
    const previous = await client.query<{id: string; direction: string}>("SELECT id, direction FROM route_variants WHERE route_id=$1 FOR UPDATE", [id]);
    // Existing variants cannot disappear implicitly when a new file is loaded.
    for (const v of previous.rows) if (!variants.some(n => n.id === v.id || (!n.id && n.direction === v.direction))) {
      throw new AppError("Conserva los recorridos existentes. Carga un archivo con ambos sentidos o edita cada recorrido.", 409);
    }
    const usedVariants = new Set<string>();
    for (const v of variants) {
      const existing = v.id ? previous.rows.find(p => p.id === v.id) : previous.rows.find(p => p.direction === v.direction);
      if (v.id && !existing) throw new AppError("El recorrido no pertenece a esta ruta.", 400);
      if (existing && usedVariants.has(existing.id)) throw new AppError("Recorrido repetido.", 400);
      if (existing) usedVariants.add(existing.id);
      const params = [v.name, v.direction, JSON.stringify(v.coordinates), v.distance];
      const saved = existing
        ? await client.query("UPDATE route_variants SET name=$1,direction=$2,coordinates=$3,total_distance_meters=$4 WHERE id=$5 AND route_id=$6 RETURNING id", [...params, existing.id, id])
        : await client.query("INSERT INTO route_variants(name,direction,coordinates,total_distance_meters,route_id) VALUES($1,$2,$3,$4,$5) RETURNING id", [...params, id]);
      const variantId = saved.rows[0].id as string;
      changedVariants.push(variantId);
      await client.query("SELECT id FROM stops WHERE variant_id=$1 FOR UPDATE", [variantId]);
      const keep: string[] = [];
      for (const [sequence, stop] of v.stops.entries()) {
        const values = [stop.name, stop.longitude, stop.latitude, sequence, variantId, id];
        const result = stop.id
          ? await client.query("UPDATE stops SET name=$1,longitude=$2,latitude=$3,sequence=$4 WHERE variant_id=$5 AND route_id=$6 AND id=$7 RETURNING id", [...values, stop.id])
          : await client.query("INSERT INTO stops(name,longitude,latitude,sequence,variant_id,route_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", values);
        if (!result.rows.length) throw new AppError("La parada no pertenece al recorrido.", 400);
        keep.push(result.rows[0].id);
      }
      const referenced = await client.query("SELECT s.id FROM stops s JOIN favorite_stops f ON f.stop_id=s.id WHERE s.variant_id=$1 AND NOT(s.id=ANY($2::uuid[])) LIMIT 1", [variantId, keep]);
      if (referenced.rows.length) throw new AppError("Una parada retirada tiene favoritos. Consérvala para no perder sus referencias.", 409);
      const checkpoints = await client.query("SELECT id FROM route_checkpoints WHERE variant_id=$1 AND NOT(stop_id=ANY($2::uuid[])) LIMIT 1", [variantId, keep]);
      if (checkpoints.rows.length) throw new AppError("Retira primero el check-in de la parada que quieres eliminar.",409);
      await client.query("DELETE FROM stops WHERE variant_id=$1 AND NOT(id=ANY($2::uuid[]))", [variantId, keep]);
    }
    const orderedPoints = await client.query("SELECT c.variant_id,c.target_minutes FROM route_checkpoints c JOIN stops s ON s.id=c.stop_id WHERE c.route_id=$1 ORDER BY c.variant_id,s.sequence,s.id", [id]);
    const previousTarget = new Map<string, number>();
    for (const point of orderedPoints.rows) {
      const prior = previousTarget.get(point.variant_id);
      if (prior !== undefined && point.target_minutes <= prior) throw new AppError("Ajusta los tiempos de check-in antes de cambiar el orden de estas paradas.", 409);
      previousTarget.set(point.variant_id, point.target_minutes);
    }
    const result = await client.query("UPDATE routes SET name=$1,short_name=$2,color=$3,visible_in_app=$4,checkpoint_revision=checkpoint_revision+1 WHERE id=$5 RETURNING *", [name, shortName, body.color, body.visible_in_app, id]);
    await client.query("COMMIT");
    await Promise.all([invalidateRoutesCache(), invalidateRouteCache(id), ...changedVariants.map(invalidateVariantCache)]);
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function deleteRoute(routeId: string) {
  const id = uuid(routeId), client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await client.query("UPDATE routes SET active=FALSE,visible_in_app=FALSE WHERE id=$1 AND active RETURNING id", [id]);
    if (!result.rows.length) throw new AppError("Ruta no encontrada.", 404);
    const variants = await client.query<{id: string}>("SELECT id FROM route_variants WHERE route_id=$1", [id]);
    await client.query("COMMIT");
    await Promise.all([invalidateRoutesCache(), invalidateRouteCache(id), ...variants.rows.map(v => invalidateVariantCache(v.id))]);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
