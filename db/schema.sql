-- db/schema.sql — esquema de la Rifa 500 Mil.
-- Se ejecuta igual en Postgres (Railway) y en SQLite (local);
-- src/db.js crea las mismas tablas con CREATE TABLE IF NOT EXISTS,
-- así que este archivo es la referencia y la fuente de instalaciones
-- nuevas. La base real arranca vacía: 0 apartados, sin clave de admin.

-- Un renglón por número apartado. number es la clave primaria, así
-- que la base misma impide dos nombres en el mismo número aunque
-- dos personas reclamen a la vez.
CREATE TABLE IF NOT EXISTS claims (
  number INTEGER PRIMARY KEY CHECK (number >= 0 AND number <= 99),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clave/valor. Guarda:
-- - admin_key_hash: hash PBKDF2 de la clave de admin (nunca en claro).
-- - admin_failed_attempts: intentos fallidos seguidos de login.
-- - admin_locked_until: ISO de hasta cuándo está bloqueada la zona
--   de admin (5 fallos seguidos = 15 minutos).
-- - admin_session_hash / admin_session_expires: sesión del admin
--   tras un login correcto (válida 60 minutos).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tokens de giro: cada giro del servidor emite uno. Solo sirve para
-- apartar el número exacto que salió en ese giro, una sola vez, y
-- vence a los 10 minutos. Se guarda solo el hash SHA-256 del token;
-- el token en claro solo se entrega una vez, en la respuesta del giro.
CREATE TABLE IF NOT EXISTS draw_tokens (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  number INTEGER NOT NULL CHECK (number >= 0 AND number <= 99),
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contadores de velocidad (rate limit) con incremento atómico:
-- una sola sentencia UPSERT sube el contador, así que ni una ráfaga
-- de peticiones en paralelo puede saltarse el límite.
-- key = "draw:<ip>:<minuto>" o "claim:<ip>:<minuto>".
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_draw_tokens_hash ON draw_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims (created_at);
