// src/db.js — capa de base de datos de la Rifa 500 Mil.
//
// - En Railway: usa Postgres con DATABASE_URL (paquete `pg`).
// - En local (sin DATABASE_URL): usa SQLite con el módulo built-in
//   `node:sqlite` y el archivo data/rifa.db (o SQLITE_FILE).
//
// Tablas (ver db/schema.sql):
// - claims: un renglón por número apartado (number 0-99, clave
//   primaria: la base misma impide dos nombres en un número).
// - settings: clave/valor; guarda el hash PBKDF2 de la clave de
//   admin, los intentos fallidos, el bloqueo y la sesión del admin.
// - draw_tokens: tokens de giro de un solo uso (solo se guarda el
//   hash SHA-256; el token en claro solo se entrega en el giro).
// - rate_limits: contadores de velocidad con incremento atómico.
//
// query() devuelve { rows, rowCount, lastID } en ambos motores.
// En SQLite, $1/$2 se convierten a ? y se duplica el valor por cada
// aparición del marcador (Postgres reutiliza el parámetro; sqlite no).
const fs = require('fs');
const path = require('path');

const usePostgres = Boolean(process.env.DATABASE_URL);

let pool = null; // pg
let sqlite = null; // node:sqlite DatabaseSync

function toSqlitePlaceholders(sql, params = []) {
  const outParams = [];
  const outSql = sql.replace(/\$\d+/g, (m) => {
    outParams.push(params[Number(m.slice(1)) - 1]);
    return '?';
  });
  return { sql: outSql, params: outParams };
}

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS claims (
    number INTEGER PRIMARY KEY CHECK (number >= 0 AND number <= 99),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draw_tokens (
    id SERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    number INTEGER NOT NULL CHECK (number >= 0 AND number <= 99),
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_draw_tokens_hash ON draw_tokens (token_hash);
  CREATE INDEX IF NOT EXISTS idx_claims_created ON claims (created_at);
`;

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS claims (
    number INTEGER PRIMARY KEY CHECK (number >= 0 AND number <= 99),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draw_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    number INTEGER NOT NULL CHECK (number >= 0 AND number <= 99),
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_draw_tokens_hash ON draw_tokens (token_hash);
  CREATE INDEX IF NOT EXISTS idx_claims_created ON claims (created_at);
`;

async function init() {
  if (usePostgres) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    });
    await pool.query(SCHEMA_PG);
    console.log('[db] Postgres conectado (DATABASE_URL)');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const dir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dir, { recursive: true });
    const file = process.env.SQLITE_FILE || path.join(dir, 'rifa.db');
    sqlite = new DatabaseSync(file);
    sqlite.exec('PRAGMA foreign_keys = ON;');
    sqlite.exec(SCHEMA_SQLITE);
    console.log(`[db] SQLite local (${file})`);
  }
}

async function query(sql, params = []) {
  if (usePostgres) {
    const res = await pool.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount, lastID: res.rows[0]?.id ?? null };
  }
  const { sql: liteSql, params: liteParams } = toSqlitePlaceholders(sql, params);
  const stmt = sqlite.prepare(liteSql);
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
    return { rows: stmt.all(...liteParams), rowCount: 0, lastID: null };
  }
  if (/RETURNING\b/i.test(sql)) {
    const row = stmt.get(...liteParams);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0, lastID: row?.id ?? null };
  }
  const info = stmt.run(...liteParams);
  return { rows: [], rowCount: info.changes, lastID: Number(info.lastInsertRowid) };
}

async function get(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

async function run(sql, params = []) {
  const res = await query(sql, params);
  return { lastID: res.lastID, changes: res.rowCount };
}

async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

module.exports = { init, query, get, run, close, usePostgres };
