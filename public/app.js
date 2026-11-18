// app.js — Rifa 500 Mil (versión pública para Railway).
// El sorteo se hace en el servidor: POST /api/draw solo devuelve
// números libres y un token de un solo uso; POST /api/claim guarda
// el nombre con ese token. El tablero se actualiza solo cada 10 s
// para que se vean los números que apartan otras personas.
// Todo texto de usuarios se inserta con textContent, nunca con
// innerHTML, así que un nombre con código no puede ejecutarse.
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const money = (n) => '$' + n.toLocaleString('es-CO');

const SONGS = [
  { id: 'w1z_APiZe4Q', title: 'De Bar en Bar', artist: 'Jhon Alex Castaño' },
  { id: 'dD4BQemCzwg', title: 'Dos Razones', artist: 'Jhon Alex Castaño' },
  { id: 'HwCfHBJ2UTY', title: 'Amigos con Derechos', artist: 'Jhon Alex Castaño' },
  { id: 'sK4VXcqozIE', title: 'Quererte Fue Un Error', artist: 'El Charrito Negro' },
  { id: 'y0urjj80RL8', title: 'El Precio De Tu Error', artist: 'Luis Alberto Posada' },
  { id: 'YIo5Rq8ptFU', title: 'Nadie Es Eterno', artist: 'Darío Gómez' },
  { id: 'n6zvD8kA3z4', title: 'Aventurero', artist: 'Yeison Jiménez' },
];

let drawn = null;
let drawToken = null;
let spinning = false;
let currentRotation = 0;
let boardClaims = new Map();

async function api(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// ---------- Ruleta doble (SVG): adentro 00-49, afuera 50-99 ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
const CX = 200;
const CY = 200;
const INNER = { r0: 104, r1: 144 };
const OUTER = { r0: 148, r1: 190 };
const SEG = 360 / 50; // 7.2° por número

function polar(r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function wedgePath(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r1} ${r1} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
    `L ${x2.toFixed(2)} ${y2.toFixed(2)} A ${r0} ${r0} 0 0 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

function buildWheel() {
  const g = $('wheelSpin');
  const rings = [
    { ...INNER, start: 0 },
    { ...OUTER, start: 50 },
  ];
  for (const ring of rings) {
    for (let i = 0; i < 50; i++) {
      const n = ring.start + i;
      const a0 = i * SEG;
      const a1 = a0 + SEG;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', wedgePath(ring.r0, ring.r1, a0, a1));
      path.setAttribute('class', 'wedge');
      path.setAttribute('data-number', String(n));
      g.appendChild(path);
      const mid = a0 + SEG / 2;
      const rm = (ring.r0 + ring.r1) / 2;
      const [tx, ty] = polar(rm, mid);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', tx.toFixed(1));
      text.setAttribute('y', ty.toFixed(1));
      text.setAttribute('class', 'wedge-num' + (n % 10 === 0 ? ' ten' : ''));
      text.setAttribute('data-number', String(n));
      text.setAttribute('transform', `rotate(${mid.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)})`);
      text.textContent = pad(n);
      g.appendChild(text);
    }
  }
  // Anillo divisor dorado entre los dos círculos.
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', CX);
  ring.setAttribute('cy', CY);
  ring.setAttribute('r', 146);
  ring.setAttribute('class', 'divider-ring');
  g.appendChild(ring);
}

function markTakenOnWheel() {
  document.querySelectorAll('#wheelSpin .wedge, #wheelSpin .wedge-num').forEach((el) => {
    const n = Number(el.getAttribute('data-number'));
    el.classList.toggle('taken', boardClaims.has(n));
  });
}

// Gira la ruleta hasta que el número sorteado quede bajo el puntero.
function spinTo(number) {
  return new Promise((resolve) => {
    const g = $('wheelSpin');
    const idx = number % 50;
    const center = idx * SEG + SEG / 2;
    // El puntero está arriba (ángulo 270°). Rotación necesaria:
    const targetMod = ((270 - center) % 360 + 360) % 360;
    const nowMod = ((currentRotation % 360) + 360) % 360;
    const delta = ((targetMod - nowMod) % 360 + 360) % 360;
    const target = currentRotation + 5 * 360 + delta;
    currentRotation = target;
    const onEnd = () => {
      g.removeEventListener('transitionend', onEnd);
      resolve();
    };
    g.addEventListener('transitionend', onEnd);
    requestAnimationFrame(() => {
      g.style.transform = `rotate(${target}deg)`;
    });
    // Respaldo por si el transitionend no dispara.
    setTimeout(() => { g.removeEventListener('transitionend', onEnd); resolve(); }, 5600);
  });
}

// ---------- Tablero y tabla de registro ----------
function renderBoard() {
  const low = $('boardLow');
  const high = $('boardHigh');
  low.textContent = '';
  high.textContent = '';
  for (let n = 0; n < 100; n++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.textContent = pad(n);
    const owner = boardClaims.get(n);
    if (owner) {
      cell.classList.add('taken');
      cell.title = `Apartado por ${owner}`;
      cell.addEventListener('click', () => {
        $('boardOwner').textContent = `El ${pad(n)} es de ${owner}.`;
      });
    }
    (n < 50 ? low : high).appendChild(cell);
  }
}

function renderRegistry(claims) {
  const body = $('regBody');
  body.textContent = '';
  $('partCount').textContent = String(claims.length);
  $('noParts').style.display = claims.length ? 'none' : '';
  const fmt = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  for (const c of claims) {
    const tr = document.createElement('tr');
    const tdN = document.createElement('td');
    tdN.textContent = pad(c.number);
    tdN.className = 'num';
    const tdName = document.createElement('td');
    tdName.textContent = c.name;
    const tdDate = document.createElement('td');
    tdDate.textContent = fmt.format(new Date(c.created_at));
    tr.append(tdN, tdName, tdDate);
    body.appendChild(tr);
  }
}

async function loadBoard() {
  try {
    const { data } = await api('/api/board');
    if (!data || typeof data.taken_count !== 'number') return;
    boardClaims = new Map(data.claims.map((c) => [c.number, c.name]));
    $('progressText').textContent = `${data.taken_count} de 100 números apartados`;
    $('leftText').textContent = `Quedan ${data.free_count}`;
    $('barFill').style.width = `${data.taken_count}%`;
    $('raisedText').textContent = money(data.raised);
    renderBoard();
    renderRegistry(data.claims);
    markTakenOnWheel();
    const hasSession = Boolean(sessionStorage.getItem('rifa_admin_token'));
    $('adminSetup').classList.toggle('hidden', data.admin_setup);
    $('adminLogin').classList.toggle('hidden', !data.admin_setup || hasSession);
    if (hasSession) showAdminPanel();
  } catch (e) {
    // Sin conexión: se reintenta en el siguiente ciclo.
  }
}

// ---------- Giro y apartado ----------
async function doSpin() {
  if (spinning) return;
  spinning = true;
  $('spinBtn').disabled = true;
  $('claimForm').classList.add('hidden');
  setMsg($('spinMsg'), '');
  try {
    const { status, data } = await api('/api/draw', {});
    if (status === 429) {
      setMsg($('spinMsg'), data.error || 'Estás girando demasiado rápido. Espera un minuto.', 'err');
      return;
    }
    if (!data || data.ok === false) {
      setMsg($('spinMsg'), (data && data.error) || 'No se pudo girar la ruleta.', 'err');
      return;
    }
    if (data.number === null) {
      setMsg($('spinMsg'), 'Ya no quedan números libres: la rifa está completa.', 'err');
      return;
    }
    drawn = data.number;
    drawToken = data.token;
    $('stage').classList.add('spinning');
    await spinTo(drawn);
    $('stage').classList.remove('spinning');
    $('drawnNumber').textContent = pad(drawn);
    $('claimForm').classList.remove('hidden');
    $('nameInput').value = '';
    setMsg($('claimMsg'), '');
    $('nameInput').focus();
  } finally {
    spinning = false;
    $('spinBtn').disabled = false;
  }
}

async function doClaim(e) {
  e.preventDefault();
  const name = $('nameInput').value;
  if (!drawToken || drawn === null) {
    setMsg($('claimMsg'), 'Gira la ruleta primero.', 'err');
    return;
  }
  const { data } = await api('/api/claim', { number: drawn, name, token: drawToken });
  if (data && data.ok) {
    setMsg($('claimMsg'), `¡Listo! El número ${pad(drawn)} quedó apartado a tu nombre.`, 'ok');
    drawn = null;
    drawToken = null;
    setTimeout(() => $('claimForm').classList.add('hidden'), 2500);
    await loadBoard();
  } else {
    setMsg($('claimMsg'), (data && data.error) || 'No se pudo apartar el número.', 'err');
  }
}

// ---------- Música parrandera (YouTube) ----------
// El reproductor es VISIBLE (16:9) dentro de la tarjeta: un reproductor
// invisible (0x0) no arranca la reproducción en varios navegadores.
// Nada de playVideo/unMute antes de onReady: si el usuario toca antes,
// la intención queda pendiente y se ejecuta cuando el reproductor está listo.
// Sin lista de YouTube (parámetro playlist): con la lista, el reproductor
// tiene que cargar los 7 videos antes de arrancar y en redes lentas falla
// con error 150 y no suena nada. La cola se lleva en JS: se carga un video
// a la vez y al terminar pasa al siguiente.
let ytPlayer = null;
let musicOn = false;
let playerReady = false;
let hasPlayed = false;
let currentSong = 0;
let pendingUnmute = false;
let pendingSong = null;
let lastSongPointer = 0;
let lastErrorRecovery = 0;

function highlightSong(idx) {
  const ol = $('playlist');
  if (!ol) return;
  Array.from(ol.children).forEach((li, i) => {
    li.classList.toggle('active', i === idx);
  });
}

function updateNowPlaying(idx) {
  const song = SONGS[idx];
  if (song) $('nowPlaying').textContent = `${song.title} — ${song.artist}`;
  if (idx >= 0) highlightSong(idx);
}

function renderPlaylist() {
  const ol = $('playlist');
  ol.textContent = '';
  SONGS.forEach((s, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${s.title} — ${s.artist}`;
    // La canción se lanza en pointerdown (antes de que el primer toque
    // cambie la nota y mueva la lista) y el clic queda como respaldo
    // para teclado; si el pointerdown ya la lanzó, el clic se ignora.
    b.addEventListener('pointerdown', () => {
      lastSongPointer = Date.now();
      playSong(i);
    });
    b.addEventListener('click', () => {
      if (Date.now() - lastSongPointer < 800) return;
      playSong(i);
    });
    li.appendChild(b);
    ol.appendChild(li);
  });
  highlightSong(0);
}

function loadSong(i) {
  currentSong = i;
  ytPlayer.loadVideoById(SONGS[i].id);
  highlightSong(i);
}

function playSong(i) {
  // Solo se cambia directamente si el reproductor ya sonó al menos una
  // vez; si no, se guarda la petición y se aplica al primer PLAYING.
  if (playerReady && ytPlayer && typeof ytPlayer.loadVideoById === 'function' && hasPlayed) {
    loadSong(i);
  } else {
    pendingSong = i;
  }
  highlightSong(i);
  unmuteMusic();
}

function unmuteMusic() {
  if (!playerReady || !ytPlayer || typeof ytPlayer.unMute !== 'function') {
    pendingUnmute = true;
    return;
  }
  ytPlayer.unMute();
  ytPlayer.setVolume(90);
  ytPlayer.playVideo();
  // Si medio segundo después el reproductor sigue sin reproducir
  // (por ejemplo porque playVideo llegó antes de estar listo del todo),
  // se reintenta una vez más.
  setTimeout(() => {
    try {
      if (
        ytPlayer &&
        typeof ytPlayer.getPlayerState === 'function' &&
        typeof YT !== 'undefined' &&
        ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING
      ) {
        ytPlayer.playVideo();
      }
    } catch (e) { /* el reproductor ya no existe; nada que hacer */ }
  }, 500);
  if (!musicOn) {
    musicOn = true;
    $('musicNote').textContent = 'Parranda sonando. No se detiene: sigue sonando mientras giras la ruleta.';
  }
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('ytPlayer', {
    height: '100%',
    width: '100%',
    videoId: SONGS[0].id,
    playerVars: {
      autoplay: 1,
      mute: 1,
      controls: 0,
      disablekb: 1,
      fs: 0,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
    },
    events: {
      onReady(event) {
        playerReady = true;
        const iframe = document.querySelector('#ytPlayer iframe');
        if (iframe) iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
        event.target.setVolume(90);
        event.target.playVideo();
        if (pendingUnmute) {
          pendingUnmute = false;
          unmuteMusic();
        }
      },
      onStateChange(event) {
        if (event.data === YT.PlayerState.PLAYING) {
          hasPlayed = true;
          // Canción pedida antes de que sonara la primera: se aplica ahora.
          if (pendingSong !== null) {
            const idx = pendingSong;
            pendingSong = null;
            loadSong(idx);
            return;
          }
          updateNowPlaying(currentSong);
        } else if (event.data === YT.PlayerState.ENDED) {
          // Al terminar una canción, pasa a la siguiente (y vuelve a la
          // primera al final de la lista). El sonido sigue como estaba.
          loadSong((currentSong + 1) % SONGS.length);
        }
      },
      onError(event) {
        // Un video que falla (p. ej. error 150) no se reanuda con
        // playVideo(): el reproductor queda trabado. Se salta al
        // siguiente video de la lista para que la parranda no se
        // detenga; el video fallido volverá a intentarse en la
        // siguiente vuelta del bucle. Limitado a un salto cada 3 s
        // para no entrar en bucle si no hay internet.
        pendingSong = null;
        const now = Date.now();
        if (now - lastErrorRecovery < 3000) return;
        lastErrorRecovery = now;
        setTimeout(() => {
          try {
            if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
              loadSong((currentSong + 1) % SONGS.length);
            }
          } catch (e) { /* sin reproductor; nada que hacer */ }
        }, 800);
      },
    },
  });
};

// El navegador solo permite sonido con volumen después de un toque
// del usuario: el primer toque en cualquier parte sube el volumen.
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, unmuteMusic));

// ---------- Admin ----------
function showAdminPanel() {
  $('adminSetup').classList.add('hidden');
  $('adminLogin').classList.add('hidden');
  $('adminPanel').classList.remove('hidden');
  loadAdminStats();
}

async function loadAdminStats() {
  const token = sessionStorage.getItem('rifa_admin_token');
  if (!token) return;
  const { data } = await api(`/api/admin/stats?token=${encodeURIComponent(token)}`);
  if (data && data.ok) {
    $('adminStats').textContent =
      `${data.taken} apartados · ${data.free} libres · Recaudado ${money(data.raised)} · Giros activos: ${data.active_draw_tokens}`;
  } else {
    sessionStorage.removeItem('rifa_admin_token');
    $('adminPanel').classList.add('hidden');
    $('adminLogin').classList.remove('hidden');
  }
}

async function setupAdmin() {
  const key = $('adminKeyInput').value.trim();
  const { data } = await api('/api/admin/setup', { key });
  if (data && data.ok) {
    setMsg($('adminMsg'), 'Clave de admin creada. Guárdala bien: con ella restableces la rifa.', 'ok');
    $('adminSetup').classList.add('hidden');
    $('adminLogin').classList.remove('hidden');
  } else {
    setMsg($('adminMsg'), (data && data.error) || 'No se pudo crear la clave.', 'err');
  }
}

async function loginAdmin() {
  const key = $('adminLoginInput').value.trim();
  const { data } = await api('/api/admin/login', { key });
  if (data && data.ok) {
    sessionStorage.setItem('rifa_admin_token', data.admin_token);
    setMsg($('adminMsg'), '', '');
    showAdminPanel();
  } else {
    setMsg($('adminMsg'), (data && data.error) || 'No se pudo entrar como admin.', 'err');
  }
}

async function resetRaffle() {
  const token = sessionStorage.getItem('rifa_admin_token');
  if (!token) return;
  if (!window.confirm('¿Restablecer la rifa? Se borran todos los números apartados y los nombres.')) return;
  const { data } = await api('/api/admin/reset', { admin_token: token });
  if (data && data.ok) {
    setMsg($('adminMsg'), 'Rifa restablecida: todos los números quedaron libres.', 'ok');
    await loadBoard();
    await loadAdminStats();
  } else {
    setMsg($('adminMsg'), (data && data.error) || 'No se pudo restablecer.', 'err');
  }
}

// ---------- Decoración: bombillos de la tarima y confeti ----------
function buildBulbs() {
  const wrap = $('bulbs');
  const colors = ['#ffd500', '#003087', '#c8102e'];
  for (let k = 0; k < 28; k++) {
    const b = document.createElement('span');
    b.className = 'bulb';
    b.style.setProperty('--r', `${(k * 360) / 28}deg`);
    b.style.background = colors[k % 3];
    b.style.animationDelay = `${(k % 7) * 0.13}s`;
    wrap.appendChild(b);
  }
}

function buildConfetti() {
  const wrap = document.querySelector('.confetti');
  const colors = ['#ffd500', '#003087', '#c8102e', '#ffffff', '#d4af37'];
  for (let k = 0; k < 24; k++) {
    const c = document.createElement('i');
    c.style.left = `${(k * 41) % 100}%`;
    c.style.background = colors[k % colors.length];
    c.style.animationDelay = `${(k % 12) * 0.7}s`;
    c.style.animationDuration = `${7 + (k % 5)}s`;
    wrap.appendChild(c);
  }
}

// ---------- Inicio ----------
buildWheel();
buildBulbs();
buildConfetti();
renderPlaylist();
loadBoard();
setInterval(loadBoard, 10000);

$('spinBtn').addEventListener('click', doSpin);
$('playMusicBtn').addEventListener('click', unmuteMusic);
$('copyBrebBtn').addEventListener('click', async () => {
  const key = $('brebKey').textContent.trim();
  const msg = $('copyBrebMsg');
  try {
    await navigator.clipboard.writeText(key);
    msg.textContent = 'Llave copiada';
  } catch {
    const ta = document.createElement('textarea');
    ta.value = key;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      msg.textContent = 'Llave copiada';
    } catch {
      msg.textContent = 'Copia la llave: ' + key;
    }
    document.body.removeChild(ta);
  }
  setTimeout(() => { msg.textContent = ''; }, 3000);
});
$('claimForm').addEventListener('submit', doClaim);
$('spinAgainBtn').addEventListener('click', () => {
  drawn = null;
  drawToken = null;
  $('claimForm').classList.add('hidden');
});
$('createAdminBtn').addEventListener('click', setupAdmin);
$('adminLoginBtn').addEventListener('click', loginAdmin);
$('resetBtn').addEventListener('click', resetRaffle);
