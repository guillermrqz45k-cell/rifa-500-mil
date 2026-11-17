# Rifa 500 Mil — versión pública para Railway

Premio **$500.000**, boleta **$10.000**, números del **00 al 99**.
Organizador de la rifa: **Guillermo Marquez**.

Es el espejo en JavaScript de la página de rifas de Muse
(artefacto `rifa-500-mil`), con las mismas reglas, el mismo diseño
colombiano y la misma seguridad. La página de Muse no tiene enlace
público, así que esta versión es la que se comparte con los
compradores por un link.

## Cómo funciona

- **Ruleta doble en 1:** círculo de adentro del 00 al 49 y círculo
  de afuera del 50 al 99. Ruleta negra con números blancos; al girar
  brillan los colores de Colombia (amarillo, azul, rojo).
- El sorteo lo hace el **servidor**, solo entre los números libres y
  con azar criptográfico: un número con nombre nunca se repite.
- Al caer el número, la persona escribe su nombre y queda apartado:
  aparece en el tablero (marcado en rojo) y en la **tabla de
  registro** con número, nombre y fecha/hora, ordenada del 00 al 99.
- El tablero está dividido en dos barras: una del 00 al 49 y otra
  del 50 al 99, con números grandes.
- **Admin:** la primera vez crea su clave en la zona de
  Administración; con ella entra como admin y restablece la ruleta:
  todos los números quedan libres para una rifa nueva.
- **Música parrandera real** en la tarjeta «Parranda en vivo»: 7
  éxitos oficiales de YouTube en bucle (Jhon Alex Castaño, El
  Charrito Negro, Luis Alberto Posada, Darío Gómez, Yeison Jiménez),
  sin botón de silenciar. El navegador solo permite sonido con
  volumen después del primer toque del usuario: la parranda arranca
  en silencio y suena con el primer toque en la pantalla; después
  no se detiene.
- La base de datos real arranca vacía: 0 apartados, sin clave de
  admin.

## Seguridad

- **Sorteo con azar criptográfico** del servidor (`crypto.randomInt`).
- **Token de giro de un solo uso:** cada giro emite un token secreto
  válido 10 minutos que solo sirve para apartar el número exacto que
  salió en ese giro. Token falso, vencido, ya usado o de otro número:
  rechazado. En la base solo se guarda el hash SHA-256 del token.
- **Clave de admin con PBKDF2-HMAC-SHA256** (100.000 iteraciones,
  sal aleatoria), nunca en texto plano. Tras **5 intentos fallidos**
  la zona de admin se bloquea **15 minutos**.
- **Límites anti-saturación:** máximo 20 giros y 20 apartados por
  minuto por IP, con conteo atómico en la base (una sola sentencia
  UPSERT), así que ni una ráfaga en paralelo puede saltarse el límite.
- **Nombres validados y limpiados en el servidor:** sin etiquetas
  HTML, sin caracteres de control ni invisibles (incluido U+202E),
  máximo 60 caracteres. El cliente muestra los nombres con
  `textContent`, nunca con `innerHTML`.
- **Sin inyección SQL:** todas las consultas son parametrizadas.
- **Ningún dato sensible sale del servidor:** ni el hash de la clave
  ni los tokens aparecen en ninguna respuesta.
- Cabeceras de seguridad con `helmet` (CSP que solo permite YouTube
  para la música, `X-Frame-Options: DENY`).

## Probar en local

```bash
npm install
npm start          # http://localhost:3000 (SQLite en data/rifa.db)
npm test           # pruebas de seguridad con base temporal
```

Las pruebas (`scripts/test-security.js`) cubren: giro legítimo +
apartado con token correcto; apartar con token falso rechazado;
firmar otro número distinto al sorteado rechazado; reutilizar el
mismo token rechazado; token vencido rechazado; nombre con HTML
guardado limpio; crear segunda clave de admin rechazado; login
correcto, stats y restablecimiento; 5 claves erradas bloquean
15 min; ráfaga de giros en paralelo frenada por el límite; y que
el sorteo nunca cae en un número apartado.

## Publicarla en Railway

1. Subir este proyecto a GitHub (repo nuevo, por ejemplo `rifa-500-mil`).
2. En Railway, crear un servicio desde ese repo (mismo proyecto de
   Robin Dark o uno nuevo).
3. **Agregar el plugin de Postgres** al servicio: `DATABASE_URL` la
   pone Railway sola. Sin Postgres los números apartados se perderían
   en cada redespliegue, porque el archivo SQLite no sobrevive.
4. Railway despliega con `railway.json` (healthcheck en `/api/health`).
5. Abrir la URL de Railway, crear la clave de admin en la zona de
   Administración y compartir el link con los compradores.

La clave de admin NO va en el repo ni en variables: se crea en la
propia página, la primera vez, y solo se guarda su hash PBKDF2.

## API

- `GET /api/health` — salud del servicio (`{ ok, app, db }`).
- `GET /api/board` — tablero: premio, boleta, números apartados
  (con nombre y fecha/hora), libres, recaudado y si ya hay clave.
- `GET /api/registrations` — tabla de registro ordenada del 00 al 99.
- `POST /api/draw` — sortea un número libre (`{ number, token, expires_in }`).
- `POST /api/claim` — `{ number, name, token }` aparta el número.
- `POST /api/admin/setup` — `{ key }` crea la clave (solo una vez).
- `POST /api/admin/login` — `{ key }` entrega una sesión de admin (60 min).
- `POST /api/admin/reset` — `{ admin_token }` borra todos los números y nombres.
- `GET /api/admin/stats` — contadores (requiere sesión de admin).

## Archivos

```
package.json  railway.json  .env.example  .gitignore
db/schema.sql
src/db.js            # Postgres (Railway) o SQLite (local)
src/security.js      # PBKDF2, tokens de giro, limpieza de nombres
src/middleware/rateLimit.js  # límite general + contadores atómicos
src/routes/board.js  # GET /api/board, GET /api/registrations
src/routes/draw.js   # POST /api/draw
src/routes/claim.js  # POST /api/claim
src/routes/admin.js  # setup / login / reset / stats
server.js
public/index.html  public/app.js  public/styles.css
scripts/test-security.js
```
