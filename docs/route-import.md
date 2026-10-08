
## CRUD del dashboard

- PUT /db-routes/:routeId: edición transaccional con el mismo formato de importación.
  Requiere name, short_name, color, visible_in_app y variants. Cada variante admite
  id y cada parada admite id para conservar referencias. version es la revisión
  textual devuelta por GET /db-routes/:routeId; una edición obsoleta devuelve 409.
- DELETE /db-routes/:routeId: baja lógica (active=false, visible_in_app=false),
  respuesta 204. Conserva favoritos, variantes, paradas y registros históricos.
- Ambas operaciones requieren una cuenta administradora activa.
- No se pueden omitir variantes existentes en una edición. Las paradas omitidas
  se retiran, salvo que tengan favoritos: en ese caso se rechaza toda la operación.
- Una ruta sin recorridos puede editarse como borrador, pero no publicarse.

Prueba manual: abrir una ruta → Editar ruta → cambiar nombre/color y guardar.
Abrir nuevamente y comprobar persistencia. Cargar GeoJSON en una ruta sin
recorridos, asignar Ida/Vuelta y publicar. Editar el nombre/posición/orden de
una parada. Eliminar una ruta desde su detalle y confirmar: desaparece del
listado y catálogo, conservando el historial en PostgreSQL.

Las pruebas route-crud.test.js ejecutan migraciones sobre PostgreSQL WASM
local y aislado, sin modificar bases de datos configuradas.
