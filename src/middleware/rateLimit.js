// src/middleware/rateLimit.js — límites de velocidad de la Rifa.
//
// - apiLimiter: límite general de la API con express-rate-limit
//   (en memoria por proceso; Railway corre una sola instancia).
// - checkBucket(db, kind, ip, limit): límite atómico en la base
//   de datos para giros y apartados. Una sola sentencia UPSERT
//   sube el contador, así que ni una ráfaga de peticiones en
//   paralelo puede saltarse el límite (el viejo leer-y-escribir
//   perdía conteos en paralelo). La ventana es de 1 minuto.
//   Devuelve { allowed, count }.
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.' },
});

function minuteBucket() {
  const d = new Date();
  return d.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM' (UTC)
}

async function checkBucket(db, kind, ip, limit) {
  const key = `${kind}:${ip}:${minuteBucket()}`;
  const res = await db.query(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = EXCLUDED.window_start
     RETURNING count`,
    [key, minuteBucket()],
  );
  const count = Number(res.rows[0]?.count ?? 1);
  return { allowed: count <= limit, count };
}

module.exports = { apiLimiter, checkBucket };
