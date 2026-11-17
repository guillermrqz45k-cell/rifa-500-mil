// server.js — entrada de la Rifa 500 Mil (Node.js + Express).
//
// Reglas (las mismas de la página en Muse):
// - Premio $500.000, boleta $10.000, números del 00 al 99.
// - Ruleta doble en 1: círculo de adentro 00-49, círculo de
//   afuera 50-99. Ruleta negra con números blancos; al girar
//   brillan los colores de Colombia (amarillo, azul, rojo).
// - El sorteo lo hace el SERVIDOR, solo entre números libres y con
//   azar criptográfico: un número con nombre nunca se repite. Cada
//   giro emite un token secreto de un solo uso (10 minutos) que
//   solo sirve para apartar el número exacto que salió.
// - El nombre se guarda en la base de datos hasta que el admin
//   restablezca la rifa con su clave (PBKDF2, 100.000 iteraciones).
// - Si dos personas reclaman el mismo número a la vez, la
//   restricción UNIQUE de claims.number deja pasar solo a una.
//
// Despliegue: Railway con el plugin de Postgres (DATABASE_URL).
// Sin Postgres, en local usa SQLite (data/rifa.db, solo pruebas).
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const helmet = require('helmet');
const path = require('path');
const db = require('./src/db');
const { apiLimiter } = require('./src/middleware/rateLimit');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Cabeceras de seguridad. La CSP permite los videos de YouTube de
// la tarjeta «Parranda en vivo» (iframe y API) y nada más de fuera:
// - frame-src: youtube.com / youtube-nocookie.com
// - script-src: el propio sitio + youtube.com + s.ytimg.com (la API
//   de YouTube carga su reproductor desde ahí)
// - img-src: el propio sitio, data: y las miniaturas de YouTube
// - frame-ancestors 'none': la rifa no se puede meter en un iframe
//   de otra web (clickjacking)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://www.youtube.com', 'https://s.ytimg.com'],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
  }),
);

app.use(express.json({ limit: '1mb' }));

// Límite general de la API (300 peticiones / 15 min por IP).
// /api/health queda fuera: Railway la comprueba constantemente.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'rifa-500-mil', db: db.usePostgres ? 'postgres' : 'sqlite' });
});

app.use('/api', apiLimiter);

app.use('/api', require('./src/routes/board'));
app.use('/api', require('./src/routes/draw'));
app.use('/api', require('./src/routes/claim'));
app.use('/api/admin', require('./src/routes/admin'));

// Archivos de la página. El HTML nunca se guarda en caché, para
// que un teléfono no siga viendo una versión vieja después de un
// despliegue; el JS y el CSS llevan versión (?v=) por lo mismo.
const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSET_VERSION = (() => {
  try {
    const mtimes = ['app.js', 'styles.css', 'index.html'].map((f) =>
      fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs,
    );
    return String(Math.floor(Math.max(...mtimes) / 1000));
  } catch (e) {
    return '1';
  }
})();

function sendVersionedIndex(req, res) {
  const html = fs
    .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('src="app.js"', `src="app.js?v=${ASSET_VERSION}"`)
    .replace('href="styles.css"', `href="styles.css?v=${ASSET_VERSION}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
}

app.get('/', sendVersionedIndex);
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    },
  }),
);

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Ruta no encontrada.' });
  sendVersionedIndex(req, res);
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'El cuerpo debe ser JSON válido.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'El cuerpo es demasiado grande.' });
  }
  return next(err);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
});

async function start() {
  await db.init();
  app.listen(PORT, () => {
    console.log(`[rifa-500-mil] Escuchando en http://localhost:${PORT}`);
  });
}

if (require.main === module) start();

module.exports = app;
