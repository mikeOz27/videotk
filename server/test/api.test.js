// Prueba la API completa contra una base SQLite temporal: npm test
// (con DB_CLIENT y DATABASE_URL definidos prueba también PostgreSQL o MySQL).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'videotk-test-'));
process.env.DATA_DIR = dir;
process.env.SQLITE_FILE = join(dir, 'test.db');
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.SITE_URLS = 'https://ejemplo.test/videotk/';
process.env.SERVE_WEB = 'true';
// Vacías (no borradas): así el .env de tu PC no las rellena y las pruebas nunca envían correos de verdad.
for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_CONFIRM', 'PUBLIC_URL', 'DB_CLIENT', 'DATABASE_URL']) process.env[key] ??= '';
for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_CONFIRM', 'PUBLIC_URL']) process.env[key] = '';

const { openDatabase } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

// Los correos salen por consola (sin SMTP): se capturan para leer códigos y enlaces.
const mails = [];
const log = console.log;
console.log = (...args) => { const line = args.join(' '); if (line.includes('[correo]')) mails.push(line); else log(...args); };

let db; let server; let base;
before(async () => {
  db = await openDatabase();
  server = (await createApp(db)).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  console.log = log;
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method, path, { body, token, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (raw) { init.body = raw; init.headers['Content-Type'] = 'image/jpeg'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const response = await fetch(base + path, init);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

const unique = () => `u${Date.now()}${Math.random().toString(36).slice(2, 7)}@correo.test`;

async function signup(email = unique(), password = 'secreto1') {
  const res = await call('POST', '/api/auth/signup', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return { email, password, session: res.data.session, token: res.data.session.access_token };
}

test('registro, entrar y sesión', async () => {
  const { email, password, session } = await signup();
  assert.ok(session.refresh_token);
  assert.equal(session.user.email, email);

  const dup = await call('POST', '/api/auth/signup', { body: { email, password } });
  assert.equal(dup.data.code, 'user_already_exists');

  const bad = await call('POST', '/api/auth/token', { body: { email, password: 'otra-clave' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'invalid_credentials');

  const ok = await call('POST', '/api/auth/token', { body: { email: email.toUpperCase(), password } });
  assert.equal(ok.status, 200);
  const me = await call('GET', '/api/auth/user', { token: ok.data.access_token });
  assert.equal(me.data.email, email);

  // Renovar: el refresh token viejo deja de servir.
  const refreshed = await call('POST', '/api/auth/token/refresh', { body: { refresh_token: ok.data.refresh_token } });
  assert.equal(refreshed.status, 200);
  const reused = await call('POST', '/api/auth/token/refresh', { body: { refresh_token: ok.data.refresh_token } });
  assert.equal(reused.status, 400);

  assert.equal((await call('GET', '/api/videos')).status, 401);
  assert.equal((await call('GET', '/api/videos', { token: 'a.b.c' })).status, 401);
});

test('categorías y videos de un usuario', async () => {
  const { token } = await signup();
  const cat = await call('POST', '/api/categories', { token, body: { name: '  Zelda  ' } });
  assert.equal(cat.status, 201);
  assert.equal(cat.data.name, 'Zelda');
  assert.equal((await call('POST', '/api/categories', { token, body: { name: 'zelda' } })).data.code, '23505');
  const other = await call('POST', '/api/categories', { token, body: { name: 'Anime' } });
  assert.deepEqual((await call('GET', '/api/categories', { token })).data.map((c) => c.name), ['Anime', 'Zelda']);

  const video = await call('POST', '/api/videos', { token, body: { url: 'https://youtu.be/abc', title: 'Uno', source: 'youtube.com', thumbnail: '', description: 'hola', category_id: cat.data.id } });
  assert.equal(video.status, 201);
  assert.equal(video.data.category_id, cat.data.id);
  assert.ok(video.data.position < 0);
  assert.equal((await call('POST', '/api/videos', { token, body: { url: 'https://youtu.be/abc' } })).data.code, '23505');
  assert.equal((await call('POST', '/api/videos', { token, body: { url: 'javascript:alert(1)' } })).status, 400);

  const second = await call('POST', '/api/videos', { token, body: { url: 'https://youtu.be/def', title: 'Dos' } });
  const list = await call('GET', '/api/videos', { token });
  assert.deepEqual(list.data.map((v) => v.title), ['Dos', 'Uno']);

  assert.equal((await call('PATCH', `/api/videos/${video.data.id}`, { token, body: { position: -1e12 } })).status, 204);
  assert.deepEqual((await call('GET', '/api/videos', { token })).data.map((v) => v.title), ['Uno', 'Dos']);

  // Categoría en uso: no se borra. Sin uso: sí.
  assert.equal((await call('DELETE', `/api/categories/${cat.data.id}`, { token })).data.code, '23503');
  assert.equal((await call('PATCH', `/api/videos/${video.data.id}`, { token, body: { description: 'nueva', category_id: null } })).status, 204);
  assert.equal((await call('DELETE', `/api/categories/${cat.data.id}`, { token })).status, 204);
  assert.equal((await call('PATCH', `/api/categories/${other.data.id}`, { token, body: { name: 'Animé' } })).status, 204);

  const bulk = await call('POST', '/api/videos/bulk', { token, body: { rows: [{ url: 'https://youtu.be/abc' }, { url: 'https://vimeo.com/1', created_at: '2020-01-01T00:00:00.000Z' }] } });
  assert.equal(bulk.data.inserted, 1);
  assert.equal((await call('DELETE', `/api/videos/${second.data.id}`, { token })).status, 204);
  assert.equal((await call('GET', '/api/videos', { token })).data.length, 2);
});

test('nadie ve ni toca lo de otro', async () => {
  const a = await signup();
  const b = await signup();
  const cat = await call('POST', '/api/categories', { token: a.token, body: { name: 'Mía' } });
  const video = await call('POST', '/api/videos', { token: a.token, body: { url: 'https://youtu.be/privado' } });
  assert.equal((await call('GET', '/api/videos', { token: b.token })).data.length, 0);
  assert.equal((await call('GET', '/api/categories', { token: b.token })).data.length, 0);
  assert.equal((await call('PATCH', `/api/videos/${video.data.id}`, { token: b.token, body: { description: 'x' } })).status, 404);
  await call('DELETE', `/api/videos/${video.data.id}`, { token: b.token });
  assert.equal((await call('GET', '/api/videos', { token: a.token })).data.length, 1);
  // B no puede poner su video en una categoría de A.
  assert.equal((await call('POST', '/api/videos', { token: b.token, body: { url: 'https://x.test/1', category_id: cat.data.id } })).status, 400);
  // El mismo link sí lo pueden guardar los dos.
  assert.equal((await call('POST', '/api/videos', { token: b.token, body: { url: 'https://youtu.be/privado' } })).status, 201);
});

test('código de 6 dígitos por correo', async () => {
  const { email } = await signup();
  const nobody = await call('POST', '/api/auth/otp', { body: { email: unique() } });
  assert.equal(nobody.status, 200); // misma respuesta aunque no exista
  mails.length = 0;
  assert.equal((await call('POST', '/api/auth/otp', { body: { email } })).status, 200);
  assert.equal((await call('POST', '/api/auth/otp', { body: { email } })).status, 429); // espera entre correos
  const code = mails.join('\n').match(/\b(\d{6})\b/)[1];
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  assert.equal((await call('POST', '/api/auth/verify', { body: { email, token: wrong } })).status, 403);
  const ok = await call('POST', '/api/auth/verify', { body: { email, token: code } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.session.access_token);
  assert.equal((await call('POST', '/api/auth/verify', { body: { email, token: code } })).status, 403); // solo una vez
});

test('recuperar contraseña con el enlace del correo', async () => {
  const { email, password } = await signup();
  mails.length = 0;
  await call('POST', '/api/auth/recover', { body: { email, redirect_to: 'https://malo.test/robar' } });
  const link = mails.join('\n').match(/https?:\/\/\S+/)[0];
  const linkUrl = new URL(link);
  // Un destino desconocido se cambia por la web configurada.
  assert.equal(linkUrl.searchParams.get('redirect_to'), 'https://ejemplo.test/videotk/');

  const res = await call('GET', linkUrl.pathname + linkUrl.search);
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://ejemplo.test/videotk/');
  const hash = new URLSearchParams(location.hash.slice(1));
  assert.equal(hash.get('type'), 'recovery');
  const token = hash.get('access_token');

  assert.equal((await call('PUT', '/api/auth/user', { token, body: { password } })).data.code, 'same_password');
  assert.equal((await call('PUT', '/api/auth/user', { token, body: { password: 'nueva-clave' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/token', { body: { email, password: 'nueva-clave' } })).status, 200);

  // Con un "Host" falso no se envía un enlace que apunte a otro sitio.
  const port = server.address().port;
  const poisoned = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/auth/recover', method: 'POST', headers: { Host: 'malo.test', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify({ email }));
  });
  assert.equal(poisoned, 500);

  // El enlace solo sirve una vez.
  const again = await call('GET', linkUrl.pathname + linkUrl.search);
  assert.equal(new URLSearchParams(new URL(again.headers.get('location')).hash.slice(1)).get('error_code'), 'otp_expired');
});

test('foto de perfil', async () => {
  const { token, session } = await signup();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
  assert.equal((await call('PUT', '/api/avatar', { token, raw: Buffer.from('<svg></svg>') })).status, 415);
  assert.equal((await call('PUT', '/api/avatar', { token, raw: jpeg })).status, 200);
  const photo = await fetch(`${base}/api/avatars/${session.user.id}/avatar.jpg`);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await photo.arrayBuffer()).length, jpeg.length);
  const url = `${base}/api/avatars/${session.user.id}/avatar.jpg?v=1`;
  const updated = await call('PUT', '/api/auth/user', { token, body: { data: { avatar_url: url } } });
  assert.equal(updated.data.user_metadata.avatar_url, url);
  assert.equal((await call('PUT', '/api/auth/user', { token, body: { data: { avatar_url: 'javascript:1' } } })).status, 400);
  assert.equal((await call('DELETE', '/api/avatar', { token })).status, 204);
  assert.equal((await fetch(`${base}/api/avatars/${session.user.id}/avatar.jpg`)).status, 404);
});

test('la web se sirve sin exponer otros archivos', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  const cfg = await (await fetch(`${base}/config.js`)).text();
  assert.match(cfg, /backend: 'api'/);
  assert.equal((await fetch(`${base}/api-client.js`)).status, 200);
  for (const path of ['/server/.env', '/server/package.json', '/supabase.sql', '/.git/config', '/icons/../server/src/config.js']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const cors = await fetch(`${base}/api/health`, { headers: { Origin: 'https://mikeoz27.github.io' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://mikeoz27.github.io');
  const noCors = await fetch(`${base}/api/health`, { headers: { Origin: 'https://malo.test' } });
  assert.equal(noCors.headers.get('access-control-allow-origin'), null);
});
