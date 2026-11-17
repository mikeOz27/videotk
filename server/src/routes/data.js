// Videos, categorías y foto de perfil. Cada consulta filtra por el usuario de la sesión:
// nadie puede ver ni tocar lo de otro (lo mismo que hacían las reglas RLS de supabase.sql).
import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { isForeignKeyError, isUniqueError } from '../db.js';
import { fail, nowIso, requireUser, UUID } from '../http.js';
import { sha256 } from '../security.js';

const VIDEO_COLUMNS = 'id, url, title, source, thumbnail, description, category_id, position, created_at';
const MAX_BULK = 5000;
const AVATAR_MAX = 1024 * 1024;

const text = (value, max) => String(value ?? '').slice(0, max);
const cleanName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

function httpUrl(value, field, required) {
  const raw = String(value ?? '').trim();
  if (!raw && !required) return '';
  try {
    const url = new URL(raw);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && raw.length <= 4096) return raw;
  } catch { /* abajo */ }
  return fail(400, 'validation_failed', `${field} debe ser un link http(s).`);
}

function categoryId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'validation_failed', 'category_id no es válido.');
  return value.toLowerCase();
}

function position(value) {
  if (value === null || value === undefined) return -Date.now() / 1000; // los nuevos quedan arriba
  const number = Number(value);
  if (!Number.isFinite(number)) fail(400, 'validation_failed', 'position debe ser un número.');
  return number;
}

function createdAt(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : nowIso();
}

function videoRow(userId, body) {
  const url = httpUrl(body.url, 'url', true);
  return {
    id: randomUUID(),
    user_id: userId,
    url,
    url_key: sha256(url),
    title: text(body.title, 300),
    source: text(body.source, 80),
    thumbnail: httpUrl(body.thumbnail, 'thumbnail', false),
    description: text(body.description, 5000),
    category_id: categoryId(body.category_id),
    position: position(body.position),
    created_at: createdAt(body.created_at),
  };
}

const VIDEO_FIELDS = ['id', 'user_id', 'url', 'url_key', 'title', 'source', 'thumbnail', 'description', 'category_id', 'position', 'created_at'];
const values = (row) => VIDEO_FIELDS.map((field) => row[field]);
const insertVideoSql = `videos (${VIDEO_FIELDS.join(', ')}) VALUES (${VIDEO_FIELDS.map(() => '?').join(', ')})`;

// Imagen JPEG, PNG o WebP según sus primeros bytes (no se confía en lo que diga el navegador).
function imageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

export function dataRoutes(db) {
  const router = Router();

  // La categoría tiene que ser del mismo usuario.
  async function checkCategory(userId, id) {
    if (!id) return;
    const row = await db.get('SELECT id FROM categories WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) fail(400, '23503', 'Esa categoría no existe.');
  }

  /* ---------- Videos ---------- */

  router.get('/videos', requireUser, async (req, res) => {
    res.json(await db.all(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE user_id = ? ORDER BY position ASC, created_at DESC`, [req.userId]));
  });

  router.post('/videos', requireUser, async (req, res) => {
    const row = videoRow(req.userId, req.body || {});
    await checkCategory(req.userId, row.category_id);
    try {
      await db.run(`INSERT INTO ${insertVideoSql}`, values(row));
    } catch (error) {
      if (isUniqueError(error)) fail(409, '23505', 'Este link ya está guardado.');
      throw error;
    }
    res.status(201).json(await db.get(`SELECT ${VIDEO_COLUMNS} FROM videos WHERE id = ?`, [row.id]));
  });

  // Importar varios de una vez: los links que ya estén guardados se saltan.
  router.post('/videos/bulk', requireUser, async (req, res) => {
    const list = Array.isArray(req.body && req.body.rows) ? req.body.rows : fail(400, 'validation_failed', 'Falta la lista rows.');
    if (list.length > MAX_BULK) fail(413, 'too_many_rows', `Máximo ${MAX_BULK} videos por vez.`);
    const rows = list.map((body) => videoRow(req.userId, body || {}));
    for (const id of new Set(rows.map((row) => row.category_id).filter(Boolean))) await checkCategory(req.userId, id);
    let inserted = 0;
    for (const row of rows) inserted += (await db.run(db.insertIgnore(insertVideoSql), values(row))).changes;
    res.json({ inserted });
  });

  router.patch('/videos/:id', requireUser, async (req, res) => {
    const body = req.body || {};
    const sets = [];
    const params = [];
    if ('description' in body) { sets.push('description = ?'); params.push(text(body.description, 5000)); }
    if ('category_id' in body) {
      const id = categoryId(body.category_id);
      await checkCategory(req.userId, id);
      sets.push('category_id = ?');
      params.push(id);
    }
    if ('position' in body) { sets.push('position = ?'); params.push(position(body.position)); }
    if ('title' in body) { sets.push('title = ?'); params.push(text(body.title, 300)); }
    if (!sets.length) fail(400, 'validation_failed', 'No hay nada que cambiar.');
    const { changes } = await db.run(`UPDATE videos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...params, req.params.id, req.userId]);
    if (!changes) fail(404, 'not_found', 'Ese video no existe.');
    res.status(204).end();
  });

  router.delete('/videos/:id', requireUser, async (req, res) => {
    await db.run('DELETE FROM videos WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    res.status(204).end();
  });

  /* ---------- Categorías ---------- */

  router.get('/categories', requireUser, async (req, res) => {
    const rows = await db.all('SELECT id, name FROM categories WHERE user_id = ?', [req.userId]);
    rows.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    res.json(rows);
  });

  router.post('/categories', requireUser, async (req, res) => {
    const name = cleanName(req.body && req.body.name);
    if (!name) fail(400, 'validation_failed', 'Falta el nombre.');
    const id = randomUUID();
    try {
      await db.run('INSERT INTO categories (id, user_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)', [id, req.userId, name, name.toLowerCase(), nowIso()]);
    } catch (error) {
      if (isUniqueError(error)) fail(409, '23505', 'Ya tienes una categoría con ese nombre.');
      throw error;
    }
    res.status(201).json({ id, name });
  });

  router.patch('/categories/:id', requireUser, async (req, res) => {
    const name = cleanName(req.body && req.body.name);
    if (!name) fail(400, 'validation_failed', 'Falta el nombre.');
    let changes;
    try {
      ({ changes } = await db.run('UPDATE categories SET name = ?, name_key = ? WHERE id = ? AND user_id = ?', [name, name.toLowerCase(), req.params.id, req.userId]));
    } catch (error) {
      if (isUniqueError(error)) fail(409, '23505', 'Ya tienes una categoría con ese nombre.');
      throw error;
    }
    if (!changes) fail(404, 'not_found', 'Esa categoría no existe.');
    res.status(204).end();
  });

  // Una categoría con videos no se borra: primero hay que cambiarlos de categoría.
  router.delete('/categories/:id', requireUser, async (req, res) => {
    const used = await db.get('SELECT 1 AS used FROM videos WHERE category_id = ? AND user_id = ? LIMIT 1', [req.params.id, req.userId]);
    if (used) fail(409, '23503', 'La categoría tiene videos.');
    try {
      await db.run('DELETE FROM categories WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    } catch (error) {
      if (isForeignKeyError(error)) fail(409, '23503', 'La categoría tiene videos.');
      throw error;
    }
    res.status(204).end();
  });

  /* ---------- Foto de perfil ---------- */

  router.put('/avatar', requireUser, express.raw({ type: () => true, limit: AVATAR_MAX }), async (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = imageType(data);
    if (!mime) fail(415, 'invalid_mime_type', 'La foto debe ser JPEG, PNG o WebP.');
    const now = nowIso();
    const { changes } = await db.run('UPDATE avatars SET mime = ?, data = ?, updated_at = ? WHERE user_id = ?', [mime, data, now, req.userId]);
    if (!changes) await db.run('INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)', [req.userId, mime, data, now]);
    res.json({ path: `${req.userId}/avatar.jpg` });
  });

  router.delete('/avatar', requireUser, async (req, res) => {
    await db.run('DELETE FROM avatars WHERE user_id = ?', [req.userId]);
    res.status(204).end();
  });

  // Pública (como el bucket "avatars" de Supabase): la app la muestra con una etiqueta <img>.
  router.get('/avatars/:userId/avatar.jpg', async (req, res) => {
    const row = UUID.test(req.params.userId) && await db.get('SELECT mime, data, updated_at FROM avatars WHERE user_id = ?', [req.params.userId.toLowerCase()]);
    if (!row) fail(404, 'not_found', 'Sin foto.');
    res.set({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=3600', 'Last-Modified': new Date(row.updated_at).toUTCString(), 'X-Content-Type-Options': 'nosniff' });
    res.send(Buffer.from(row.data));
  });

  return router;
}
