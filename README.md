# Ensenada Transit Location Service

Lightweight Node.js + Express backend for the Ensenada Transit MVP. This service uses HTTP polling first and stores only the latest known location per bus in memory.

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

## Architecture notes

- This is an HTTP polling MVP.
- There are no WebSockets yet.
- The service stores only the latest location per `busId`.
- The in-memory `Map` is intentionally simple and cheap to operate.
- The mobile app can call `POST /locations/update` every 30-60 seconds.
- The passenger app can call `GET /routes/:routeVariantId/live` every 15-30 seconds.
- The frontend should interpolate bus movement visually between polling responses.

## Future upgrade path

1. Replace the in-memory `Map` with Redis and native TTL behavior.
2. Add WebSocket updates only for active route viewers.
3. Add PostGIS for route snapping and progress matching.
4. Add analytics snapshots every 1-5 minutes instead of saving every coordinate.
