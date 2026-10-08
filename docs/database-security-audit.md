# Auditoría de estructura y seguridad de datos

Fecha: 2026-10-01. Alcance: código, consultas, autenticación y migraciones del
repositorio. No se inspeccionaron datos, roles, certificados o configuración de
Railway. Las pruebas utilizaron PostgreSQL WASM en memoria, sin conexión remota.
No es una certificación de seguridad ni una prueba de penetración.

## Relaciones y estructura

El núcleo está separado en identidades, catálogo de transporte y datos de cuenta:

- `users` → preferencias, favoritos, lugares, reportes, soporte y viajes.
- `transport_lines` → `routes` → `route_variants` → `stops`.
- `physical_stops` permite compartir una parada física entre asociaciones de variantes.
- `passenger_trips` → eventos; los eventos heredan el propietario del viaje.
- `users` → dispositivos/suscripciones; entregas enlazan dispositivo y alerta.
- `admins` mantiene credenciales y revocación separadas de pasajeros.

Las consultas privadas revisadas filtran por el usuario autenticado, no por un
`user_id` enviado por el cliente. Los valores de SQL son parámetros; los nombres
dinámicos de tablas y columnas provienen de listas internas. Esto debe preservarse.

## Hallazgos corregidos

| Hallazgo | Cambio |
| --- | --- |
| Dos FK independientes permitían una variante de otra ruta | `011_relational_integrity.sql` añade FK compuestas en paradas, favoritos, viajes, reportes y sesiones. |
| Valores incoherentes aceptados directamente por SQL | Restricciones para roles, estados de usuario, proveedor, idioma, dirección, coordenadas, secuencia, días de servicio, duración positiva, reportes, fechas de viaje e intentos de entrega. |
| Referencias sin índices en varias tablas | Índices sobre relaciones nuevas y referencias de favoritos, viajes, dispositivos/alertas y transferencias. No se eliminan índices existentes sin medición. |
| Secreto JWT conocido como respaldo | Configuración obligatoria; se rechaza el valor predeterminado y se exigen 32 bytes en producción. Usar un secreto generado aleatoriamente: longitud no garantiza entropía. |
| Verificación JWT demasiado permisiva | Solo HS256; validación del sujeto y del rol. |
| Login de conductor aceptaba texto plano | Solo se comparan hashes bcrypt. No se transforman ni exponen contraseñas existentes. |
| TLS de PostgreSQL no verificaba certificados | API y scripts comparten configuración con verificación por defecto en producción; no aceptan parámetros SSL en la URL que la sobrescriban. |
| Diagnóstico de ubicaciones abierto si faltaba configuración | Sin `LOCATION_DEBUG_TOKEN`, el endpoint rechaza acceso. |
| Consultas/transacciones del API sin límite de ejecución | `statement_timeout` y `idle_in_transaction_session_timeout` de 15 segundos. Medir consultas legítimas antes de ajustar. |

## Despliegue y compatibilidad

1. Respaldar y ensayar restauración en un entorno aislado. Revisar también el aviso
   sobre migraciones antiguas sin journal en `passenger-integration.md`.
2. Ensayar la migración 011 sobre una copia representativa. Las restricciones se
   validan contra todas las filas; si hay inconsistencias, la transacción aborta.
   No se borran ni reasignan registros automáticamente. Corregir cada caso con su
   significado real antes de reintentar. Índices y validación pueden bloquear tablas;
   medir el ensayo y elegir ventana de mantenimiento.
3. Configurar `JWT_SECRET` antes de arrancar. Cambiar el secreto invalida tokens
   anteriores y exige iniciar sesión otra vez.
4. Revisar las cuentas legacy de `conductores`: si almacenan texto plano, requieren
   restablecimiento de contraseña o conversión mediante un procedimiento administrativo
   controlado a bcrypt antes del cambio. El nuevo login las rechazará.
5. `DATABASE_SSL_MODE=verify-full` es el valor predeterminado en producción.
   `DATABASE_SSL_CA` admite el certificado CA PEM cuando sea necesario. Eliminar
   parámetros `ssl*` de `DATABASE_URL`. Si el servicio solo ofrece tráfico interno
   sin TLS, `DATABASE_SSL_MODE=disable` es una decisión explícita limitada a esa red
   privada; nunca usarla para conexiones públicas. No hay opción `no-verify`.
6. Publicar código y migraciones después de verificar estas condiciones. Esta
   revisión no ejecutó ninguno de esos pasos en Railway.

## Pendientes priorizados

- **Alta — identidad de conductores:** el login legacy usa `conductores.correo`,
  mientras `driver_sessions.driver_id` referencia `users.id` UUID. Unificar la
  identidad con UUID y una migración de correspondencias verificadas; no inferir
  propietarios ni convertir correos a UUID ficticios. `conductores` carece de PK
  explícita aunque tiene correo único; debe resolverse en esa migración.
- **Alta — asignación y autenticación de tracking:** el modo opcional permite
  ubicaciones anónimas; no basta con autenticar al conductor para autorizar cualquier
  `busId`. Exigir identidad y asignación conductor–unidad–variante comprobable en
  producción. Separar señales colaborativas de posiciones oficiales del conductor.
- **Alta — privilegios de infraestructura:** comprobar rol de API sin SUPERUSER,
  CREATEDB, CREATEROLE ni DDL; separar rol de migraciones. Restringir red y acceso
  público de PostgreSQL/Redis, almacenar secretos fuera del repositorio y verificar
  respaldos, retención y recuperación. Nada de esto se puede confirmar desde SQL fuente.
- **Media — revocación y aislamiento adicional:** los pasajeros no tienen versión
  de token como los administradores. Evaluar sesiones revocables y RLS con contexto
  de cuenta por transacción. No activar RLS parcialmente: podría bloquear workers
  o dar falsa protección usando un propietario de tablas que la omite.
- **Media — invariantes restantes:** definir un solo viaje activo por cuenta también
  durante transferencias de invitado; revisar relación parada–variante en reportes,
  estados de soporte, normalización/unicidad de correo y validación de geometrías
  completas. La migración 011 no pretende cubrir todas esas reglas.
- **Media — privacidad y retención:** los diagnósticos registran coordenadas,
  identificadores e IP. Limitar acceso, nivel de detalle y tiempo de retención.
  Acordar anonimización o borrado del historial; las FK de transferencias y viajes
  actualmente pueden impedir eliminaciones físicas deliberadamente.
- **Media — abuso y dependencias:** revisar límites por identidad e IP, creación de
  invitados y almacenamiento por cuenta; auditar dependencias y probar concurrencia
  sobre PostgreSQL/Redis reales antes de certificar carga o resistencia a abuso.

## Pruebas y referencias

`npm run test:security` compila y prueba restricciones mediante escrituras directas,
rechazo de relaciones cruzadas, valores inválidos, política TLS, JWT y rechazo de
contraseñas legacy en texto plano. La suite completa del backend pasó 39 pruebas
en esta revisión. No prueba la configuración real de Railway.

Las FK compuestas y restricciones siguen la [documentación de PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html).
La separación de privilegios y protección de conexiones sigue la [guía de seguridad de bases de datos de OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html).
