# Reportes de pasajeros

POST /reports requiere una sesión de usuario o invitado. Responde { report } con 201 al crear y 200 al repetir el mismo client_id y contenido. La clave es única por usuario; reutilizarla con datos diferentes devuelve 409. Los reintentos explícitos del formulario conservan la clave mientras no se editen los datos.

Contrato:
- type: delay, crowded, stopIssue, detour, breakdown u other. La app ofrece los primeros cuatro; se conservan los tipos anteriores del backend.
- severity: low, moderate o high (moderate por defecto para clientes antiguos).
- message: texto de hasta 2000 caracteres.
- route_id, variant_id y stop_id: UUID opcionales relacionados entre sí. Si solo se proporciona parada o recorrido, se deriva su ruta. La ruta debe estar activa y publicada.
- bus_id: identificador opcional de hasta 100 caracteres.
- latitude y longitude: opcionales; deben enviarse juntas y dentro de rango. El formulario actual no captura GPS.
- client_id: identificador de intento, máximo 100 caracteres. Opcional para compatibilidad con clientes antiguos; estos no tienen deduplicación garantizada.

El servidor admite también las cuatro categorías y tres severidades en español enviadas por la versión anterior, normalizándolas al guardar. La nueva app usa IDs estables y etiquetas traducidas.

GET /reports/my devuelve solo reportes del propietario. El dashboard consulta GET /admin/lines/:lineId/reports bajo RLS: incluye ruta, parada, categoría, mensaje, prioridad y estado. Un reporte sin ruta ni parada queda en el historial del usuario; no se atribuye a una línea arbitraria.

Un reporte se guarda con estado open, no crea una alerta pública ni envía push. La identidad queda asociada internamente al usuario, pero no aparece en el listado administrativo por línea ni se publica a pasajeros. No se afirma anonimato absoluto.

La migración 021 permite al rol administrativo leer solo la referencia stop_id adicional; no amplía el alcance de RLS. Aplicada localmente, pendiente del proceso habitual en Railway.

Verificación: npm run build y node --test tests/reports-contract.test.js tests/line-tenancy.test.js. Cubre las categorías, cliente anterior, severidad/parada guardadas, derivación de ruta, duplicados, conflictos, validación y autenticación. La prueba manual en teléfono consiste en Alertas → Reportar, seleccionar ruta/parada, enviar y comprobar la confirmación y Reportes del dashboard.
