-- ============================================================
-- Ensenada Transit - conductores table
-- ============================================================

CREATE TABLE IF NOT EXISTS conductores (
  correo          TEXT NOT NULL,
  password        TEXT NOT NULL,
  nombre_usuario  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conductores_correo ON conductores (correo);
