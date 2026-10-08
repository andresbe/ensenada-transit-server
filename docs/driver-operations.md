# Conductores → Flota → Viajes

## Activación local

Detén el backend local y vuelve a ejecutar `node scripts/dev-local.js` en este
repositorio. Aplicará `014_driver_operations.sql` al PostgreSQL local antes de
iniciar el servidor. Alternativa, con los contenedores locales encendidos:
`node scripts/line-admin.js --local --migrate`.

La migración agrega revisión y versión de acceso de conductores, amplía el historial
de flota y conserva las sesiones existentes. No crea cuentas ni modifica producción.
El backend nuevo requiere esta migración. Recarga el dashboard después del arranque.

## Prueba manual completa

1. Inicia sesión en el dashboard y elige una línea activa. En **Conductores**, crea
   una cuenta con nombre, correo y contraseña; comprueba búsqueda y estado.
2. En **Flota**, crea o edita un camión: asigna ese conductor, una ruta de la misma
   línea y estado **Disponible**. La ruta debe tener al menos un recorrido válido.
   El mismo conductor no puede estar asignado a dos camiones vigentes.
3. Inicia sesión en la app del conductor con esa cuenta. Su catálogo debe mostrar
   el camión asignado y sus recorridos. Inicia el viaje desde esa app.
4. En **Viajes**, pulsa **Actualizar**. Filtra por conductor/camión y **En curso**;
   abre el detalle. Verifica camión, nombre, ruta, sentido e inicio. Flota muestra
   ubicación únicamente cuando el conductor transmite GPS.
5. Durante ese viaje, intenta dar de baja el camión, cambiar su asignación o
   suspender/restablecer la contraseña del conductor: debe rechazarse con 409.
6. Finaliza el viaje desde la app del conductor y actualiza Viajes. Debe aparecer
   **Finalizado**, con fecha final y duración. Comprueba filtros de fechas y CSV.
7. En Conductores → Administrar, suspende y reactiva el acceso. La suspensión
   conserva la asignación y el historial, pero bloquea nuevos viajes en esa línea.
   Cambia la contraseña sin viaje activo: la anterior y los tokens previos dejan
   de servir; entra nuevamente con la nueva contraseña.
8. Da de baja el camión y consúltalo en **Dados de baja**. **Restaurar camión** lo
   recupera fuera de servicio y sin conductor/ruta. Reasígnalos antes de operar.
   **Historial** debe mostrar asignaciones, disponibilidad, baja y restauración.
9. Verifica otra línea y una cuenta de consulta: sin datos ajenos ni escritura.

## Contratos administrativos

Todos bajo `/admin/lines/:lineId`, con token administrativo y permisos vigentes:

- `GET /drivers?q=&status=all|active|suspended&page=1&limit=25`.
- `POST /drivers`: `{name,email,password}`; `PUT /drivers/:id`:
  `{name,active,revision,password?}`. Solo administrador de línea/superadministrador.
- `GET /vehicles/:id/history?page=1&limit=25`.
- `POST /vehicles/:id/restore`: `{revision}`; operador o administrador.
- `GET /trips?driver_id=&vehicle_id=&route_id=&status=active|ended&from=&to=&page=1&limit=25`.
- `GET /trips/:id` y `GET /trips/options` (rutas vigentes o con viajes históricos).

Las listas de conductores/viajes/historial incluyen `total`, `page` y `limit`
(máximo 100). Fechas `YYYY-MM-DD`: inicio inclusivo y día final completo en
`America/Tijuana`. Exportaciones consultan todas las páginas filtradas; no son
una instantánea transaccional si los datos cambian durante la descarga.

## Seguridad y límites

RLS mantiene el aislamiento por línea; campos sensibles no se exponen en listas.
Las contraseñas usan bcrypt, coste 12, máximo 72 bytes; un cambio incrementa la
versión JWT. El correo permanece estable por ser la identidad de seguimiento.
Si una cuenta pertenece a varias líneas, solo el superadministrador puede cambiar
su nombre o contraseña; cada administrador puede gestionar su propia membresía.

Los viajes registran sesiones, no un historial de puntos GPS. No se calcula
kilometraje ni reproducción del trayecto. La duración de un viaje activo corresponde
a la última consulta. El historial anterior a 014 puede carecer de ruta/estado;
los nombres mostrados corresponden a los catálogos actuales.

## Validación automatizada

Compilar backend con `npm run build` y ejecutar `node --test tests/*.test.js`.
`tests/line-tenancy.test.js` prueba el flujo HTTP con PostgreSQL WASM aislado:
permisos, filtros/detalle, conflictos, suspensión, bcrypt, revocación JWT,
finalización, historial y restauración. `tests/fleet.test.js` cubre compatibilidad
con sesiones anteriores. En dashboard: `bunx tsc --noEmit` y `bun run build`.
