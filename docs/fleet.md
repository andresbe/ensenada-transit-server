> La entrega actual incorpora restauración, historial y exportación completa. Consulta [Conductores → Flota → Viajes](driver-operations.md); las limitaciones de la entrega anterior descritas abajo ya no aplican a esas funciones.

# Actualización: espacios por línea

La migración 013 sustituye la administración global del dashboard por espacios por línea.
Consulta [Administración por línea](line-tenancy.md) antes de activar este CRUD.
Los comandos y endpoints globales de este documento describen la compatibilidad de la versión anterior.

# Flota: catálogo y compatibilidad

## Activación local

La migración `012_fleet.sql` crea el catálogo y amplía las sesiones sin cambiar los
`bus_id` existentes ni las credenciales de conductores. No importa automáticamente
ubicaciones como vehículos, porque pueden ser observaciones de pasajeros.

Detén el proceso local anterior y ejecuta `node scripts/dev-local.js` nuevamente.
El script aplica las migraciones pendientes únicamente al PostgreSQL local y luego
inicia la API. No uses `npm run migrate` con el `.env` de producción para esta prueba.
Recarga el dashboard después del arranque. La migración debe preceder al código nuevo.

## Administración

- Flota → Nuevo camión: número económico obligatorio; placas, capacidad, línea y
  conductor opcionales. Sin líneas configuradas se permite registrar sin asignación.
- Un conductor vigente solo puede tener un camión asignado. Las asignaciones quedan
  auditadas con el administrador y fecha. Cambiar disponibilidad/conductor o dar de
  baja exige finalizar antes las sesiones activas de esa unidad.
- El número económico y las placas normalizadas son únicos, incluso tras la baja.
  La baja conserva viajes, sesiones e identidad. El filtro Dados de baja consulta
  los registros retirados; no existe restauración en esta entrega.
- Estado operativo y conexión GPS son independientes. El catálogo permanece visible
  sin señal; la ubicación se consulta cada diez segundos. Exportar página exporta
  solamente los registros visibles, con protección contra fórmulas de CSV.
- Las ediciones/bajas requieren la revisión actual; un conflicto devuelve 409 y
  exige recargar antes de volver a editar.

## API administrativa (token de administrador activo)

- `GET /admin/buses?q=&page=1&limit=25&archived=false`: `{vehicles,total,page,limit}`.
- `GET /admin/buses/options`: líneas activas, conductores sin credenciales y rutas.
- `GET /admin/buses/:id`: `{vehicle}`.
- `POST /admin/buses`: crea con `economic_number`, `operational_status` y opcionales
  `plate`, `capacity`, `transport_line_id`, `assigned_driver_id`, `tracking_id`.
- `PUT /admin/buses/:id`: mismos campos de formulario completos, más `revision`.
- `DELETE /admin/buses/:id`: cuerpo `{revision}`; baja lógica, respuesta 204.

Estados: `available`, `maintenance`, `out_of_service`. Los IDs internos son UUID.
`tracking_id` es único e inmutable; si se omite, se genera. No cambiar su valor al
renombrar el camión. El listado público `/buses/live` mantiene su contrato actual.

## Aplicaciones existentes y conductores

Para vincular una unidad que ya transmite, introduce su `busId` exacto en el apartado
“Vincular un camión que ya reporta ubicación” al registrarla y asigna su conductor.
Finaliza primero cualquier sesión activa. No se reescriben IDs históricos.

`GET /driver-sessions/vehicles`, autenticado como conductor, entrega las unidades
asignadas y disponibles con `bus_id = tracking_id`. Un cliente nuevo debe utilizar
ese valor en `/driver-sessions/start` y `/locations/update`, conservando su correo
como `sourceId`. La pantalla de selección de la aplicación del conductor no forma
parte de estos repositorios y debe consumir este endpoint para descubrir unidades
nuevas automáticamente; los clientes configurados con un ID existente lo conservan.

Las sesiones aceptan conductores de `conductores` por correo y usuarios driver
UUID anteriores. Las unidades registradas exigen el conductor asignado y estado
disponible. Para el despliegue gradual se mantienen los IDs no registrados bajo
las reglas anteriores: esta entrega no impone catálogo obligatorio a esos clientes.
Las observaciones de pasajeros conservan `sourceType=user`; Flota muestra únicamente
posiciones de fuente `driver` para no atribuirlas al conductor. No se modifica el
modelo global de agregación de ubicaciones de pasajeros.

## Validación

`npm run test:fleet` usa PostgreSQL WASM aislado: migraciones, duplicados, revisiones,
historial, baja, sesiones heredadas, autorización administrativa y ubicación de
conductor. Ejecuta también `npm run test:routes`, `npm run test:passengers`,
`npm run test:security`; en dashboard, TypeScript y `bun run build`.

Prueba manual: crear unidad sin GPS; editar; rechazar duplicados; vincular `busId`
existente; asignar conductor; iniciar recorrido; comprobar velocidad km/h y ruta;
rechazar cambios incompatibles con sesión activa; terminar recorrido; dar de baja
y consultar su historial de sesiones conservado en base de datos.
