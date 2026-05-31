# Ensenada Transit Location Service

Lightweight Node.js + Express backend for the Ensenada Transit MVP. This service uses HTTP polling first, stores only the latest known location per bus, and keeps short in-memory history for route progress and ETA estimates.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Scripts

```bash
npm run dev       # Start local development server
npm run build     # Compile TypeScript to dist/
npm start         # Run compiled server
npm run typecheck # Type-check without emitting files
```

## Environment

```bash
PORT=3000
CORS_ORIGIN=*
LOCATION_TTL_SECONDS=90
```

## Health check

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "ensenada-transit-location-service"
}
```

## Update live location

```bash
curl -X POST http://localhost:3000/locations/update \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "driver-123",
    "sourceType": "driver",
    "busId": "bus-123",
    "routeId": "ruta-violeta",
    "routeVariantId": "ruta_violeta_ida",
    "routeVariantDirection": "ida",
    "latitude": 31.8667,
    "longitude": -116.5964,
    "accuracy": 12,
    "speed": 8.5,
    "heading": 120,
    "timestamp": 1710000000000
  }'
```

On update, the service snaps the bus to the matching route variant GeoJSON when available and enriches the live bus with:

- `routeProgressMeters`
- `snappedLatitude`
- `snappedLongitude`
- `distanceFromRouteMeters`
- `avgSpeedMps`
- `isStopped`
- `directionConfidence`
- `etaConfidence`

`accuracy`, `speed`, and `heading` are optional. If a mobile client sends any of them as `null`, the service treats the field as omitted. When `speed` is provided, it must be greater than or equal to `0`; when `heading` is provided, it must be between `0` and `360`.

## Supported route variants

- Acapulco
  - `acapulco_ida`
  - `acapulco_vuelta`
- Ruta Violeta
  - `ruta_violeta_ida`
  - `ruta_violeta_vuelta`
- Libramiento Norte Rojo
  - `libramiento_norte_rojo_ida`
  - `libramiento_norte_rojo_vuelta`
- Aguilas 89
  - `aguilas_89_ida`
  - `aguilas_89_vuelta`
- AMP Indeco
  - `amp_indeco_ida`
  - `amp_indeco_vuelta`

## Get live buses by route variant

```bash
curl http://localhost:3000/routes/ruta_violeta_ida/live
```

Include stale buses:

```bash
curl "http://localhost:3000/routes/ruta_violeta_ida/live?includeStale=true"
```

## Get all live buses

```bash
curl http://localhost:3000/buses/live
```

Include stale buses:

```bash
curl "http://localhost:3000/buses/live?includeStale=true"
```

## Get route ETA

```bash
curl "http://localhost:3000/routes/ruta_violeta_ida/eta?userLat=31.8700&userLng=-116.5900"
```

With destination:

```bash
curl "http://localhost:3000/routes/ruta_violeta_ida/eta?userLat=31.8700&userLng=-116.5900&destLat=31.8760&destLng=-116.5845"
```

Include stale buses:

```bash
curl "http://localhost:3000/routes/ruta_violeta_ida/eta?userLat=31.8700&userLng=-116.5900&includeStale=true"
```

The ETA endpoint:

- Requires `userLat` and `userLng`.
- Accepts optional `destLat` and `destLng`, but they must be sent together.
- Snaps the user and optional destination to the route variant polyline.
- Returns only viable buses behind the user along the route direction.
- Excludes stale buses unless `includeStale=true`.

## Manual ETA test

Send a few increasing points for the same bus:

```bash
curl -X POST http://localhost:3000/locations/update \
  -H "Content-Type: application/json" \
  -d '{"sourceId":"driver-123","sourceType":"driver","busId":"bus-violeta-001","routeId":"ruta-violeta","routeVariantId":"ruta_violeta_ida","routeVariantDirection":"ida","latitude":31.8550,"longitude":-116.6065,"accuracy":12,"speed":5.2,"heading":45,"timestamp":1710000000000}'

curl -X POST http://localhost:3000/locations/update \
  -H "Content-Type: application/json" \
  -d '{"sourceId":"driver-123","sourceType":"driver","busId":"bus-violeta-001","routeId":"ruta-violeta","routeVariantId":"ruta_violeta_ida","routeVariantDirection":"ida","latitude":31.8600,"longitude":-116.6010,"accuracy":12,"speed":5.4,"heading":45,"timestamp":1710000060000}'

curl -X POST http://localhost:3000/locations/update \
  -H "Content-Type: application/json" \
  -d '{"sourceId":"driver-123","sourceType":"driver","busId":"bus-violeta-001","routeId":"ruta-violeta","routeVariantId":"ruta_violeta_ida","routeVariantDirection":"ida","latitude":31.8667,"longitude":-116.5964,"accuracy":12,"speed":5.6,"heading":45,"timestamp":1710000120000}'
```

Confirm progress and speed:

```bash
curl http://localhost:3000/routes/ruta_violeta_ida/live
```

Call ETA with a user ahead of the bus:

```bash
curl "http://localhost:3000/routes/ruta_violeta_ida/eta?userLat=31.8700&userLng=-116.5900&destLat=31.8760&destLng=-116.5845"
```

Call ETA with a user behind the bus. The bus should be excluded:

```bash
curl "http://localhost:3000/routes/ruta_violeta_ida/eta?userLat=31.8600&userLng=-116.6010"
```

## Architecture notes

- This is an HTTP polling MVP.
- There are no WebSockets yet.
- The service stores only the latest location per `busId`.
- The service keeps only the latest 10 history points per bus and only for the last 5 minutes.
- Route variant files live in `src/data/geojson/` and should be replaced with precise production route polylines when ready.
- The in-memory `Map` storage is intentionally simple and cheap to operate.
- The mobile app can call `POST /locations/update` every 30-60 seconds.
- The passenger app can call `GET /routes/:routeVariantId/live` every 15-30 seconds.
- The frontend should interpolate bus movement visually between polling responses.

## Future upgrade path

1. Replace the in-memory `Map` with Redis and native TTL behavior.
2. Add WebSocket updates only for active route viewers.
3. Add PostGIS for route snapping and progress matching.
4. Add analytics snapshots every 1-5 minutes instead of saving every coordinate.
