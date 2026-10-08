# Pruebas locales de notificaciones

1. Inicia API, PostgreSQL, Redis y Metro con `node scripts/dev-local.js`.
2. En otra terminal del backend ejecuta `npm run notifications:local`.
3. Usa la APK de desarrollo de `com.ensenadatransit.users`, compilada con Firebase; Expo Go no permite esta prueba.
4. En Perfil → Notificaciones, activa las notificaciones del dispositivo, acepta el permiso de Android y selecciona una ruta.
5. Publica una alerta nueva para esa ruta en el dashboard conectado al backend local. Debe estar vigente y publicarse después de la suscripción.
6. El proceso consulta cada 15 segundos. Comprueba la recepción en el teléfono; los recibos de Expo se revisan después de 15 minutos.

`notifications:local` usa solamente las credenciales de `.local/secrets.json` y PostgreSQL en `127.0.0.1:55432`. No carga `.env` ni hereda conexiones de producción. Los envíos salen a Expo y pueden llegar a los dispositivos registrados en esa base local. Detén el proceso con Ctrl+C.

Las claves privadas de Firebase se configuran en Expo, nunca se incluyen en la APK ni en el backend. El archivo público `google-services.json` debe corresponder al proyecto de la clave FCM V1 y al paquete Android.

Para Railway, el comando existente `npm run notifications:deliver` procesa un lote y termina. Requiere el backend compilado, las variables de la base de datos del entorno correspondiente y `PUSH_NOTIFICATIONS_ENABLED=true`. Debe ejecutarse mediante una tarea programada; este procedimiento local no modifica Railway.
