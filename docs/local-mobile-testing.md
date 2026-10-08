# Pruebas locales con la app de pasajeros

Ejecutar desde `ensenada-transit-server`. La PC y el teléfono deben estar en el
mismo Wi-Fi, con comunicación entre dispositivos habilitada.

## Primera vez

1. Instalar y abrir Docker Desktop con contenedores Linux y Docker Compose.
2. Instalar dependencias: `npm ci` en el backend y
   `npm ci --legacy-peer-deps` en `ensenada-transit-users`.
3. Verificar sin crear archivos, contenedores ni conexiones a bases de datos:

   ```powershell
   node scripts/dev-local.js --check
   ```

4. Iniciar todo:

   ```powershell
   npm run dev:local
   # Si npm no está en PATH, es equivalente:
   node scripts/dev-local.js
   ```

El comando selecciona la IPv4 privada de la PC, crea PostgreSQL y Redis locales,
aplica las migraciones, inicia la API con recarga automática y espera a que responda
`/catalog`. Después inicia Expo en modo LAN con caché limpia y la URL de esa API.
Si hay varias interfaces, especificar la del Wi-Fi:

```powershell
npm run dev:local -- --host 192.168.1.130
```

La IP es un ejemplo observado en esta PC; puede cambiar al reconectar el Wi-Fi.

## Teléfono y hot reload

- Abrir `http://IP_DE_LA_PC:3000/health` en el navegador del teléfono. Después
  comprobar `/catalog`. Si no abre, revisar Wi-Fi, VPN y aislamiento de clientes.
- Permitir Node en el firewall de Windows **solo en redes privadas**, para los
  puertos 3000 y 8081. El script no modifica el firewall.
- Abrir la app Android de depuración conectada a Metro. Si necesita seleccionar
  servidor, usar `IP_DE_LA_PC:8081` en el menú de desarrollo. Expo muestra su QR;
  Expo Go solo sirve si soporta todos los módulos nativos usados.
- Si falta el binario de depuración o cambian módulos nativos, compilar con
  `npm run android` desde el repositorio móvil; el launcher no compila ni instala APK.
  Cambios JS/TS usan Fast Refresh; cambios nativos requieren recompilar.
- Iniciar sesión o registrar una cuenta **local**. Las cuentas de Railway no existen
  aquí. Una sesión guardada de producción será rechazada por la API local; puede
  ser necesario volver a iniciar sesión al cambiar de entorno.
- La base empieza vacía. Cargar rutas reales mediante el flujo documentado en
  `route-import.md`, usando un administrador local. No se copian datos de Railway ni
  se generan buses en vivo: para tracking se necesita un conductor configurado en
  este entorno. `npm run create:admin` normal usa `.env`; **no ejecutarlo para este
  entorno sin configurar explícitamente las variables locales**.

## Opciones y cierre

```powershell
# Solo API y servicios locales
npm run dev:local -- --no-mobile
# Otra ubicación de la app o puertos libres
npm run dev:local -- --mobile C:\repos\ensenada-transit-users --port 3002 --mobile-port 8082
# Tras Ctrl+C, detener también los contenedores; conserva los datos
npm run local:stop
```

Para iniciar solamente Metro con una API local ya disponible, ejecutar desde la app:

```powershell
npm run start:local -- --host 192.168.1.130 --port 3000
```

Ctrl+C en el launcher completo termina sus procesos de API y Expo. PostgreSQL y
Redis permanecen disponibles hasta `local:stop`. Un puerto ocupado produce error;
el script no mata servidores ajenos. No borrar `.local` mientras se conserve el
volumen de PostgreSQL: contiene las credenciales de ese volumen.

## Aislamiento de producción

- Proyecto Compose: `ensenada-transit-local`; volumen persistente propio.
- PostgreSQL: `127.0.0.1:55432`, base y usuario `transit_local`.
- Redis: `127.0.0.1:56379`. Ninguno se publica en la red Wi-Fi.
- Claves aleatorias locales en `.local/`, excluido de Git; no se imprimen.
- El backend no carga `.env`: recibe un archivo vacío y URLs locales explícitas.
  Se eliminan variables heredadas de conexiones y se deshabilitan SMTP/push.
- Se rechaza un contexto Docker remoto. No se ejecutan migraciones en Railway.
- Expo recibe `EXPO_PUBLIC_TRANSIT_API_URL` solo para ese proceso; no se escribe
  `.env.local` ni se cambia la URL predeterminada de producción del código.
- API y Metro se exponen en la LAN para el teléfono. Usar una red privada de
  confianza; esto no es una configuración para publicar el servidor en Internet.

## Verificación del launcher

`npm run test:local` comprueba selección de IP, puertos, rechazo de Docker remoto
y aislamiento de variables. La app tiene `tests/local-launcher.test.cjs`.
El arranque completo requiere Docker Desktop funcionando; `--check` indica faltantes.

## Simulador de camiones

Para probar rutas existentes sin desplazarte con la app de conductor, consulta
[Simulación local](local-simulation.md). Reinicia el launcher y ejecuta
`node scripts/simulate-buses.js` en otra terminal. Usa el mismo pipeline de tracking
con unidades efímeras, sin modificar tu flota registrada.
