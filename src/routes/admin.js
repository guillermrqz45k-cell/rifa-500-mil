// src/routes/admin.js — administración de la rifa.
//
// POST /api/admin/setup { key }
//   Crea la clave de admin, solo la primera vez. La clave se guarda
//   con PBKDF2-HMAC-SHA256 (100.000 iteraciones, sal aleatoria),
//   nunca en texto plano. Longitud: 4 a 64 caracteres.
// POST /api/admin/login { key }
//   Verifica la clave y entrega una sesión de admin (token aleatorio,
//   válido 60 minutos). Tras 5 intentos fallidos seguidos, la zona
//   de admin se bloquea 15 minutos contra fuerza bruta. El bloqueo
//   también frena un login correcto hasta que pase el tiempo.
// POST /api/admin/reset { admin_token }
//   Restablece la rifa: borra todos los números apartados y todos
//   los tokens de giro. La clave de admin sigue creada.
// GET /api/admin/stats?token=... (o cabecera x-admin-token)
//   Contadores del mercado. Nunca devuelve el hash de la clave ni
//   los tokens de giro.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { hashAdminKey, verifyAdminKey, hashToken } = require('../security');

const router = express.Router();

const ADMIN_KEY = 'admin_key_hash';
const FAILED_KEY = 'admin_failed_attempts';
const LOCKED_KEY = 'admin_locked_until';
const SESSION_HASH_KEY = 'admin_session_hash';
const SESSION_EXP_KEY = 'admin_session_expires';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const SESSION_MINUTES = 60;

async function getSetting(key) {
  const row = await db.get('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

async function deleteSetting(key) {
  await db.query('DELETE FROM settings WHERE key = $1', [key]);
}

function parseIntSetting(v, fallback) {
  const n = Number.parseInt(v || '', 10);
  return Number.isInteger(n) ? n : fallback;
}

async function isLocked() {
  const until = await getSetting(LOCKED_KEY);
  if (!until) return false;
  if (new Date(until).getTime() > Date.now()) return true;
  await deleteSetting(LOCKED_KEY);
  await setSetting(FAILED_KEY, '0');
  return false;
}

async function registerFailedAttempt() {
  const n = parseIntSetting(await getSetting(FAILED_KEY), 0) + 1;
  await setSetting(FAILED_KEY, String(n));
  if (n >= MAX_FAILED_ATTEMPTS) {
    await setSetting(LOCKED_KEY, new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString());
    return true; // quedó bloqueado
  }
  return false;
}

async function verifySession(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  const storedHash = await getSetting(SESSION_HASH_KEY);
  const expires = await getSetting(SESSION_EXP_KEY);
  if (!storedHash || !expires) return false;
  if (new Date(expires).getTime() <= Date.now()) return false;
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function readToken(req) {
  return req.headers['x-admin-token'] || req.query.token || (req.body && req.body.admin_token) || '';
}

router.post('/setup', async (req, res) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (key.length < 4 || key.length > 64) {
      return res.status(400).json({ ok: false, error: 'La clave debe tener entre 4 y 64 caracteres.' });
    }
    const existing = await getSetting(ADMIN_KEY);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'La clave de admin ya fue creada.' });
    }
    await setSetting(ADMIN_KEY, hashAdminKey(key));
    await setSetting(FAILED_KEY, '0');
    res.json({ ok: true, error: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo crear la clave.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key) return res.status(400).json({ ok: false, error: 'Escribe la clave de admin.' });
    const stored = await getSetting(ADMIN_KEY);
    if (!stored) {
      return res.status(400).json({ ok: false, error: 'Primero crea la clave de admin.' });
    }
    if (await isLocked()) {
      return res.status(423).json({ ok: false, error: `Zona de admin bloqueada por ${LOCK_MINUTES} minutos tras varios intentos fallidos. Inténtalo más tarde.` });
    }
    if (!verifyAdminKey(key, stored)) {
      const justLocked = await registerFailedAttempt();
      if (justLocked) {
        return res.status(423).json({ ok: false, error: `Clave incorrecta. Zona de admin bloqueada por ${LOCK_MINUTES} minutos tras ${MAX_FAILED_ATTEMPTS} intentos fallidos.` });
      }
      return res.status(401).json({ ok: false, error: 'Clave de admin incorrecta.' });
    }
    await setSetting(FAILED_KEY, '0');
    await deleteSetting(LOCKED_KEY);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await setSetting(SESSION_HASH_KEY, hashToken(sessionToken));
    await setSetting(SESSION_EXP_KEY, new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString());
    res.json({ ok: true, admin_token: sessionToken, expires_in: SESSION_MINUTES * 60 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo iniciar sesión como admin.' });
  }
});

router.post('/reset', async (req, res) => {
  try {
    const token = readToken(req);
    if (!(await verifySession(token))) {
      return res.status(401).json({ ok: false, error: 'Sesión de admin no válida. Inicia sesión con la clave de admin.' });
    }
    await db.query('DELETE FROM claims');
    await db.query('DELETE FROM draw_tokens');
    res.json({ ok: true, error: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo restablecer la rifa.' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const token = readToken(req);
    if (!(await verifySession(token))) {
      return res.status(401).json({ ok: false, error: 'Sesión de admin no válida. Inicia sesión con la clave de admin.' });
    }
    const claims = await db.query('SELECT COUNT(*) AS c FROM claims');
    const tokens = await db.query('SELECT COUNT(*) AS c FROM draw_tokens WHERE used = FALSE');
    const taken = Number(claims.rows[0]?.c ?? 0);
    res.json({
      ok: true,
      total: 100,
      taken,
      free: 100 - taken,
      raised: taken * 10000,
      active_draw_tokens: Number(tokens.rows[0]?.c ?? 0),
      admin_locked: await isLocked(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudieron leer las estadísticas.' });
  }
});

module.exports = router;
