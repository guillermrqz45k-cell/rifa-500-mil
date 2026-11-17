// src/routes/board.js — tablero y registro de la rifa.
//
// GET /api/board
//   Estado público: premio, boleta, números apartados (con nombre y
//   fecha/hora), cuántos quedan y cuánto se ha recaudado. No devuelve
//   ningún dato sensible (ni hash de clave ni tokens).
// GET /api/registrations
//   La tabla de registro: número, nombre y fecha/hora, ordenada del
//   00 al 99.
const express = require('express');
const db = require('../db');

const router = express.Router();

const PRIZE = 500000;
const TICKET = 10000;
const TOTAL_NUMBERS = 100;

function fmtClaim(r) {
  return {
    number: Number(r.number),
    name: r.name,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

async function getClaims() {
  const res = await db.query('SELECT number, name, created_at FROM claims ORDER BY number ASC');
  return res.rows.map(fmtClaim);
}

router.get('/board', async (req, res) => {
  try {
    const claims = await getClaims();
    const admin = await db.get('SELECT value FROM settings WHERE key = $1', ['admin_key_hash']);
    res.json({
      prize: PRIZE,
      ticket: TICKET,
      total: TOTAL_NUMBERS,
      claims,
      taken_count: claims.length,
      free_count: TOTAL_NUMBERS - claims.length,
      raised: claims.length * TICKET,
      admin_setup: Boolean(admin),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo leer el tablero.' });
  }
});

router.get('/registrations', async (req, res) => {
  try {
    const claims = await getClaims();
    res.json({ registrations: claims, count: claims.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo leer el registro.' });
  }
});

module.exports = router;
