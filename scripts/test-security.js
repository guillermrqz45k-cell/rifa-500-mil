// scripts/test-security.js — pruebas de la Rifa 500 Mil en local.
// Levanta el servidor en un puerto de prueba con una base SQLite
// temporal, verifica las reglas y la seguridad (tokens de giro de
// un solo uso, clave de admin PBKDF2 con bloqueo, límites de
// velocidad, limpieza de nombres) y lo apaga.
// Uso: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `rifa-test-${Date.now()}.db`);

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
async function api(p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SQLITE_FILE: tmpDb },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch { await sleep(250); }
    }
    check('servidor levanta y /api/health ok', up);
    const health = await api('/api/health');
    check('health dice app rifa-500-mil y db sqlite',
      health.data.app === 'rifa-500-mil' && health.data.db === 'sqlite', JSON.stringify(health.data));

    // --- Estado inicial ---
    const b0 = await api('/api/board');
    check('tablero inicial: 100 libres, 0 apartados, recaudado $0, sin clave de admin',
      b0.data.taken_count === 0 && b0.data.free_count === 100 && b0.data.raised === 0 &&
      b0.data.admin_setup === false && b0.data.claims.length === 0,
      JSON.stringify(b0.data));

    // --- Clave de admin ---
    const shortKey = await api('/api/admin/setup', { key: '12' });
    check('clave de menos de 4 caracteres se rechaza', shortKey.status === 400);
    const setup = await api('/api/admin/setup', { key: 'rifa-secreta-2026' });
    check('crear la clave de admin funciona', setup.data.ok === true, JSON.stringify(setup.data));
    const setupAgain = await api('/api/admin/setup', { key: 'otra-clave' });
    check('crear una segunda clave de admin se rechaza (409)',
      setupAgain.status === 409 && setupAgain.data.ok === false, JSON.stringify(setupAgain.data));

    // --- Giro legítimo + apartado con token correcto ---
    const draw1 = await api('/api/draw', {});
    check('giro legítimo devuelve número 00-99, token de 64 hex y expiración de 600 s',
      Number.isInteger(draw1.data.number) && draw1.data.number >= 0 && draw1.data.number <= 99 &&
      /^[0-9a-f]{64}$/.test(draw1.data.token || '') && draw1.data.expires_in === 600,
      JSON.stringify(draw1.data));
    const n1 = draw1.data.number;
    const token1 = draw1.data.token;

    const claimNoToken = await api('/api/claim', { number: n1, name: 'Sin Token' });
    check('apartar sin token se rechaza (400)', claimNoToken.status === 400);
    const claim1 = await api('/api/claim', { number: n1, name: 'Prueba Uno', token: token1 });
    check('apartar con el token correcto funciona', claim1.data.ok === true, JSON.stringify(claim1.data));

    const b1 = await api('/api/board');
    check('tablero: 1 apartado, 99 libres, recaudado $10.000, con el nombre',
      b1.data.taken_count === 1 && b1.data.free_count === 99 && b1.data.raised === 10000 &&
      b1.data.claims[0].number === n1 && b1.data.claims[0].name === 'Prueba Uno',
      JSON.stringify(b1.data));
    const regs = await api('/api/registrations');
    check('tabla de registro muestra el número, el nombre y la fecha/hora',
      regs.data.count === 1 && regs.data.registrations[0].number === n1 &&
      regs.data.registrations[0].name === 'Prueba Uno' &&
      typeof regs.data.registrations[0].created_at === 'string',
      JSON.stringify(regs.data));

    // --- Token falso ---
    const fakeClaim = await api('/api/claim', {
      number: n1, name: 'Atacante',
      token: '00'.repeat(32),
    });
    check('apartar con token falso se rechaza (403)', fakeClaim.status === 403 && fakeClaim.data.ok === false);

    // --- Firmar otro número distinto al sorteado ---
    const draw2 = await api('/api/draw', {});
    const n2 = draw2.data.number;
    const other = (n2 + 1) % 100;
    const wrongNum = await api('/api/claim', { number: other, name: 'Atacante', token: draw2.data.token });
    check('firmar un número distinto al sorteado se rechaza (403)',
      wrongNum.status === 403 && wrongNum.data.ok === false, JSON.stringify(wrongNum.data));
    // El token quedó consumido por el intento: ni el número correcto ya sirve.
    const afterWrong = await api('/api/claim', { number: n2, name: 'Tarde', token: draw2.data.token });
    check('tras firmar mal, el mismo token ya no sirve ni para el número correcto',
      afterWrong.status === 403 && afterWrong.data.ok === false);

    // --- Reutilizar el mismo token ---
    const reuse = await api('/api/claim', { number: n1, name: 'Otra Vez', token: token1 });
    check('reutilizar el mismo token se rechaza (403)', reuse.status === 403 && reuse.data.ok === false);

    // --- Nombre con HTML y carácter invisible ---
    const draw3 = await api('/api/draw', {});
    const dirty = '<script>alert(1)</script> María José \u202E';
    const dirtyClaim = await api('/api/claim', { number: draw3.data.number, name: dirty, token: draw3.data.token });
    check('nombre con HTML se aparta (el servidor lo limpia)', dirtyClaim.data.ok === true, JSON.stringify(dirtyClaim.data));
    const bDirty = await api('/api/board');
    const saved = bDirty.data.claims.find((c) => c.number === draw3.data.number);
    check('el nombre guardado queda limpio: sin < > ni U+202E, texto inerte',
      saved && !/[<>]/.test(saved.name) && !saved.name.includes('\u202E') && /María José/.test(saved.name),
      JSON.stringify(saved));

    // --- Token vencido (se simula poniendo la expiración en el pasado) ---
    const draw4 = await api('/api/draw', {});
    {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(tmpDb);
      const { hashToken } = require('../src/security');
      db.prepare('UPDATE draw_tokens SET expires_at = ? WHERE token_hash = ?')
        .run('2000-01-01T00:00:00.000Z', hashToken(draw4.data.token));
      db.close();
    }
    const expired = await api('/api/claim', { number: draw4.data.number, name: 'Tarde', token: draw4.data.token });
    check('apartar con token vencido se rechaza (403)', expired.status === 403 && expired.data.ok === false);

    // --- El sorteo nunca cae en un número apartado ---
    const claimedNums = new Set(bDirty.data.claims.map((c) => c.number));
    let leaked = false;
    for (let i = 0; i < 5; i++) {
      const d = await api('/api/draw', {});
      if (claimedNums.has(d.data.number)) leaked = true;
    }
    check('5 giros seguidos nunca caen en un número apartado', !leaked);

    // --- Admin: login correcto, stats y restablecimiento ---
    const loginBad1 = await api('/api/admin/login', { key: 'clave-mal' });
    check('login de admin con clave incorrecta se rechaza (401)', loginBad1.status === 401);
    const login = await api('/api/admin/login', { key: 'rifa-secreta-2026' });
    check('login de admin con la clave correcta funciona y da sesión',
      login.data.ok === true && /^[0-9a-f]{64}$/.test(login.data.admin_token || ''),
      JSON.stringify({ ok: login.data.ok }));
    const adminToken = login.data.admin_token;
    const statsNoToken = await api('/api/admin/stats');
    check('stats de admin sin sesión se rechazan (401)', statsNoToken.status === 401);
    const stats = await api(`/api/admin/stats?token=${adminToken}`);
    check('stats de admin con sesión muestran contadores sin datos sensibles',
      stats.data.ok === true && stats.data.taken === 2 && stats.data.free === 98 &&
      stats.data.raised === 20000 && !('admin_key_hash' in stats.data) && !('token' in stats.data),
      JSON.stringify(stats.data));
    const resetNoToken = await api('/api/admin/reset', {});
    check('restablecer sin sesión se rechaza (401)', resetNoToken.status === 401);
    const reset = await api('/api/admin/reset', { admin_token: adminToken });
    check('restablecer con la sesión correcta funciona', reset.data.ok === true, JSON.stringify(reset.data));
    const b2 = await api('/api/board');
    check('tras restablecer: 0 apartados, 100 libres, clave sigue creada',
      b2.data.taken_count === 0 && b2.data.free_count === 100 && b2.data.admin_setup === true,
      JSON.stringify(b2.data));

    // --- Bloqueo de admin: 5 claves erradas bloquean 15 min ---
    // (Se prueba al final del login correcto, porque el bloqueo
    // frena hasta la clave correcta.)
    let lockStatus = null;
    for (let i = 0; i < 5; i++) {
      const r = await api('/api/admin/login', { key: 'clave-mal' });
      lockStatus = r.status;
    }
    check('tras 5 claves erradas la zona de admin se bloquea (423)', lockStatus === 423);
    const loginWhileLocked = await api('/api/admin/login', { key: 'rifa-secreta-2026' });
    check('con el bloqueo activo, hasta la clave correcta se rechaza (423)',
      loginWhileLocked.status === 423);

    // --- Ráfaga de giros en paralelo frenada por el límite ---
    // Giros hechos hasta aquí en este minuto: 1 + 1 + 1 + 1 + 5 = 9.
    // El límite es 20/min: de 25 en paralelo solo deben pasar 11.
    const burst = await Promise.all(Array.from({ length: 25 }, () => api('/api/draw', {})));
    const burstOk = burst.filter((r) => r.status === 200 && r.data.number !== undefined).length;
    const burstLimited = burst.filter((r) => r.status === 429).length;
    // El límite es 20 giros/min: en la misma ventana de 1 minuto
    // solo pueden pasar los que queden hasta 20; si la prueba cruza
    // un cambio de minuto, el contador se reinicia, así que la
    // aserción solo exige que el límite dispare y nunca pase de 20.
    check('ráfaga de 25 giros en paralelo: el límite de 20/min frena el resto',
      burstLimited >= 1 && burstOk <= 20,
      `ok=${burstOk} limitados=${burstLimited}`);
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  }
  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
