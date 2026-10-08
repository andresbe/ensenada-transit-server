# Integración de la app de pasajeros

Entrega de código local, 29-09-2026. No se ejecutaron migraciones ni escrituras en Railway. El contrato de UI está en `ensenada-transit-users/docs/backend/CONTRACT.md`.

## Migraciones

| Archivo | Contenido |
|---|---|
| `008_passenger_platform.sql` | Líneas, metadatos, aliases, paradas físicas, favoritos con destino, lugares, reportes, alertas, soporte y viajes |
| `009_passenger_notifications.sql` | Dispositivos, suscripciones, publicaciones y cola de entregas |
| `010_guest_transfers.sql` | Registro idempotente de transferencias de invitados |
| `011_relational_integrity.sql` | Relaciones compuestas, restricciones de dominio e índices |

`npm run migrate` usa una conexión, bloqueo advisory y transacción por archivo. Registra nombre y SHA-256 en `schema_migrations`; no repite archivos registrados y rechaza cambios en un archivo aplicado. Crear una migración nueva para ajustes posteriores.

En una base existente sin este registro, la primera ejecución vuelve a ejecutar los archivos antiguos antes de registrarlos. Revisarlos y respaldar antes: `004_revert_users_driver_assignments.sql`, que ya existía, elimina columnas antiguas de asignación. No ejecutar el runner solo para consultar estado.

La migración 008 copia favoritos existentes una vez y conserva los endpoints antiguos. No elimina rutas, variantes ni asociaciones de paradas existentes. Las tablas nuevas no incluyen datos inventados ni importan automáticamente los fixtures de la app.

## Orden de puesta en servicio

1. Confirmar proyecto/entorno Railway y respaldo recuperable. Ensayar en una copia con datos representativos, PostgreSQL y Redis.
2. Ejecutar las migraciones con la configuración de ese entorno. Comprobar `schema_migrations` y la integridad de las referencias.
3. Desplegar el backend. Con identidad admin, cargar líneas, metadatos, paradas y aliases verificados mediante `src/passengers/catalog.routes.ts`. No inferir equivalencias por similitud del nombre.
4. Comprobar `/catalog` y `/routes/:variantId/eta`; incluir Chapultepec y todas las rutas que deben publicarse. Rutas sin geometría no son navegables. El catálogo vacío muestra un estado vacío en la app, nunca fixtures.
5. Validar conductores legacy y UUID. Las ubicaciones anteriores guardadas en Redis pueden conservar IDs legacy hasta su siguiente actualización o vencimiento TTL.
6. Compilar la app con la URL correcta y `expo-notifications` integrado en el binario nativo. El cambio del módulo requiere recompilar; hot reload por sí solo no lo instala.
7. Validar invitado, registro/login, transferencia, favoritos, lugares, ES/EN, reporte privado, publicación, viaje, señal perdida y cambio de cuenta. Probar dos dispositivos y permisos denegados.

Las estadísticas se calculan desde ubicaciones vigentes. Ocupación no disponible devuelve `null`; no se inventa un porcentaje. `/routes/:id/live` tiene un único registro, acepta ruta o variante; `/routes/:variantId/eta` exige variante.

## Notificaciones

La app obtiene un token Expo y registra el dispositivo. La cola solo incluye publicaciones vigentes posteriores a la suscripción, con dispositivo activo y preferencias habilitadas. Al desactivar una suscripción o preferencia, las entregas pendientes se suprimen. Tokens `DeviceNotRegistered` se desactivan.

Crear un worker programado que ejecute `npm run notifications:deliver` aproximadamente cada minuto, con las mismas variables de base de datos y `PUSH_NOTIFICATIONS_ENABLED=true`. El script permanece inactivo si no se habilita explícitamente. Configurar credenciales FCM/APNs del proyecto Expo; `EXPO_ACCESS_TOKEN` es opcional según la configuración de seguridad del proyecto. No ponerlo en la app.

Hay reintentos con espera creciente, leases para recuperar trabajos y comprobación de recibos a los 15 minutos. `accepted` significa aceptación por el proveedor, no lectura en el teléfono. La entrega es al menos una vez: una caída después de enviar y antes de registrar el ticket puede duplicar un aviso. Referencia: [API oficial de Expo Push](https://docs.expo.dev/push-notifications/sending-notifications/).

El botón Avisarme durante navegación genera un aviso local con la pantalla abierta; no requiere el worker, pero sí el permiso y el módulo nativo. No equivale a navegación en segundo plano.

## Validación reproducible sin Railway

```sh
npm ci
npm run type-check
npm run build
node --test tests/admin-auth.test.js tests/app-updates.test.js tests/route-import.test.js tests/passengers.test.js tests/passenger-database.test.js
```

La suite de base de datos usa PostgreSQL WASM en memoria (`@electric-sql/pglite`, incluida extensión `pgcrypto`), aplica los SQL reales y prueba HTTP contra esa base. Redis y Expo Push están simulados; no lee `.env` para conectarse a Railway y no envía notificaciones reales. No sustituye el ensayo con datos existentes, varias réplicas y un teléfono.

## Compatibilidad y reversión

Conservar un binario anterior de app y backend. Si se revierte, detener primero el worker y volver al backend anterior; dejar las tablas nuevas para conservar datos. No borrar tablas ni ejecutar SQL inverso automáticamente. El backend antiguo no expone `/catalog`, por lo que la app nueva debe publicarse después del servidor y revertirse también si este deja de ofrecer el contrato.

El cierre local de sesión elimina credenciales; la revocación remota de todos los JWT queda fuera de esta entrega. Se intenta retirar el dispositivo antes de salir; sin red, esa baja no está garantizada. La transferencia de invitados exige un token vigente, mantiene preferencias de la cuenta destino y conserva datos de ambos sin sobrescribir favoritos.

OAuth sigue deshabilitado con 503 hasta verificar tokens del proveedor. Recuperación de contraseña, transbordos, rutas peatonales verificadas y actualización automática Android permanecen aplazados. No habilitar botones o endpoints como si esas integraciones estuvieran listas.

## Revisión de seguridad

Antes de desplegar los cambios de autenticación y conexión, consultar [la auditoría de estructura y seguridad](database-security-audit.md), incluidos los requisitos de JWT, TLS y cuentas legacy de conductores.
