// src/routes/draw.js — el sorteo de la ruleta.
//
// POST /api/draw
//   El sorteo lo hace el servidor, solo entre los números libres,
//   con azar criptográfico (crypto.randomInt). Cada giro emite un
//   token secreto de un solo uso, válido 10 minutos, que solo sirve
//   para apartar el número exacto que salió en ese giro.
//   Límite: 20 giros por minuto por IP (conteo atómico en la base).
//   Si no quedan números libres, devuelve number: null.
const express = require('express');
const db = require('../db');
const { newDrawToken, pickFreeNumber, TOKEN_TTL_MS } = require('../security');
const { checkBucket } = require('../middleware/rateLimit');

const router = express.Router();

const DRAW_LIMIT_PER_MINUTE = 20;

router.post('/draw', async (req, res) => {
  try {
    const rl = await checkBucket(db, 'draw', req.ip, DRAW_LIMIT_PER_MINUTE);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: 'Estás girando demasiado rápido. Espera un minuto e inténtalo de nuevo.' });
    }
    const claims = await db.query('SELECT number FROM claims');
    const taken = new Set(claims.rows.map((r) => Number(r.number)));
    const picked = pickFreeNumber(taken);
    if (picked === null) {
      return res.json({ ok: true, number: null, remaining: 0, token: null, expires_in: 0 });
    }
    const { token, tokenHash } = newDrawToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await db.query(
      'INSERT INTO draw_tokens (token_hash, number, expires_at) VALUES ($1, $2, $3)',
      [tokenHash, picked, expiresAt.toISOString()],
    );
    res.json({
      ok: true,
      number: picked,
      remaining: 100 - taken.size,
      token,
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo girar la ruleta.' });
  }
});

module.exports = router;
