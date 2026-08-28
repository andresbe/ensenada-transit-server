// ── User ──────────────────────────────────────────────────────

export type AuthProvider = "email" | "google" | "apple" | "guest";
export type UserRole = "user" | "driver" | "admin";
export type UserStatus = "active" | "suspended" | "deleted";

export interface User {
  id: string;
  email: string | null;
  display_name: string | null;
  photo_url: string | null;
  auth_provider: AuthProvider;
  role: UserRole;
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
}

export interface UserWithHash extends User {
  password_hash: string | null;
}

export interface UserPreferences {
  user_id: string;
  language: string;
  push_notifications_enabled: boolean;
  favorite_route_alerts: boolean;
  updated_at: Date;
}

// ── Route ─────────────────────────────────────────────────────

export interface Route {
  id: string;
  name: string;
  short_name: string;
  color: string;
  text_color: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RouteVariant {
  id: string;
  route_id: string;
  name: string;
  direction: "ida" | "vuelta";
  coordinates: [number, number][];
  total_distance_meters: number;
  created_at: Date;
  updated_at: Date;
}

export interface Stop {
  id: string;
  route_id: string;
  variant_id: string;
  name: string;
  latitude: number;
  longitude: number;
  sequence: number;
  created_at: Date;
  updated_at: Date;
}

// ── Bus location ──────────────────────────────────────────────

export interface BusLocation {
  busId: string;
  routeId: string;
  routeVariantId: string;
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  accuracy?: number;
  timestamp: number;
  updatedAt: number;
}

// ── Driver session ────────────────────────────────────────────

export type DriverSessionStatus = "active" | "ended";

export interface DriverSession {
  id: string;
  driver_id: string;
  bus_id: string;
  route_id: string | null;
  variant_id: string | null;
  status: DriverSessionStatus;
  started_at: Date;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ── User report ───────────────────────────────────────────────

export type ReportType = "crowded" | "breakdown" | "delay" | "other";
export type ReportStatus = "open" | "reviewed" | "resolved";

export interface UserReport {
  id: string;
  user_id: string;
  type: ReportType;
  route_id: string | null;
  variant_id: string | null;
  bus_id: string | null;
  message: string | null;
  latitude: number | null;
  longitude: number | null;
  status: ReportStatus;
  created_at: Date;
  updated_at: Date;
}

// ── JWT ───────────────────────────────────────────────────────

export interface JWTPayload {
  sub: string;       // user id
  email: string | null;
  role: UserRole;
  iat?: number;
  exp?: number;
}
