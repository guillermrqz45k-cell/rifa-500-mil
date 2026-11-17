// src/security.js — seguridad de la Rifa 500 Mil.
//
// - Clave de admin: PBKDF2-HMAC-SHA256 con sal aleatoria y 100.000
//   iteraciones. En la base solo se guarda el hash con su sal, nunca
//   la clave en claro. La comparación es en tiempo constante.
// - Tokens de giro: 32 bytes aleatorios (crypto), de un solo uso.
//   En la base solo se guarda el hash SHA-256 del token.
// - Nombres: se limpian en el servidor — se quitan etiquetas HTML,
//   los caracteres < >, los caracteres de control y los invisibles
//   (incluido U+202E y los de ancho cero), se colapsan los espacios
//   y se limita la longitud. El texto que queda es inerte: el
//   cliente lo muestra con textContent, nunca con innerHTML.
// - Sorteo: crypto.randomInt, azar criptográfico del servidor.
const crypto = require('crypto');

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';
const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutos

function hashAdminKey(key) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(key, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

function verifyAdminKey(key, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('pbkdf2$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'hex');
  if (!Number.isInteger(iterations) || iterations < 1 || expected.length !== PBKDF2_KEYLEN) return false;
  const actual = crypto.pbkdf2Sync(key, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return crypto.timingSafeEqual(actual, expected);
}

// Token de giro: se devuelve en claro una sola vez (en la respuesta
// del giro) y en la base solo queda su hash.
function newDrawToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Sorteo: un número libre al azar, con azar criptográfico.
function pickFreeNumber(takenSet) {
  const free = [];
  for (let n = 0; n < 100; n++) if (!takenSet.has(n)) free.push(n);
  if (free.length === 0) return null;
  return free[crypto.randomInt(free.length)];
}

// Limpieza de nombres en el servidor. Devuelve el nombre limpio
// ('' si no queda nada usable).
function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/<[^>]*>/g, ''); // quita etiquetas <...>
  s = s.replace(/[<>]/g, ''); // quita < > sueltos
  // Caracteres de control (Cc), de formato (Cf: incluye U+202E y
  // los de ancho cero) y separadores raros. Se conserva el espacio
  // normal y las letras con tilde/ñ.
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 60);
}

function isValidNumber(n) {
  return Number.isInteger(n) && n >= 0 && n <= 99;
}

function isValidTokenFormat(token) {
  return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
}

module.exports = {
  PBKDF2_ITERATIONS,
  TOKEN_TTL_MS,
  hashAdminKey,
  verifyAdminKey,
  newDrawToken,
  hashToken,
  pickFreeNumber,
  cleanName,
  isValidNumber,
  isValidTokenFormat,
};
