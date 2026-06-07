# Ensenada Transit Server

Full-featured Node.js + Express backend for the Ensenada Transit app. Handles authentication, user profiles, route data, real-time bus tracking, favorites, incident reports, and driver sessions — all backed by PostgreSQL and Redis.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [npm Scripts](#npm-scripts)
- [API Response Format](#api-response-format)
- [Authentication](#authentication)
- [Users Module](#users-module)
- [Routes Module](#routes-module)
- [Favorites Module](#favorites-module)
- [Reports Module](#reports-module)
- [Driver Sessions Module](#driver-sessions-module)
- [Tracking Module](#tracking-module)
- [Security](#security)
- [Database Schema](#database-schema)
- [Redis Cache](#redis-cache)
- [Deployment on Railway](#deployment-on-railway)
- [Development Guide](#development-guide)
- [Contributing](#contributing)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Language | TypeScript 5 |
| Database | PostgreSQL 15+ (via `pg`) |
| Cache / Rate limiting | Redis 7+ (via `redis` v4) |
| Auth | JWT (`jsonwebtoken`) + bcrypt |
| Process manager | `ts-node-dev` (dev), compiled JS (prod) |

**Key features:**

- Email, social (Google/Apple), and guest authentication
- JWT-based auth with 7-day expiration and token refresh
- Redis-backed rate limiting (5 req/min auth, 100 req/min API)
- Route and variant data with Redis caching (5–10 min TTL)
- Real-time bus tracking with route snapping and ETA calculation
- Favorites for routes and stops
- User incident reports (crowded, breakdown, delay, other)
- Driver session management
- Graceful shutdown on SIGTERM/SIGINT

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+

### Installation

```bash change
git clone https://github.com/andresbe/ensenada-transit-server.git
cd ensenada-transit-server
npm install
```

### Environment setup

```bash
cp .env.example .env
# Edit .env with your database and Redis credentials
```

### Run migrations

```bash
npm run migrate
```

This executes `src/db/migrations/001_init_schema.sql` against your `DATABASE_URL`. The migration is idempotent (`CREATE TABLE IF NOT EXISTS`) and safe to run multiple times.

### Start development server

```bash
npm run dev
```

The server starts on `http://localhost:3000` with hot reload via `ts-node-dev`.

### Verify it's running

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "service": "ensenada-transit-server",
  "version": "1.0.0"
}
```

---

## Project Structure

```
ensenada-transit-server/
├── src/
│   ├── app.ts                        # Express app setup, middleware, route mounting
│   ├── server.ts                     # HTTP server, graceful shutdown
│   ├── config/
│   │   └── env.ts                    # Typed environment variable parsing
│   ├── db/
│   │   ├── index.ts                  # PostgreSQL connection pool
│   │   └── migrations/
│   │       └── 001_init_schema.sql   # Full database schema
│   ├── redis/
│   │   ├── client.ts                 # Redis client with reconnect strategy
│   │   └── cache.ts                  # Cache helpers, keys, TTLs, rate limiting
│   ├── auth/
│   │   ├── auth.routes.ts            # POST /auth/* route definitions
│   │   ├── auth.controller.ts        # Request handlers
│   │   ├── auth.service.ts           # register, login, socialAuth, guestAuth, refreshToken
│   │   ├── auth.middleware.ts        # authMiddleware, adminMiddleware, driverMiddleware
│   │   └── validators.ts             # Input validation for register/login
│   ├── users/
│   │   ├── users.routes.ts           # GET/PATCH /users/me
│   │   └── users.service.ts          # getUserById, updateUser, updatePreferences
│   ├── routes/
│   │   ├── routes.routes.ts          # GET/POST /db-routes/* (mounted at /db-routes)
│   │   └── routes.service.ts         # getAllRoutes, getRouteById, getVariant, createRoute, createVariant
│   ├── favorites/
│   │   └── favorites.routes.ts       # GET/POST/DELETE /favorites/routes and /favorites/stops
│   ├── reports/
│   │   └── reports.routes.ts         # POST /reports, GET /reports/my
│   ├── driver-sessions/
│   │   └── driverSessions.routes.ts  # POST /driver-sessions/start and /:sessionId/end
│   ├── tracking/
│   │   └── locations.routes.ts       # POST /locations/update, GET /buses/live, GET /routes/:id/live
│   ├── modules/
│   │   ├── locations/                # In-memory location service, validation, types
│   │   └── routes/                   # Legacy GeoJSON route geometry + ETA endpoints
│   ├── middleware/
│   │   ├── errorHandler.ts           # asyncHandler wrapper, global error handler
│   │   └── rateLimiter.ts            # Redis-backed rate limiter factory
│   ├── shared/
│   │   ├── errors.ts                 # AppError class, notFoundHandler, errorHandler
│   │   └── response.ts               # sendSuccess, sendError helpers
│   ├── types/
│   │   └── index.ts                  # Shared TypeScript interfaces and types
│   └── data/
│       └── geojson/                  # Route polyline GeoJSON files (10 variants)
├── package.json
├── tsconfig.json
└── README.md
```

> **Note on route mounting:** The database-backed routes module is mounted at `/db-routes` in `app.ts` (not `/routes`) to avoid a path conflict with the legacy in-memory GeoJSON routes mounted at `/routes`. All documentation below uses the correct paths.

---

## Environment Variables

Create a `.env` file at the project root. All variables are read at startup via `dotenv`.

```bash
# ── Server ────────────────────────────────────────────────────
PORT=3000                          # HTTP port (default: 3000)
NODE_ENV=development               # development | production

# ── CORS ──────────────────────────────────────────────────────
CORS_ORIGIN=*                      # Allowed origin(s) for CORS (default: *)

# ── PostgreSQL ────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/ensenada_transit
                                   # Full connection string (required)

# ── Redis ─────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379   # Redis connection URL (default: redis://localhost:6379)

# ── JWT ───────────────────────────────────────────────────────
JWT_SECRET=change_me_in_production # Secret key for signing JWTs (required in production)
JWT_EXPIRES_IN=7d                  # Token expiration (default: 7d)

# ── Tracking ──────────────────────────────────────────────────
LOCATION_TTL_SECONDS=90            # How long a bus location is considered fresh (default: 90)
```

**Required in production:** `DATABASE_URL`, `JWT_SECRET`

**Optional with defaults:** `PORT`, `NODE_ENV`, `CORS_ORIGIN`, `REDIS_URL`, `JWT_EXPIRES_IN`, `LOCATION_TTL_SECONDS`

> The app starts even if Redis is unavailable. Rate limiting and bus location caching degrade gracefully — Redis errors are logged and the request is allowed through.

---

## npm Scripts

```bash
npm run dev          # Start development server with hot reload (ts-node-dev)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled server from dist/server.js
npm run migrate      # Run SQL migrations against DATABASE_URL
npm run lint         # Run ESLint on src/**/*.ts
npm run type-check   # Type-check without emitting files (tsc --noEmit)
```

---

## API Response Format

### Success response

All successful responses return the data directly at the top level (no wrapper envelope):

```json
{
  "user": { ... },
  "token": "eyJ..."
}
```

or for collections:

```json
{
  "routes": [ ... ]
}
```

HTTP status codes used:

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created |
| `400` | Bad Request (validation error) |
| `401` | Unauthorized (missing or invalid token) |
| `403` | Forbidden (insufficient role) |
| `404` | Not Found |
| `409` | Conflict (e.g. duplicate email) |
| `429` | Too Many Requests (rate limited) |
| `500` | Internal Server Error |

### Error response

```json
{
  "error": {
    "message": "Human-readable description of what went wrong.",
    "details": { }
  }
}
```

`details` is only present when additional context is available.

### Rate limit error (429)

```json
{
  "error": {
    "message": "Too many requests. Please try again later.",
    "retryAfterSeconds": 60
  }
}
```

---

## Authentication

All auth endpoints are rate-limited to **5 requests per 60 seconds** per IP.

Base path: `/auth`

---

### POST /auth/register

Create a new account with email and password.

**Request body:**

```json
{
  "email": "ana@example.com",
  "password": "securepassword",
  "display_name": "Ana García"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | Yes | Must be a valid email address |
| `password` | string | Yes | Minimum 8 characters |
| `display_name` | string | No | Optional display name |

**Response `201`:**

```json
{
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "email": "ana@example.com",
    "display_name": "Ana García",
    "photo_url": null,
    "auth_provider": "email",
    "role": "user",
    "status": "active",
    "created_at": "2024-06-01T10:00:00.000Z",
    "updated_at": "2024-06-01T10:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

A `user_preferences` row is automatically created with default values on registration.

**Errors:**

- `400` — email or password validation failed
- `409` — an account with this email already exists

---

### POST /auth/login

Authenticate with email and password.

**Request body:**

```json
{
  "email": "ana@example.com",
  "password": "securepassword"
}
```

**Response `200`:**

```json
{
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "email": "ana@example.com",
    "display_name": "Ana García",
    "photo_url": null,
    "auth_provider": "email",
    "role": "user",
    "status": "active",
    "created_at": "2024-06-01T10:00:00.000Z",
    "updated_at": "2024-06-01T10:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Errors:**

- `400` — missing or invalid fields
- `401` — invalid email or password, or account is not active

---

### POST /auth/social

Sign in or register via Google or Apple. In the current MVP the `provider_token` is accepted as-is (provider verification against Google/Apple APIs is a planned upgrade). The user is upserted by email.

**Request body:**

```json
{
  "provider": "google",
  "provider_token": "id-token-from-google-sdk",
  "email": "ana@example.com",
  "display_name": "Ana García",
  "photo_url": "https://example.com/photo.jpg"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `provider` | string | Yes | `"google"` or `"apple"` |
| `provider_token` | string | Yes | Token from the provider SDK |
| `email` | string | Yes | Used to upsert the user |
| `display_name` | string | No | |
| `photo_url` | string | No | |

**Response `200`:**

```json
{
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "email": "ana@example.com",
    "display_name": "Ana García",
    "photo_url": "https://example.com/photo.jpg",
    "auth_provider": "google",
    "role": "user",
    "status": "active",
    "created_at": "2024-06-01T10:00:00.000Z",
    "updated_at": "2024-06-01T10:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Errors:**

- `400` — invalid provider, missing provider_token, or missing email

---

### POST /auth/guest

Create an anonymous guest account. No body required.

**Response `201`:**

```json
{
  "user": {
    "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "email": null,
    "display_name": null,
    "photo_url": null,
    "auth_provider": "guest",
    "role": "user",
    "status": "active",
    "created_at": "2024-06-01T10:05:00.000Z",
    "updated_at": "2024-06-01T10:05:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### POST /auth/refresh

Exchange a valid (non-expired) JWT for a fresh one. Useful for extending sessions without re-login.

**Request body:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response `200`:**

```json
{
  "user": { ... },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Errors:**

- `400` — token field missing
- `401` — token is invalid, expired, or user is inactive

---

### JWT token format

The JWT payload contains:

```json
{
  "sub": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "email": "ana@example.com",
  "role": "user",
  "iat": 1717228800,
  "exp": 1717833600
}
```

Include the token in all authenticated requests:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## Users Module

All endpoints require a valid JWT (`Authorization: Bearer <token>`). Rate limited to **100 req/min** per IP.

Base path: `/users`

---

### GET /users/me

Retrieve the authenticated user's profile.

**Response `200`:**

```json
{
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "email": "ana@example.com",
    "display_name": "Ana García",
    "photo_url": null,
    "auth_provider": "email",
    "role": "user",
    "status": "active",
    "created_at": "2024-06-01T10:00:00.000Z",
    "updated_at": "2024-06-01T10:00:00.000Z"
  }
}
```

---

### PATCH /users/me

Update the authenticated user's profile and/or preferences. All fields are optional — only provided fields are updated.

**Request body:**

```json
{
  "display_name": "Ana G.",
  "photo_url": "https://cdn.example.com/avatars/ana.jpg",
  "preferences": {
    "language": "en",
    "push_notifications_enabled": true,
    "favorite_route_alerts": false
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `display_name` | string | Optional |
| `photo_url` | string | Optional |
| `preferences.language` | string | Optional, e.g. `"es"`, `"en"` |
| `preferences.push_notifications_enabled` | boolean | Optional |
| `preferences.favorite_route_alerts` | boolean | Optional |

**Response `200`:**

```json
{
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "email": "ana@example.com",
    "display_name": "Ana G.",
    "photo_url": "https://cdn.example.com/avatars/ana.jpg",
    "auth_provider": "email",
    "role": "user",
    "status": "active",
    "created_at": "2024-06-01T10:00:00.000Z",
    "updated_at": "2024-06-01T11:00:00.000Z"
  },
  "preferences": {
    "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "language": "en",
    "push_notifications_enabled": true,
    "favorite_route_alerts": false,
    "updated_at": "2024-06-01T11:00:00.000Z"
  }
}
```

`preferences` is only present in the response when a `preferences` object was included in the request body.

---

## Routes Module

Public read endpoints (no auth required). Admin write endpoints require `role: "admin"`. Rate limited to **100 req/min** per IP.

> **Important:** The database-backed routes module is mounted at `/db-routes` in the application. Use `/db-routes` as the base path for all endpoints in this section.

Base path: `/db-routes`

Route data is cached in Redis. Cache is populated on first request and expires automatically.

---

### GET /db-routes

List all active routes.

**Response `200`:**

```json
{
  "routes": [
    {
      "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "name": "Ruta Violeta",
      "short_name": "Violeta",
      "color": "#8B5CF6",
      "text_color": "#FFFFFF",
      "active": true,
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

Cached for **5 minutes** under key `routes:all`.

---

### GET /db-routes/:routeId

Get a single route with all its variants.

**Response `200`:**

```json
{
  "route": {
    "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
    "name": "Ruta Violeta",
    "short_name": "Violeta",
    "color": "#8B5CF6",
    "text_color": "#FFFFFF",
    "active": true,
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z",
    "variants": [
      {
        "id": "d4e5f6a7-b8c9-0123-defa-234567890123",
        "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
        "name": "Ruta Violeta Ida",
        "direction": "ida",
        "coordinates": [[-116.6065, 31.8550], [-116.5964, 31.8667]],
        "total_distance_meters": 4200.50,
        "created_at": "2024-01-01T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

Cached for **5 minutes** under key `routes:{routeId}`.

**Errors:**

- `404` — route not found

---

### GET /db-routes/:routeId/variants/:variantId

Get a single route variant with its ordered stops.

**Response `200`:**

```json
{
  "variant": {
    "id": "d4e5f6a7-b8c9-0123-defa-234567890123",
    "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
    "name": "Ruta Violeta Ida",
    "direction": "ida",
    "coordinates": [[-116.6065, 31.8550], [-116.5964, 31.8667]],
    "total_distance_meters": 4200.50,
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z",
    "stops": [
      {
        "id": "e5f6a7b8-c9d0-1234-efab-345678901234",
        "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
        "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
        "name": "Terminal Centro",
        "latitude": 31.8550,
        "longitude": -116.6065,
        "sequence": 1,
        "created_at": "2024-01-01T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

Cached for **10 minutes** under key `variants:{variantId}`.

**Errors:**

- `404` — variant not found or does not belong to the given route

---

### POST /db-routes

**Requires:** `role: "admin"`

Create a new route.

**Request body:**

```json
{
  "name": "Ruta Azul",
  "short_name": "Azul",
  "color": "#3B82F6",
  "text_color": "#FFFFFF"
}
```

| Field | Type | Required | Default |
|---|---|---|---|
| `name` | string | Yes | — |
| `short_name` | string | Yes | — |
| `color` | string | No | `"#000000"` |
| `text_color` | string | No | `"#FFFFFF"` |

**Response `201`:**

```json
{
  "route": {
    "id": "f6a7b8c9-d0e1-2345-fabc-456789012345",
    "name": "Ruta Azul",
    "short_name": "Azul",
    "color": "#3B82F6",
    "text_color": "#FFFFFF",
    "active": true,
    "created_at": "2024-06-01T12:00:00.000Z",
    "updated_at": "2024-06-01T12:00:00.000Z"
  }
}
```

**Errors:**

- `400` — name or short_name missing
- `401` — not authenticated
- `403` — not an admin

---

### POST /db-routes/:routeId/variants

**Requires:** `role: "admin"`

Add a variant to an existing route.

**Request body:**

```json
{
  "name": "Ruta Azul Ida",
  "direction": "ida",
  "coordinates": [[-116.6065, 31.8550], [-116.5964, 31.8667]],
  "total_distance_meters": 4200.50
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | Yes | |
| `direction` | string | Yes | `"ida"` or `"vuelta"` |
| `coordinates` | array | No | Array of `[lng, lat]` pairs |
| `total_distance_meters` | number | No | Defaults to `0` |

**Response `201`:**

```json
{
  "variant": {
    "id": "a7b8c9d0-e1f2-3456-abcd-567890123456",
    "route_id": "f6a7b8c9-d0e1-2345-fabc-456789012345",
    "name": "Ruta Azul Ida",
    "direction": "ida",
    "coordinates": [[-116.6065, 31.8550], [-116.5964, 31.8667]],
    "total_distance_meters": 4200.50,
    "created_at": "2024-06-01T12:05:00.000Z",
    "updated_at": "2024-06-01T12:05:00.000Z"
  }
}
```

**Errors:**

- `400` — name missing or direction not `"ida"`/`"vuelta"`
- `401` — not authenticated
- `403` — not an admin
- `404` — route not found

---

## Favorites Module

All endpoints require a valid JWT. Rate limited to **100 req/min** per IP.

Base path: `/favorites`

---

### GET /favorites/routes

List the authenticated user's favorite routes.

**Response `200`:**

```json
{
  "routes": [
    {
      "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "name": "Ruta Violeta",
      "short_name": "Violeta",
      "color": "#8B5CF6",
      "text_color": "#FFFFFF",
      "active": true,
      "favorited_at": "2024-06-01T09:00:00.000Z"
    }
  ]
}
```

---

### POST /favorites/routes

Add a route to favorites. Silently ignores duplicates.

**Request body:**

```json
{
  "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012"
}
```

**Response `201`:**

```json
{
  "message": "Route added to favorites."
}
```

**Errors:**

- `400` — route_id missing

---

### DELETE /favorites/routes/:routeId

Remove a route from favorites. Returns success even if the route was not favorited.

**Response `200`:**

```json
{
  "message": "Route removed from favorites."
}
```

---

### GET /favorites/stops

List the authenticated user's favorite stops.

**Response `200`:**

```json
{
  "stops": [
    {
      "id": "e5f6a7b8-c9d0-1234-efab-345678901234",
      "name": "Terminal Centro",
      "latitude": 31.8550,
      "longitude": -116.6065,
      "sequence": 1,
      "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
      "favorited_at": "2024-06-01T09:30:00.000Z"
    }
  ]
}
```

---

### POST /favorites/stops

Add a stop to favorites. Silently ignores duplicates.

**Request body:**

```json
{
  "stop_id": "e5f6a7b8-c9d0-1234-efab-345678901234"
}
```

**Response `201`:**

```json
{
  "message": "Stop added to favorites."
}
```

**Errors:**

- `400` — stop_id missing

---

### DELETE /favorites/stops/:stopId

Remove a stop from favorites. Returns success even if the stop was not favorited.

**Response `200`:**

```json
{
  "message": "Stop removed from favorites."
}
```

---

## Reports Module

All endpoints require a valid JWT. Rate limited to **100 req/min** per IP.

Base path: `/reports`

---

### POST /reports

Submit an incident report.

**Request body:**

```json
{
  "type": "crowded",
  "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
  "bus_id": "bus-violeta-001",
  "message": "Standing room only, very crowded.",
  "latitude": 31.8667,
  "longitude": -116.5964
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | Yes | `"crowded"`, `"breakdown"`, `"delay"`, or `"other"` |
| `route_id` | string | No | UUID of the affected route |
| `variant_id` | string | No | UUID of the affected variant |
| `bus_id` | string | No | Identifier of the specific bus |
| `message` | string | No | Free-text description |
| `latitude` | number | No | Location of the incident |
| `longitude` | number | No | Location of the incident |

**Response `201`:**

```json
{
  "report": {
    "id": "b8c9d0e1-f2a3-4567-bcde-678901234567",
    "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "type": "crowded",
    "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
    "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
    "bus_id": "bus-violeta-001",
    "message": "Standing room only, very crowded.",
    "latitude": 31.8667,
    "longitude": -116.5964,
    "status": "open",
    "created_at": "2024-06-01T14:00:00.000Z",
    "updated_at": "2024-06-01T14:00:00.000Z"
  }
}
```

**Errors:**

- `400` — type is not one of the valid values

---

### GET /reports/my

List all reports submitted by the authenticated user, newest first.

**Response `200`:**

```json
{
  "reports": [
    {
      "id": "b8c9d0e1-f2a3-4567-bcde-678901234567",
      "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "type": "crowded",
      "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
      "bus_id": "bus-violeta-001",
      "message": "Standing room only, very crowded.",
      "latitude": 31.8667,
      "longitude": -116.5964,
      "status": "open",
      "created_at": "2024-06-01T14:00:00.000Z",
      "updated_at": "2024-06-01T14:00:00.000Z"
    }
  ]
}
```

---

## Driver Sessions Module

All endpoints require a valid JWT with `role: "driver"` or `role: "admin"`. Rate limited to **100 req/min** per IP.

Base path: `/driver-sessions`

---

### POST /driver-sessions/start

Start a new driving session. Any existing active session for the same driver is automatically ended before the new one is created.

**Request body:**

```json
{
  "bus_id": "bus-violeta-001",
  "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `bus_id` | string | Yes | Identifier for the physical bus |
| `route_id` | string | No | UUID of the route being driven |
| `variant_id` | string | No | UUID of the specific variant |

**Response `201`:**

```json
{
  "session": {
    "id": "c9d0e1f2-a3b4-5678-cdef-789012345678",
    "driver_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "bus_id": "bus-violeta-001",
    "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
    "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
    "status": "active",
    "started_at": "2024-06-01T08:00:00.000Z",
    "ended_at": null,
    "created_at": "2024-06-01T08:00:00.000Z",
    "updated_at": "2024-06-01T08:00:00.000Z"
  }
}
```

**Errors:**

- `400` — bus_id missing
- `401` — not authenticated
- `403` — not a driver or admin

---

### POST /driver-sessions/:sessionId/end

End an active driving session. Only the driver who owns the session can end it.

**Response `200`:**

```json
{
  "session": {
    "id": "c9d0e1f2-a3b4-5678-cdef-789012345678",
    "driver_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "bus_id": "bus-violeta-001",
    "route_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
    "variant_id": "d4e5f6a7-b8c9-0123-defa-234567890123",
    "status": "ended",
    "started_at": "2024-06-01T08:00:00.000Z",
    "ended_at": "2024-06-01T16:00:00.000Z",
    "created_at": "2024-06-01T08:00:00.000Z",
    "updated_at": "2024-06-01T16:00:00.000Z"
  }
}
```

**Errors:**

- `401` — not authenticated
- `403` — not a driver or admin
- `404` — no active session found with this ID for this driver

---

## Tracking Module

Real-time bus location endpoints. No authentication required for reads. Rate limited to **100 req/min** per IP.

These endpoints maintain full backward compatibility with the original in-memory location service. Location updates are stored in-memory for fast access and also persisted to Redis for cross-process sharing.

---

### POST /locations/update

Report a bus's current location. Called by the driver app every 30–60 seconds.

**Request body:**

```json
{
  "sourceId": "driver-123",
  "sourceType": "driver",
  "busId": "bus-violeta-001",
  "routeId": "ruta-violeta",
  "routeVariantId": "ruta_violeta_ida",
  "routeVariantDirection": "ida",
  "latitude": 31.8667,
  "longitude": -116.5964,
  "accuracy": 12,
  "speed": 8.5,
  "heading": 120,
  "timestamp": 1717228800000
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `sourceId` | string | Yes | Unique ID of the reporting source |
| `sourceType` | string | Yes | `"driver"` or `"user"` |
| `busId` | string | Yes | Unique bus identifier |
| `routeId` | string | Yes | Route identifier |
| `routeVariantId` | string | Yes | Variant identifier (e.g. `"ruta_violeta_ida"`) |
| `routeVariantDirection` | string | Yes | `"ida"` or `"vuelta"` |
| `latitude` | number | Yes | Between -90 and 90 |
| `longitude` | number | Yes | Between -180 and 180 |
| `accuracy` | number | No | Meters; must be ≥ 0 if provided |
| `speed` | number | No | m/s; must be ≥ 0 if provided |
| `heading` | number | No | Degrees 0–360 if provided |
| `timestamp` | number | Yes | Unix timestamp in milliseconds |

**Response `201`:**

```json
{
  "busId": "bus-violeta-001",
  "routeId": "ruta-violeta",
  "routeVariantId": "ruta_violeta_ida",
  "routeVariantDirection": "ida",
  "updatedAt": 1717228800000,
  "routeProgressMeters": 1250.4,
  "snappedLatitude": 31.8668,
  "snappedLongitude": -116.5963,
  "distanceFromRouteMeters": 8.2,
  "avgSpeedMps": 7.1,
  "directionConfidence": "high",
  "etaConfidence": "medium"
}
```

When a matching GeoJSON route variant is available, the service enriches the response with route snapping and progress data. `accuracy`, `speed`, and `heading` are optional — send `null` to omit them.

---

### GET /buses/live

Get all currently active buses across all routes.

**Query parameters:**

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `includeStale` | boolean | `false` | Include buses not updated within `LOCATION_TTL_SECONDS` |

**Response `200`:**

```json
{
  "buses": [
    {
      "busId": "bus-violeta-001",
      "sourceId": "driver-123",
      "sourceType": "driver",
      "routeId": "ruta-violeta",
      "routeVariantId": "ruta_violeta_ida",
      "routeVariantDirection": "ida",
      "latitude": 31.8667,
      "longitude": -116.5964,
      "speed": 8.5,
      "heading": 120,
      "timestamp": 1717228800000,
      "updatedAt": 1717228800000,
      "routeProgressMeters": 1250.4,
      "snappedLatitude": 31.8668,
      "snappedLongitude": -116.5963,
      "distanceFromRouteMeters": 8.2,
      "avgSpeedMps": 7.1,
      "isStopped": false,
      "directionConfidence": "high",
      "etaConfidence": "medium",
      "isStale": false
    }
  ]
}
```

---

### GET /routes/:routeId/live

Get all active buses on a specific route (filtered by `routeId`, not variant).

**Query parameters:**

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `includeStale` | boolean | `false` | Include stale buses |

**Response `200`:**

```json
{
  "routeId": "ruta-violeta",
  "buses": [ ... ]
}
```

---

### Supported route variants (GeoJSON)

The following route variant IDs have GeoJSON polylines available for route snapping:

| Route | Variant IDs |
|---|---|
| Acapulco | `acapulco_ida`, `acapulco_vuelta` |
| Ruta Violeta | `ruta_violeta_ida`, `ruta_violeta_vuelta` |
| Libramiento Norte Rojo | `libramiento_norte_rojo_ida`, `libramiento_norte_rojo_vuelta` |
| Aguilas 89 | `aguilas_89_ida`, `aguilas_89_vuelta` |
| AMP Indeco | `amp_indeco_ida`, `amp_indeco_vuelta` |

---

## Security

### Rate limiting

| Limiter | Endpoints | Limit |
|---|---|---|
| Auth | `/auth/*` | 5 requests / 60 seconds per IP |
| API | All other endpoints | 100 requests / 60 seconds per IP |

Rate limiting is backed by Redis. If Redis is unavailable, the limiter fails open (requests are allowed through) and an error is logged.

### Authentication

- All write endpoints (except `/auth/*` and `/locations/update`) require a valid JWT in the `Authorization: Bearer <token>` header.
- Read endpoints for routes and tracking are public.
- Tokens expire after **7 days** (configurable via `JWT_EXPIRES_IN`).
- Tokens are signed with HS256 using `JWT_SECRET`.

### Role-based access

| Role | Capabilities |
|---|---|
| `user` | Auth, profile, favorites, reports, read routes and tracking |
| `driver` | Everything `user` can do, plus driver sessions and location updates |
| `admin` | Everything `driver` can do, plus creating routes and variants |

### Password security

- Passwords are hashed with **bcrypt** using 12 salt rounds.
- Minimum password length: **8 characters**.
- Password hashes are never returned in API responses.

---

## Database Schema

The schema is defined in `src/db/migrations/001_init_schema.sql`. All tables use UUIDs as primary keys (generated by `pgcrypto`'s `gen_random_uuid()`). All timestamps are `TIMESTAMPTZ`. An `updated_at` trigger fires automatically on every `UPDATE`.

---

### users

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `email` | TEXT | UNIQUE, nullable | Null for guest accounts |
| `password_hash` | TEXT | nullable | Null for social/guest accounts |
| `display_name` | TEXT | nullable | |
| `photo_url` | TEXT | nullable | |
| `auth_provider` | TEXT | NOT NULL, default `'email'` | `email` \| `google` \| `apple` \| `guest` |
| `role` | TEXT | NOT NULL, default `'user'` | `user` \| `driver` \| `admin` |
| `status` | TEXT | NOT NULL, default `'active'` | `active` \| `suspended` \| `deleted` |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | Auto-updated by trigger |

Indexes: `email`, `role`, `status`

---

### user_preferences

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `user_id` | UUID | PK, FK → `users.id` ON DELETE CASCADE | |
| `language` | TEXT | NOT NULL, default `'es'` | |
| `push_notifications_enabled` | BOOLEAN | NOT NULL, default `TRUE` | |
| `favorite_route_alerts` | BOOLEAN | NOT NULL, default `TRUE` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | Auto-updated by trigger |

---

### routes

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `name` | TEXT | NOT NULL | Full route name |
| `short_name` | TEXT | NOT NULL | Abbreviated name |
| `color` | TEXT | NOT NULL, default `'#000000'` | Hex color for map display |
| `text_color` | TEXT | NOT NULL, default `'#FFFFFF'` | Hex color for labels |
| `active` | BOOLEAN | NOT NULL, default `TRUE` | |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | Auto-updated by trigger |

Indexes: `active`

---

### route_variants

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `route_id` | UUID | NOT NULL, FK → `routes.id` ON DELETE CASCADE | |
| `name` | TEXT | NOT NULL | |
| `direction` | TEXT | NOT NULL | `ida` \| `vuelta` |
| `coordinates` | JSONB | NOT NULL, default `'[]'` | Array of `[lng, lat]` pairs |
| `total_distance_meters` | NUMERIC(10,2) | NOT NULL, default `0` | |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | Auto-updated by trigger |

Indexes: `route_id`, `direction`

---

### stops

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `route_id` | UUID | NOT NULL, FK → `routes.id` ON DELETE CASCADE | |
| `variant_id` | UUID | NOT NULL, FK → `route_variants.id` ON DELETE CASCADE | |
| `name` | TEXT | NOT NULL | |
| `latitude` | NUMERIC(10,7) | NOT NULL | |
| `longitude` | NUMERIC(10,7) | NOT NULL | |
| `sequence` | INTEGER | NOT NULL, default `0` | Order along the route |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | Auto-updated by trigger |

Indexes: `route_id`, `variant_id`

---

### favorite_routes

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `user_id` | UUID | PK (composite), FK → `users.id` ON DELETE CASCADE | |
| `route_id` | UUID | PK (composite), FK → `routes.id` ON DELETE CASCADE | |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |

Indexes: `user_id`

---

### favorite_stops

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `user_id` | UUID | PK (composite), FK → `users.id` ON DELETE CASCADE | |
| `stop_id` | UUID | PK (composite), FK → `stops.id` ON DELETE CASCADE | |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |

Indexes: `user_id`

---

### user_reports

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `user_id` | UUID | NOT NULL, FK → `users.id` ON DELETE CASCADE | |
| `type` | TEXT | NOT NULL | `crowded` \| `breakdown` \| `delay` \| `other` |
| `route_id` | UUID | nullable, FK → `routes.id` ON DELETE SET NULL | |
| `variant_id` | UUID | nullable, FK → `route_variants.id` ON DELETE SET NULL | |
| `bus_id` | TEXT | nullable | |
| `message` | TEXT | nullable | |
| `latitude` | NUMERIC(10,7) | nullable | |
| `longitude` | NUMERIC(10,7) | nullable | |
| `status` | TEXT | NOT NULL, default `'open'` | `open` \| `reviewed` \| `resolved` |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | Auto-updated by trigger |

Indexes: `user_id`, `route_id`, `status`

---

### driver_sessions

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `driver_id` | UUID | NOT NULL, FK → `users.id` ON DELETE CASCADE | |
| `bus_id` | TEXT | NOT NULL | |
| `route_id` | UUID | nullable, FK → `routes.id` ON DELETE SET NULL | |
| `variant_id` | UUID | nullable, FK → `route_variants.id` ON DELETE SET NULL | |
| `status` | TEXT | NOT NULL, default `'active'` | `active` \| `ended` |
| `started_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |
| `ended_at` | TIMESTAMPTZ | nullable | Set when session ends |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` | Auto-updated by trigger |

Indexes: `driver_id`, `status`, `bus_id`

---

## Redis Cache

| Key pattern | TTL | Purpose |
|---|---|---|
| `routes:all` | 300 s (5 min) | All active routes list |
| `routes:{routeId}` | 300 s (5 min) | Single route with variants |
| `variants:{variantId}` | 600 s (10 min) | Single variant with stops |
| `bus:location:{busId}` | 90 s (1.5 min) | Latest known bus location |
| `ratelimit:auth:{ip}` | 60 s | Auth rate limit counter per IP |
| `ratelimit:api:{ip}` | 60 s | API rate limit counter per IP |

**Cache invalidation:** Route and variant caches are not explicitly invalidated on write — they expire naturally. For immediate consistency after admin writes, restart the server or wait for TTL expiry.

**Fail-open behavior:** All Redis operations are wrapped in try/catch. If Redis is down, cache misses fall through to PostgreSQL, rate limiting is disabled, and bus location persistence is skipped. The app remains fully functional.

---

## Deployment on Railway

### PostgreSQL

Add a Railway PostgreSQL plugin to your project. Railway automatically injects `DATABASE_URL` as an environment variable. The connection pool uses SSL in production (`NODE_ENV=production`) with `rejectUnauthorized: false` to support Railway's self-signed certificates.

### Redis

Add a Railway Redis plugin to your project. Railway automatically injects `REDIS_URL`. The Redis client connects on startup and retries up to 10 times with exponential backoff (max 3 s between retries).

### Environment variables to set in Railway

```
NODE_ENV=production
JWT_SECRET=<strong-random-secret>
CORS_ORIGIN=https://your-frontend-domain.com
JWT_EXPIRES_IN=7d
LOCATION_TTL_SECONDS=90
```

`DATABASE_URL` and `REDIS_URL` are injected automatically by Railway plugins.

### Build and start commands

Railway detects these from `package.json`:

```
Build command:  npm run build
Start command:  npm start
```

### Health check

Railway can use `GET /health` for health checks. The endpoint returns `200` with:

```json
{
  "status": "ok",
  "service": "ensenada-transit-server",
  "version": "1.0.0"
}
```

### Graceful shutdown

The server listens for `SIGTERM` (sent by Railway during deploys and restarts) and `SIGINT`. On receiving either signal it stops accepting new connections, waits for in-flight requests to complete, then exits cleanly. A 10-second hard timeout forces exit if connections remain open.

---

## Development Guide

### Running locally

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env

# 3. Start PostgreSQL and Redis (e.g. via Docker)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:15
docker run -d -p 6379:6379 redis:7

# 4. Run migrations
npm run migrate

# 5. Start the dev server
npm run dev
```

### Testing endpoints with curl

**Register and capture the token:**

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123","display_name":"Test User"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

**Use the token:**

```bash
curl http://localhost:3000/users/me \
  -H "Authorization: Bearer $TOKEN"
```

**Submit a location update:**

```bash
curl -X POST http://localhost:3000/locations/update \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "driver-001",
    "sourceType": "driver",
    "busId": "bus-violeta-001",
    "routeId": "ruta-violeta",
    "routeVariantId": "ruta_violeta_ida",
    "routeVariantDirection": "ida",
    "latitude": 31.8667,
    "longitude": -116.5964,
    "speed": 8.5,
    "heading": 120,
    "timestamp": 1717228800000
  }'
```

**Get live buses:**

```bash
curl http://localhost:3000/buses/live
curl "http://localhost:3000/buses/live?includeStale=true"
```

### Testing with Postman or Insomnia

1. Import the base URL `http://localhost:3000`
2. Create an environment variable `token` and set it after calling `/auth/login` or `/auth/register`
3. Add a collection-level header `Authorization: Bearer {{token}}` for authenticated requests
4. Set `Content-Type: application/json` on all POST/PATCH requests

### Common issues

**`DATABASE_URL` not set:** The PostgreSQL pool will fail to connect. Set `DATABASE_URL` in your `.env` file.

**Redis connection refused:** The app starts anyway and logs `[app] Redis connection failed on startup`. Rate limiting is disabled and caching falls back to the database. Start Redis or set `REDIS_URL` correctly.

**Migration fails with "already exists":** The migration uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` — it is safe to run multiple times. If you see a different error, check that `DATABASE_URL` points to the correct database.

**`JWT_SECRET` is the default value:** The server logs a warning in production. Always set a strong, unique `JWT_SECRET` in production environments.

**TypeScript errors after pulling changes:** Run `npm run type-check` to see all errors. Run `npm run build` to confirm the compiled output is clean before deploying.

---

## Contributing

### Adding a new endpoint

1. Create or update the route file in the appropriate module directory (e.g. `src/mymodule/mymodule.routes.ts`).
2. Add input validation inline or in a dedicated `validators.ts` file. Throw `AppError` for validation failures.
3. Add business logic to a `*.service.ts` file. Keep route handlers thin.
4. Mount the router in `src/app.ts`.
5. Apply `apiRateLimiter` and `authMiddleware` (and `adminMiddleware` or `driverMiddleware` as needed) to the route.
6. Document the endpoint in this README following the existing format.

### Code structure guidelines

- **Route handlers** should only parse/validate input, call a service function, and call `sendSuccess`. No SQL in route files.
- **Service functions** contain all business logic and database queries. They throw `AppError` for expected failures.
- **Validation** happens at the boundary (route handler or a dedicated validator). Use `AppError` with a `400` status for bad input.
- **Error handling** is centralized in `src/shared/errors.ts`. Use `asyncHandler` to wrap async route handlers so errors propagate to the global handler.
- **Types** shared across modules go in `src/types/index.ts`.

### TypeScript requirements

- Strict mode is enabled (`"strict": true` in `tsconfig.json`). All code must pass `npm run type-check` with zero errors.
- Do not use `any`. Use `unknown` and narrow the type explicitly.
- Run `npm run build` before opening a PR to confirm the compiled output is clean.
