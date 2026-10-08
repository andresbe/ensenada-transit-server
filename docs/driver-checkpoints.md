# Check-ins de conductores

## Configuración y prueba manual
1. En el dashboard, abre Rutas → Check-ins y selecciona Ida o Vuelta.
2. Selecciona una parada existente y activa Usar como check-in. Para editar uno guardado, selecciónalo en la lista o mapa; puedes cambiar su nombre, tiempos y radio sin eliminarlo. El nombre vacío usa el de la parada; editarlo no renombra la parada de pasajeros. Define minutos desde el inicio del recorrido, tolerancia y radio GPS. Los minutos deben aumentar según el orden de las paradas.
3. Guarda e inicia un servicio nuevo en la app de conductores. Cada recorrido conserva una copia de su configuración; editar el plan no cambia las llegadas históricas.
4. Comprueba el siguiente punto, objetivo y marcadores. Al entrar con GPS preciso en el radio del siguiente punto se registra la llegada automáticamente.
5. Consulta Viajes → detalle para ver objetivos, llegadas y diferencias de tiempo.

## Ida y vuelta
Cada recorrido tiene su propio inicio. Un objetivo de 15 minutos en vuelta cuenta desde el inicio de vuelta, no desde el servicio original. El cambio explícito de variante necesita GPS en la terminal compartida y al menos un minuto desde el inicio del recorrido anterior.

El cambio automático al recorrido opuesto requiere haber registrado todos los puntos del recorrido actual, estar saliendo de la terminal compartida y tener posición, velocidad y rumbo compatibles con el nuevo trazado. No se reinicia el reloj por una bandera de sentido aislada. Prueba ambos sentidos en campo; geometrías que no comparten terminal pueden requerir finalizar e iniciar servicio en el otro sentido.

## Precisión y límites
Se acepta únicamente telemetría autenticada del conductor propietario del servicio. El GPS debe tener menos de dos minutos, precisión de hasta 50 metros (y como máximo la mitad del radio) y estar dentro del radio. Se descartan muestras anteriores al recorrido, repetidas o fuera de orden. Solo se registra el siguiente control; no se inventan llegadas ni se saltan controles pendientes.

Un intervalo largo de envío, pérdida de señal o un radio pequeño pueden impedir registrar un paso. Un punto pendiente bloquea los siguientes y el cambio automático de sentido; revisa esto durante las pruebas de campo. Los registros no constituyen protección absoluta contra GPS manipulado.

La llegada estimada usa progreso y velocidad recientes, no tráfico predictivo. Se oculta cuando no hay datos fiables o el plan cambió durante el recorrido. El horario objetivo y el retraso siguen disponibles.

## API y datos
- GET/PUT /admin/lines/:lineId/routes/:routeId/checkpoints: consultar o sustituir el plan con revisión optimista.
- GET /admin/lines/:lineId/trips/:id/checkins: historial autorizado por línea.
- GET /driver-sessions/current/checkpoints: próximos puntos del servicio propio.
- La recepción existente de ubicación registra llegadas; el cliente no puede enviar una llegada arbitraria.

La migración 018_driver_checkpoints.sql agrega planes, recorridos e historial con restricciones y RLS. Los lectores no pueden modificar planes. Una parada con check-in debe desvincularse antes de eliminarse. El orden de paradas no puede invalidar los horarios configurados.

## Verificación y despliegue
Las migraciones 018–020 están aplicadas en la base local. La 019 conserva la auditoría mediante triggers y la 020 permite nombres personalizados. Las ediciones conservan el identificador del check-in y no cambian los nombres de recorridos ya iniciados. Antes de desplegar este código en Railway, ejecuta el mecanismo de migraciones del proyecto; no se ha desplegado producción.

Comandos desde el backend:
- npm run build
- node --test tests/checkpoints.test.js tests/tracking-health.test.js
- node scripts/test-checkpoints-local.js

La integración local usa únicamente PostgreSQL en loopback y revierte todos sus datos de prueba. Valida horarios independientes, orden GPS, duplicados, historial y aislamiento entre líneas. Falta la prueba física de una jornada y el recorrido completo con ambos sentidos.
