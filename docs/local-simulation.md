# Simulación local de camiones

Mantén el backend iniciado con `node scripts/dev-local.js`. En otra terminal del
backend ejecuta uno de estos comandos. No requiere compilar o reinstalar la app.

```powershell
# Tres camiones de ida y tres de vuelta (predeterminado)
node scripts/simulate-buses.js
# Latencia variable, muestras espaciadas y pérdida de mensajes
node scripts/simulate-buses.js --profile high-latency
# Actualizaciones muy separadas para evaluar saltos grandes
node scripts/simulate-buses.js --profile jumps
```

Elige la ruta publicada por número. Se usa su geometría real de ida y de vuelta,
sin invertir artificialmente un recorrido. Si hay varios recorridos del mismo
sentido, el script pregunta cuál usar. Si falta ida o vuelta, informa el error;
puedes usar `--variant ID` para probar solo un recorrido.

| Perfil | Captura GPS | Retraso simulado | Pérdida | Velocidad |
| --- | --- | --- | --- | --- |
| normal | 6 s | 0 s | 0% | 24 km/h |
| high-latency | 15 s | 8 ± 5 s | 25% | 24 km/h |
| jumps | 60 s | 15 ± 10 s | 0% | 60 km/h |

Los camiones avanzan continuamente entre capturas. Cada mensaje conserva las
coordenadas y timestamp de cuando se capturó; se entrega más tarde al endpoint
normal de tracking. Se mantiene el orden de mensajes por unidad. El emisor limita
las ráfagas a un envío por segundo, por lo que la espera real puede ser mayor; la
terminal muestra la edad GPS efectiva al entregar cada posición.

Esto simula problemas de transmisión del conductor al backend. No introduce
latencia en las respuestas HTTP del backend a la app. La app además consulta
periódicamente: el resultado visual combina ambos intervalos.

```powershell
# Personalizar (valores de tiempo en segundos, velocidad en km/h)
node scripts/simulate-buses.js --both --count 3 --interval 30 --latency 12 --jitter 8 --drop-rate 0.2 --speed 40
# Inspeccionar IDs de rutas, recorridos y paradas
node scripts/simulate-buses.js --list
# Comprobar sin transmitir
node scripts/simulate-buses.js --profile high-latency --dry-run
# Un recorrido y una parada de referencia concretos
node scripts/simulate-buses.js --variant ID_RECORRIDO --stop ID_PARADA
```

`--count` es la cantidad por sentido. `--seconds` limita la duración (600 por
defecto). `--seed 42` reproduce las decisiones de pérdida/jitter; los tiempos de
entrega pueden variar con la carga real. `--dwell 12` controla la pausa en paradas
(el perfil jumps usa cero). `--port` permite otra API loopback local.

Por defecto las unidades empiezan al 10%, 40% y 70% de cada recorrido para que se
distingan en el mapa. Con `--stop`, se sitúan alrededor de esa parada cuando hay
espacio. No crean paradas ni vehículos de flota. Al final del recorrido se detienen;
no invierten ni se teletransportan al inicio.

## Controles y comprobaciones

Escribe la letra y Enter: `p` pausa/reanuda movimiento; `x` corta/reanuda señal
(descarta mensajes pendientes); `q` o Ctrl+C termina y descarta la cola.

1. Cambia entre Ida y Vuelta en la app: debe haber tres unidades SIM por sentido.
2. Con normal, observa movimiento sin recreación ni parpadeos de iconos.
3. Con high-latency, compara mensajes PERDIDA/ENVIADO con pausas y recuperación.
4. Con jumps, espera al menos dos minutos: a 60 km/h recorre unos 1000 m por muestra.
   La distancia recta puede ser menor en curvas, por lo que no garantiza disparar
   un umbral de salto basado en distancia recta.
5. Corta señal durante más del TTL: las unidades deben expirar. Al volver, revisa
   aparición y posición. TTL local predeterminado: 90 s.
6. Para ETA selecciona una parada intermedia registrada al recorrido. Una parada
   al inicio no tiene tramo previo para recibir camiones; sin paradas no hay ETA.

No se afirma que la animación sea correcta solo porque el simulador funcione:
valida estos casos visualmente en el teléfono.

## Aislamiento y validación

Solo `127.0.0.1`, sin `.env`, URLs remotas ni redirecciones. Credencial privada de
`.local/secrets.json`. El backend exige modo desarrollo, habilitación local,
socket loopback, PostgreSQL/Redis locales dedicados y token válido. IDs efímeros
SIM únicos por ejecución, sin modificar la flota. Posiciones expiran con el TTL.
Detén simulaciones anteriores antes de comparar cantidades; pueden permanecer
visibles durante ese TTL.

Pruebas automatizadas: `npm run test:simulation`.

## Orden de ida y vuelta

El movimiento siempre sigue el orden de las coordenadas del recorrido registrado.
El simulador detecta cuando una vuelta tiene ambos extremos claramente alineados
con la ida y detiene el arranque para evitar probar una ruta mal orientada.
Corrige el orden del trazado propio de vuelta en el catálogo; no sustituyas su
geometría por la de ida. Rutas circulares o extremos ambiguos requieren revisión
manual. Después de editar geometría, reinicia el simulador y refresca la app para
que ambos carguen el catálogo actualizado.
