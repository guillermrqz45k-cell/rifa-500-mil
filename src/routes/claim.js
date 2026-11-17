// src/routes/claim.js — apartar el número sorteado.
//
// POST /api/claim { number, name, token }
//   Solo se puede apartar el número exacto que salió en el giro,
//   con el token de ese giro, antes de 10 minutos y una sola vez.
//   - Token falso, vencido o ya usado: rechazado.
//   - Token de otro número: rechazado (no se puede firmar un número
//     distinto al sorteado).
//   - Número ya apartado por otra persona: rechazado; la restricción
//     UNIQUE de claims.number es la última defensa si dos personas
//     reclaman a la vez.
//   El nombre se limpia en el servidor (sin HTML ni caracteres de
//   control/invisibles). Límite: 20 apartados por minuto por IP.
const express = require('express');
const db = require('../db');
const {
  cleanName,
  hashToken,
  isValidNumber,
  isValidTokenFormat,
} = require('../security');
const { checkBucket } = require('../middleware/rateLimit');

const router = express.Router();

const CLAIM_LIMIT_PER_MINUTE = 20;

router.post('/claim', async (req, res) => {
  try {
    const rl = await checkBucket(db, 'claim', req.ip, CLAIM_LIMIT_PER_MINUTE);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: 'Demasiadas peticiones. Espera un minuto e inténtalo de nuevo.' });
    }

    const number = Number(req.body && req.body.number);
    const token = req.body && req.body.token;
    if (!isValidNumber(number)) {
      return res.status(400).json({ ok: false, error: 'Número inválido.' });
    }
    if (!isValidTokenFormat(token)) {
      return res.status(400).json({ ok: false, error: 'Gira la ruleta primero para apartar un número.' });
    }
    const name = cleanName(req.body && req.body.name);
    if (name.length < 2) {
      return res.status(400).json({ ok: false, error: 'Escribe tu nombre (mínimo 2 letras).' });
    }

    // El token se consume en cualquier intento: si el número no
    // coincide o ya está apartado, el token queda usado y hay que
    // girar de nuevo. Así nadie puede probar números con un token.
    const tokenRow = await db.get(
      'SELECT id, number, expires_at, used FROM draw_tokens WHERE token_hash = $1',
      [hashToken(token)],
    );
    if (!tokenRow) {
      return res.status(403).json({ ok: false, error: 'Ese giro no es válido. Gira la ruleta de nuevo.' });
    }
    const used = tokenRow.used === true || tokenRow.used === 1;
    const expired = new Date(tokenRow.expires_at).getTime() <= Date.now();
    if (used || expired) {
      return res.status(403).json({ ok: false, error: 'Ese giro ya venció o ya se usó. Gira la ruleta de nuevo.' });
    }
    if (Number(tokenRow.number) !== number) {
      await db.query('UPDATE draw_tokens SET used = TRUE WHERE id = $1', [tokenRow.id]);
      return res.status(403).json({ ok: false, error: 'Ese giro no corresponde a ese número. Gira la ruleta de nuevo.' });
    }

    // Consumir el token (solo si sigue sin usarse: la condición
    // used = FALSE hace que dos reclamos a la vez con el mismo
    // token solo dejen pasar a uno).
    const consumed = await db.query(
      'UPDATE draw_tokens SET used = TRUE WHERE id = $1 AND used = FALSE',
      [tokenRow.id],
    );
    if (consumed.rowCount !== 1) {
      return res.status(403).json({ ok: false, error: 'Ese giro ya se usó. Gira la ruleta de nuevo.' });
    }

    try {
      const ins = await db.query(
        'INSERT INTO claims (number, name) VALUES ($1, $2) RETURNING number, name, created_at',
        [number, name],
      );
      const row = ins.rows[0];
      return res.json({
        ok: true,
        claim: {
          number: Number(row.number),
          name: row.name,
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        },
      });
    } catch (e) {
      // UNIQUE: alguien apartó ese número un instante antes.
      return res.json({ ok: false, error: 'Ese número ya fue apartado por otra persona. Gira de nuevo.' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo apartar el número.' });
  }
});

module.exports = router;
