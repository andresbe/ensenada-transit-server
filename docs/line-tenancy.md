# Administración por línea

## Modelo y permisos

`transport_lines` es el espacio administrativo. Su UUID no cambia al editar nombre,
código o color. `admins.is_superadmin` se consulta en base de datos; no se confía en
un rol de plataforma enviado por el navegador. La migración no eleva cuentas existentes.

`admin_line_memberships` permite varias líneas por cuenta, con roles `admin`,
`operator`, `viewer` y suspensión individual. Administrador administra accesos y
registra conductores; operador administra rutas/flota/alertas; consulta solo lee.
Los pasajeros permanecen globales y sus cuentas solo son administradas por plataforma.

`driver_line_memberships` identifica los conductores autorizados. Camiones y rutas
pertenecen a una línea. El camión puede tener una ruta asignada; las sesiones guardan
la línea de operación. Relaciones compuestas impiden asignar rutas o conductores de
otra línea. El número económico es único por línea, mientras placas y `tracking_id`
conservan unicidad global. Los UUID, `bus_id`, favoritos y viajes no se regeneran.

## Backend y PostgreSQL

- `/admin/lines`: espacios autorizados; creación/edición de líneas solo superadministrador.
- `/admin/lines/:lineId/members`: listado y asignación de cuentas administrativas existentes;
  únicamente administrador de esa línea o superadministrador. Permite cambiar rol/suspender.
- `/admin/lines/:lineId/vehicles`, `/db-routes`, `/drivers`, `/alerts`, `/buses/live`,
  `/summary`, `/trips`, `/reports`, `/audit`: operación aislada por línea.
- `/admin/platform/admins`: crear cuenta administrativa sin privilegios globales.
- `/admin/platform/unassigned` y `/assign`: inventario y reconciliación explícita, solo plataforma.
- Los endpoints administrativos globales heredados quedan restringidos a superadministradores.
  El dashboard usa exclusivamente los endpoints de línea para su operación.

`requireLine` valida identidad, membresía, estado de línea y permiso. AsyncLocalStorage
transmite el contexto a los servicios existentes. Cada transacción ejecuta `SET LOCAL
ROLE et_line_runtime`, un rol NOLOGIN/NOSUPERUSER/NOBYPASSRLS, con ajustes locales de
línea, administrador y versión de token. Las políticas RLS vuelven a comprobar
membresías y vigencia. No se comparte el contexto entre conexiones del pool; liberar
una transacción incompleta descarta la conexión. El cliente de servicios con contexto
exige BEGIN y nunca consulta sin haber aplicado el rol.

La conexión base queda reservada a autenticación, operaciones explícitas de plataforma,
servicios de pasajeros y procesos internos; no debe usarse directamente dentro de
servicios de línea. Las migraciones requieren capacidad para crear/conceder el rol.
No conceder BYPASSRLS ni propiedad de tablas a `et_line_runtime`.

Las consultas administrativas de rutas no reutilizan la antigua caché global. Las
lecturas públicas solo muestran rutas activas/publicadas y líneas activas; el feed
público elimina sourceId. Las notificaciones generales de una línea se entregan a
suscriptores de rutas de esa línea. Cambios de rutas, variantes, paradas, camiones,
alertas y membresías dejan auditoría sin contraseñas ni cuerpos sensibles.

## Activación local, sin tocar Railway

1. Detener el backend anterior y ejecutar `node scripts/dev-local.js` para aplicar
   `013_line_tenancy.sql` antes de usar el código nuevo.
2. Designar explícitamente la cuenta de plataforma ya existente:

   ```powershell
   node scripts/line-admin.js --local --promote admin@ensenadatransit.com
   ```

   Si el backend sigue abierto con el esquema anterior, puedes aplicar las migraciones
   pendientes y promover la cuenta con `node scripts/line-admin.js --local --migrate --promote admin@ensenadatransit.com`.
   `--migrate` solo admite el entorno local; usa el mismo registro y bloqueo de migraciones
   que el arranque y no repite migraciones ya aplicadas.

3. Cerrar sesión y volver a entrar al dashboard. Abrir **Líneas y accesos**, crear las
   líneas y registrar/asignar las cuentas administrativas.
4. Revisar los registros pendientes y asignarlos uno por uno: primero conductores,
   después rutas y camiones. Finalizar recorridos activos antes de mover registros
   sin línea. No hay reasignación automática ni transferencias silenciosas entre líneas.
5. Consultar el reporte y, después de revisar los datos, finalizar las restricciones:

   ```powershell
   node scripts/line-admin.js --local
   node scripts/line-admin.js --local --finalize
   ```

La finalización rechaza registros pendientes y relaciones históricas incompatibles.
Impone NOT NULL a la propiedad de rutas/camiones. Antes de finalizar, registros
heredados sin línea permanecen inaccesibles a administradores de línea; los servicios
públicos conservan rutas heredadas previamente publicadas durante la transición.

El script también admite `--env RUTA` explícita para otro entorno; nunca carga `.env`
automáticamente. No se ejecutó contra producción durante esta implementación.

## Dashboard y compatibilidad móvil

El superadministrador puede operar todas las secciones sin membresía ni línea
seleccionada. **Todas las líneas** usa `/admin/platform` con validación de
superadministrador vigente en cada solicitud; incluye conductores sin asignar y
rutas en borrador. Elegir una línea en el menú lateral filtra su operación mediante
los endpoints aislados habituales. Las cuentas de línea conservan su alcance y RLS.

Las altas de rutas y camiones incluyen la línea propietaria en el formulario global;
no se exige asignar esa línea a la cuenta del superadministrador. Los conductores
pueden crearse sin línea y asignarse después. Su nombre y contraseña se administran
globalmente; la suspensión de acceso sigue siendo por línea. Las escrituras de
rutas, camiones, alertas y check-ins con propietario reutilizan su contexto de línea
y auditoría. Los viajes activos y las revisiones siguen protegiendo la integridad.

Para cuentas de línea, una línea activa se selecciona automáticamente.
Cambiar de espacio desmonta formularios/listados/mapas y cancela sus lecturas cuando
corresponde. Permisos se refrescan periódicamente y siempre se verifican en servidor.
Crear un camión ya no pregunta por línea: permite elegir una ruta del espacio activo.
Se sustituyeron los datos de demostración en resumen/mapa/viajes/reportes/alertas por
respuestas reales. Los listados operativos muestran como máximo 100 registros recientes.

`GET /driver-sessions/vehicles` conserva `bus_id`, añade línea y ruta asignada. Las
sesiones y ubicación validan conductor, línea activa y ruta. Conductores incorporados
a líneas ya no pueden iniciar sesiones con camiones no registrados. Credenciales y
refresh por correo de conductores se conservan. La app del conductor consume
`GET /driver-sessions/catalog`: selecciona vehículos asignados y rutas de su línea,
usa el `bus_id` registrado y descarga los recorridos reales de ida/vuelta sin invertirlos.
Al iniciar revalida la asignación y crea una sesión; al detenerla cierra la sesión,
con una cola local para reintentar cierres sin conexión. El recorrido activo conserva
su geometría para restaurarse en segundo plano. Actualizar también esta app antes
de las pruebas manuales. Observaciones de pasajeros siguen su contrato existente.

## Pruebas y despliegue

- `npm run test:tenancy`: PostgreSQL WASM aislado con RLS real, HTTP, dos líneas,
  permisos, accesos cruzados, revocación, borradores, caché, sesiones y relaciones.
- Ejecutar también pruebas de administración, flota, rutas, pasajeros y seguridad.
- Dashboard: TypeScript y compilación Vite; la validación visual/manual queda pendiente.

Desplegar con mantenimiento: respaldo verificado → migración aditiva → promoción
explícita → asignación revisada → backend/dashboard compatibles → pruebas de acceso
cruzado → finalización. Conservar el respaldo y un inventario antes/después. No volver
al backend global antiguo después de habilitar cuentas de varias líneas: ante un
problema, mantener el acceso cerrado y corregir hacia adelante. No borrar datos ni
eliminar políticas como mecanismo de recuperación.
