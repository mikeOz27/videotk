'use strict';

const CONFIG = window.VIDEOTECA_CONFIG || {};
const LEGACY_KEY = 'videoteca.items.v1'; // videos guardados antes de tener cuenta
const COLUMNS = 'id,url,title,source,thumbnail,description,category,created_at';
const FILTER_KEY = 'videotk.filter';
const $ = (id) => document.getElementById(id);

const ui = {
  authView: $('authView'), appView: $('appView'), authForm: $('authForm'), authEmail: $('authEmail'),
  authPassword: $('authPassword'), authBtn: $('authBtn'), authStatus: $('authStatus'),
  accountEmail: $('accountEmail'),
  form: $('addForm'), url: $('urlInput'), paste: $('pasteBtn'), desc: $('descInput'),
  save: $('saveBtn'), status: $('status'), preview: $('preview'), previewImg: $('previewImg'),
  previewPh: $('previewPh'), previewSource: $('previewSource'), previewTitle: $('previewTitle'),
  search: $('search'), count: $('count'), list: $('list'), empty: $('empty'),
  editDialog: $('editDialog'), editForm: $('editForm'), editTitle: $('editTitle'), editDesc: $('editDesc'),
  backupDialog: $('backupDialog'), importFile: $('importFile'),
  newDialog: $('newDialog'), notice: $('notice'),
  viewer: $('viewer'), player: $('player'), viewerSource: $('viewerSource'),
  viewerTitle: $('viewerTitle'), viewerDesc: $('viewerDesc'), viewerOpen: $('viewerOpen'),
  cat: $('catInput'), catChips: $('catChips'), editCat: $('editCat'), editCatChips: $('editCatChips'),
  filters: $('filters'),
};

let db = null;           // cliente de Supabase
let user = null;         // usuario con sesión iniciada
let items = [];
let draft = null;        // preview del link que se está escribiendo
let previewToken = 0;    // descarta respuestas de links anteriores
let previewPending = null;
let editingId = null;
let sharedPending = '';  // link compartido desde otra app antes de iniciar sesión
let activeFilter = null; // null = todas; '' = sin categoría; texto = esa categoría
try { const saved = localStorage.getItem(FILTER_KEY); if (saved !== null) activeFilter = JSON.parse(saved); } catch { /* sin filtro */ }
if (activeFilter !== null && typeof activeFilter !== 'string') activeFilter = null;

/* ---------- Base de datos ---------- */

// Las consultas de Supabase devuelven { data, error }; esto cubre también los fallos de red.
async function run(query) {
  try {
    return await query;
  } catch (error) {
    return { data: null, error };
  }
}

// Copia en el teléfono para abrir la lista rápido y verla sin conexión.
function cacheKey() {
  return `videoteca.cache.${user.id}`;
}

function readCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey()) || '[]');
    return Array.isArray(parsed) ? parsed.map(sanitizeItem).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeCache() {
  try { localStorage.setItem(cacheKey(), JSON.stringify(items)); } catch { /* sin espacio: no es grave */ }
}

function fromRow(row) {
  return sanitizeItem({ ...row, createdAt: Date.parse(row.created_at) });
}

function toRow(item) {
  return {
    user_id: user.id,
    url: item.url,
    title: item.title,
    source: item.source,
    thumbnail: item.thumbnail,
    description: item.description,
    category: item.category,
  };
}

async function loadItems() {
  items = readCache();
  render();
  const { data, error } = await run(db.from('videos').select(COLUMNS).order('created_at', { ascending: false }));
  if (error) {
    notify('Sin conexión con tu cuenta: se muestra la última copia de este teléfono.', true);
    return;
  }
  items = data.map(fromRow).filter(Boolean);
  writeCache();
  render();
}

// Sube los videos que no estén ya en la cuenta. Devuelve cuántos subió.
async function uploadItems(list) {
  const known = new Set(items.map((item) => videoKey(item.url)));
  const rows = [];
  for (const item of list) {
    if (!item || known.has(videoKey(item.url))) continue;
    known.add(videoKey(item.url));
    rows.push({ ...toRow(item), created_at: new Date(item.createdAt).toISOString() });
  }
  if (!rows.length) return 0;
  const { error } = await run(db.from('videos').upsert(rows, { onConflict: 'user_id,url', ignoreDuplicates: true }));
  if (error) throw error;
  await loadItems();
  return rows.length;
}

// Los videos guardados antes de tener login se ofrecen para subir una sola vez.
async function migrateLegacy() {
  let legacy = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    legacy = Array.isArray(parsed) ? parsed.map(sanitizeItem).filter(Boolean) : [];
  } catch { /* datos dañados: se ignoran */ }
  if (!legacy.length) return;
  if (!confirm(`Hay ${legacy.length} videos guardados solo en este teléfono. ¿Subirlos a tu cuenta?`)) return;
  try {
    const added = await uploadItems(legacy);
    localStorage.setItem(`${LEGACY_KEY}.subidos`, localStorage.getItem(LEGACY_KEY));
    localStorage.removeItem(LEGACY_KEY);
    notify(`Listo: ${added} videos subidos a tu cuenta.`);
  } catch {
    notify('No se pudieron subir tus videos. Se volverá a intentar la próxima vez.', true);
  }
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = safeHttpUrl(raw.url);
  if (!url) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    url,
    title: String(raw.title || '').slice(0, 300),
    source: String(raw.source || hostOf(url)).slice(0, 80),
    thumbnail: safeHttpUrl(raw.thumbnail),
    description: String(raw.description || '').slice(0, 5000),
    category: cleanCategory(raw.category),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

/* ---------- Categorías ---------- */

function cleanCategory(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Categorías usadas, de la más usada a la menos: [{ name, count }].
function categories() {
  const counts = new Map();
  for (const item of items) if (item.category) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

// "zelda" se guarda como "Zelda" si esa categoría ya existe, para no duplicarlas.
function matchCategory(value) {
  const clean = cleanCategory(value);
  const existing = categories().find(({ name }) => name.toLowerCase() === clean.toLowerCase());
  return existing ? existing.name : clean;
}

function chip(label, pressed, onClick) {
  const button = el('button', 'chip', label);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

// Sugerencias debajo del campo Categoría: tocar una la elige; tocarla otra vez la quita.
function renderCategoryChips(input, container) {
  const current = cleanCategory(input.value).toLowerCase();
  container.replaceChildren(...categories().map(({ name }) => chip(name, name.toLowerCase() === current, () => {
    input.value = name.toLowerCase() === cleanCategory(input.value).toLowerCase() ? '' : name;
    renderCategoryChips(input, container);
  })));
  container.hidden = !container.children.length;
}

function setFilter(value) {
  activeFilter = value;
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(value)); } catch { /* no es grave */ }
  render();
}

// El filtro guardado solo se aplica si esa categoría existe en la lista actual.
// No se borra si no existe: al abrir la app la lista empieza vacía hasta que carga.
function currentFilter() {
  if (activeFilter === null) return null;
  if (activeFilter === '') return items.some((item) => !item.category) && categories().length ? '' : null;
  return items.some((item) => item.category === activeFilter) ? activeFilter : null;
}

function renderFilters() {
  const cats = categories();
  const filter = currentFilter();
  const uncategorized = items.filter((item) => !item.category).length;

  ui.filters.hidden = !cats.length;
  if (!cats.length) { ui.filters.replaceChildren(); return; }
  const chips = [chip(`Todas · ${items.length}`, filter === null, () => setFilter(null))];
  for (const { name, count } of cats) chips.push(chip(`${name} · ${count}`, filter === name, () => setFilter(name)));
  if (uncategorized) chips.push(chip(`Sin categoría · ${uncategorized}`, filter === '', () => setFilter('')));
  ui.filters.replaceChildren(...chips);
  const pressed = ui.filters.querySelector('[aria-pressed="true"]');
  if (pressed && filter !== null) pressed.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* ---------- Links y preview ---------- */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^(www|m|vm|vt)\./, ''); } catch { return ''; }
}

// Acepta texto compartido ("Mira esto https://…") y links sin https://.
function normalizeUrl(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const embedded = value.match(/https?:\/\/[^\s<>"']+/i);
  if (embedded) return safeHttpUrl(embedded[0]);
  if (/^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/.test(value)) return safeHttpUrl(`https://${value}`);
  return '';
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.split('/')[1] || '';
    if (host !== 'youtube.com') return '';
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const match = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]+)/);
    return match ? match[2] : '';
  } catch {
    return '';
  }
}

async function getJson(url, ms = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal, referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fromNoembed(url) {
  const data = await getJson(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
  if (data.error) throw new Error(data.error);
  return { title: data.title, thumbnail: data.thumbnail_url, source: data.provider_name };
}

async function fromTikTok(url) {
  const data = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
  return { title: data.title, thumbnail: data.thumbnail_url, source: 'TikTok' };
}

async function fromMicrolink(url) {
  const { data } = await getJson(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, 10000);
  return { title: data.title, thumbnail: data.image && data.image.url, source: data.publisher };
}

async function fetchMetadata(url) {
  const ytId = youtubeId(url);
  const result = {
    url,
    title: '',
    source: ytId ? 'YouTube' : hostOf(url),
    thumbnail: ytId ? `https://i.ytimg.com/vi/${encodeURIComponent(ytId)}/hqdefault.jpg` : '',
  };
  const providers = /tiktok\.com$/i.test(hostOf(url))
    ? [fromTikTok, fromNoembed, fromMicrolink]
    : [fromNoembed, fromMicrolink];

  for (const provider of providers) {
    try {
      const meta = await provider(url);
      result.title = result.title || String(meta.title || '');
      result.thumbnail = result.thumbnail || safeHttpUrl(meta.thumbnail);
      if (meta.source && !ytId) result.source = String(meta.source);
    } catch { /* se prueba el siguiente servicio */ }
    if (result.title && result.thumbnail) break;
  }
  return result;
}

function setThumb(img, placeholder, src) {
  placeholder.hidden = false;
  img.hidden = true;
  img.onload = () => { img.hidden = false; placeholder.hidden = true; };
  img.onerror = () => { img.hidden = true; placeholder.hidden = false; };
  if (src) img.src = src; else img.removeAttribute('src');
}

function showPreview(meta, loading) {
  ui.preview.hidden = false;
  ui.previewSource.textContent = meta.source || hostOf(meta.url);
  ui.previewTitle.textContent = loading ? 'Buscando la preview…' : (meta.title || 'Sin título');
  setThumb(ui.previewImg, ui.previewPh, meta.thumbnail);
}

function clearPreview() {
  previewToken += 1;
  previewPending = null;
  draft = null;
  ui.preview.hidden = true;
}

// El mismo video de YouTube puede llegar como youtu.be, /shorts o watch?v=.
function videoKey(url) {
  const id = youtubeId(url);
  return id ? `youtube:${id}` : url;
}

function findDuplicate(url) {
  const key = videoKey(url);
  return items.find((item) => videoKey(item.url) === key);
}

function requestPreview() {
  const url = normalizeUrl(ui.url.value);
  if (!url) {
    clearPreview();
    setStatus(ui.url.value.trim() ? 'Ese texto no parece un link válido.' : '', Boolean(ui.url.value.trim()));
    return Promise.resolve(null);
  }
  if (draft && draft.url === url) return Promise.resolve(draft);
  if (previewPending && previewPending.url === url) return previewPending.promise;

  const token = ++previewToken;
  const ytId = youtubeId(url);
  showPreview({
    url,
    source: ytId ? 'YouTube' : hostOf(url),
    thumbnail: ytId ? `https://i.ytimg.com/vi/${encodeURIComponent(ytId)}/hqdefault.jpg` : '',
  }, true);
  setStatus(findDuplicate(url) ? 'Este link ya está guardado.' : '', Boolean(findDuplicate(url)));

  const promise = fetchMetadata(url).then((meta) => {
    if (token !== previewToken) return null;
    draft = meta;
    previewPending = null;
    showPreview(meta, false);
    return meta;
  });
  previewPending = { url, promise };
  return promise;
}

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

// Mensaje en la pantalla principal (fuera de la ventana de Nuevo).
function notify(message, isError = false) {
  clearTimeout(ui.notice.timer);
  ui.notice.textContent = message;
  ui.notice.classList.toggle('error', isError);
  ui.notice.hidden = false;
  ui.notice.timer = setTimeout(() => { ui.notice.hidden = true; }, 4000);
}

function openComposer() {
  if (ui.newDialog.open) return;
  // Si estás viendo una categoría, el video nuevo va a esa categoría (se puede cambiar).
  if (!ui.cat.value && currentFilter()) ui.cat.value = currentFilter();
  renderCategoryChips(ui.cat, ui.catChips);
  ui.newDialog.showModal();
}

function resetComposer() {
  clearTimeout(ui.url.debounce);
  ui.form.reset();
  renderCategoryChips(ui.cat, ui.catChips);
  clearPreview();
  setStatus('');
  ui.save.disabled = false;
}

/* ---------- Visor ---------- */

// "90", "1m30s" o "1h2m3s" → segundos.
function parseStart(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return match ? (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0) : 0;
}

// Devuelve cómo reproducir el link dentro de la app, o null si el sitio no lo permite.
function embedFor(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = hostOf(url);

  const ytId = youtubeId(url);
  if (ytId) {
    const start = parseStart(u.searchParams.get('t') || u.searchParams.get('start'));
    const params = new URLSearchParams({ autoplay: '1', playsinline: '1', rel: '0' });
    if (start) params.set('start', String(start));
    return {
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}?${params}`,
      vertical: u.pathname.startsWith('/shorts/'),
      label: 'YouTube',
    };
  }

  const vimeo = host === 'vimeo.com' && u.pathname.match(/\/(\d{5,})(?:\/|$)/);
  if (vimeo) return { src: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1`, vertical: false, label: 'Vimeo' };

  const tiktok = /(^|\.)tiktok\.com$/.test(host) && u.pathname.match(/\/video\/(\d+)/);
  if (tiktok) return { src: `https://www.tiktok.com/player/v1/${tiktok[1]}?autoplay=1`, vertical: true, label: 'TikTok' };

  return null;
}

function openViewer(item) {
  const embed = embedFor(item.url);
  if (!embed) return false;

  const frame = document.createElement('iframe');
  frame.src = embed.src;
  frame.title = item.title || 'Video';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';

  ui.player.classList.toggle('vertical', embed.vertical);
  ui.player.replaceChildren(frame);
  ui.viewerSource.textContent = [item.source || embed.label, item.category].filter(Boolean).join(' · ');
  ui.viewerTitle.textContent = item.title || item.url;
  ui.viewerDesc.textContent = item.description || '';
  ui.viewerOpen.href = item.url;
  ui.viewerOpen.textContent = `Abrir en ${embed.label}`;
  ui.viewer.showModal();
  return true;
}

// Al cerrar se quita el iframe para que el video deje de sonar.
function closeViewer() {
  ui.player.replaceChildren();
  if (ui.viewer.open) ui.viewer.close();
}
ui.viewer.addEventListener('close', () => ui.player.replaceChildren()); // tecla Esc / botón atrás
$('closeViewer').addEventListener('click', closeViewer);
ui.viewerOpen.addEventListener('click', closeViewer);

/* ---------- Lista ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Iconos dibujados con SVG (se ven igual en todos los teléfonos y toman el color del botón).
const ICONS = {
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  trash: ['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6'],
};

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  ICONS[name].forEach((d) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  });
  return svg;
}

function renderCard(item) {
  const card = el('li', 'card');

  const link = el('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  // Si el sitio se puede ver dentro de la app, abre el visor; si no, el link normal.
  link.addEventListener('click', (event) => {
    if (openViewer(item)) event.preventDefault();
  });

  const thumb = el('div', 'thumb');
  const img = el('img');
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  const placeholder = el('span', 'ph', '▶');
  thumb.append(img, placeholder);
  setThumb(img, placeholder, item.thumbnail);

  const meta = el('div', 'meta');
  const source = el('p', 'source', item.source);
  if (item.category) source.append(' · ', el('span', 'cattag', item.category));
  meta.append(source, el('p', 'title', item.title || item.url));
  link.append(thumb, meta);
  card.append(link);

  if (item.description) card.append(el('p', 'desc', item.description));

  const actions = el('div', 'cardactions');
  const edit = el('button', 'ghost');
  edit.type = 'button';
  edit.append(icon('edit'));
  edit.setAttribute('aria-label', 'Editar');
  edit.title = 'Editar';
  edit.addEventListener('click', () => openEditor(item.id));
  const remove = el('button', 'danger');
  remove.type = 'button';
  remove.append(icon('trash'));
  remove.setAttribute('aria-label', 'Eliminar');
  remove.title = 'Eliminar';
  remove.addEventListener('click', () => removeItem(item.id));
  actions.append(edit, remove);
  card.append(actions);
  return card;
}

function render() {
  renderFilters();
  const filter = currentFilter();
  const query = ui.search.value.trim().toLowerCase();
  const visible = items.filter((item) =>
    (filter === null || item.category === filter)
    && (!query || `${item.title} ${item.description} ${item.category} ${item.source} ${item.url}`.toLowerCase().includes(query)));

  ui.list.replaceChildren(...visible.map(renderCard));
  const total = items.length === 1 ? '1 video' : `${items.length} videos`;
  ui.count.textContent = visible.length === items.length ? total : `${visible.length} de ${total}`;
  ui.empty.hidden = visible.length > 0;
  ui.empty.textContent = !items.length ? 'Pulsa «+ Nuevo» para guardar tu primer video.'
    : query ? 'Ningún video coincide con la búsqueda.'
    : 'No hay videos en esta categoría.';
}

// Pregunta Sí/No con SweetAlert2; si la librería no cargó, usa la del navegador.
// Se usa `text` (no `html`) para que el título del video nunca se interprete como HTML.
async function askConfirm({ title, text, confirmText, danger = false }) {
  if (!window.Swal) return confirm(text ? `${title}\n\n${text}` : title);
  const result = await window.Swal.fire({
    title,
    text,
    icon: danger ? 'warning' : 'question',
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: 'Cancelar',
    reverseButtons: true,
    focusCancel: danger,
    buttonsStyling: false,
    customClass: {
      popup: 'swal-vt',
      confirmButton: danger ? 'danger-solid' : 'primary',
      cancelButton: 'ghost',
    },
  });
  return result.isConfirmed;
}

async function removeItem(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  const ok = await askConfirm({
    title: '¿Eliminar este video?',
    text: item.title || item.url,
    confirmText: 'Sí, eliminar',
    danger: true,
  });
  if (!ok) return;
  const { error } = await run(db.from('videos').delete().eq('id', id));
  if (error) return notify('No se pudo borrar. Revisa tu conexión.', true);
  items = items.filter((entry) => entry.id !== id);
  writeCache();
  render();
}

function openEditor(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  editingId = id;
  ui.editTitle.textContent = item.title || item.url;
  ui.editCat.value = item.category;
  renderCategoryChips(ui.editCat, ui.editCatChips);
  ui.editDesc.value = item.description;
  ui.editDialog.showModal();
}

/* ---------- Eventos ---------- */

ui.url.addEventListener('input', () => {
  clearTimeout(ui.url.debounce);
  ui.url.debounce = setTimeout(requestPreview, 350);
});

ui.paste.addEventListener('click', async () => {
  try {
    ui.url.value = await navigator.clipboard.readText();
    requestPreview();
  } catch {
    ui.url.focus();
    setStatus('Mantén pulsado el campo y elige Pegar.');
  }
});

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearTimeout(ui.url.debounce);
  const url = normalizeUrl(ui.url.value);
  if (!url) return setStatus('Ese texto no parece un link válido.', true);
  if (findDuplicate(url)) return setStatus('Este link ya está guardado.', true);

  ui.save.disabled = true;
  setStatus('Guardando…');
  const meta = (await requestPreview()) || { url, title: '', source: hostOf(url), thumbnail: '' };
  const item = sanitizeItem({ ...meta, url, description: ui.desc.value.trim(), category: matchCategory(ui.cat.value) });
  const { data, error } = await run(db.from('videos').insert(toRow(item)).select(COLUMNS).single());
  ui.save.disabled = false;
  if (error) {
    return setStatus(error.code === '23505' ? 'Este link ya está guardado.' : 'No se pudo guardar. Revisa tu conexión.', true);
  }

  const saved = fromRow(data);
  const filter = currentFilter();
  items.unshift(saved);
  writeCache();
  resetComposer();
  ui.newDialog.close();
  // Que el video recién guardado se vea aunque hubiera otro filtro puesto.
  if (filter !== null && filter !== saved.category) setFilter(saved.category || null);
  notify(meta.title ? 'Video guardado.' : 'Guardado sin preview: este sitio no la ofrece.');
  render();
});

$('newBtn').addEventListener('click', openComposer);
$('cancelNew').addEventListener('click', () => { resetComposer(); ui.newDialog.close(); });
ui.newDialog.addEventListener('close', resetComposer);

ui.search.addEventListener('input', render);
ui.cat.addEventListener('input', () => renderCategoryChips(ui.cat, ui.catChips));
ui.editCat.addEventListener('input', () => renderCategoryChips(ui.editCat, ui.editCatChips));

ui.editForm.addEventListener('submit', async (event) => {
  if (!event.submitter || event.submitter.value !== 'ok') return;
  const item = items.find((entry) => entry.id === editingId);
  if (!item) return;
  const description = ui.editDesc.value.trim();
  const category = matchCategory(ui.editCat.value);
  const { error } = await run(db.from('videos').update({ description, category }).eq('id', item.id));
  if (error) return notify('No se pudo guardar el cambio. Revisa tu conexión.', true);
  item.description = description;
  const filter = currentFilter();
  const moved = filter !== null && filter !== category;
  item.category = category;
  if (moved) notify(category ? `Movido a «${category}».` : 'Movido a «Sin categoría».');
  writeCache();
  render();
});

$('menuBtn').addEventListener('click', () => ui.backupDialog.showModal());
$('closeBackup').addEventListener('click', () => ui.backupDialog.close());
$('importBtn').addEventListener('click', () => ui.importFile.click());

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = `videotk-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
});

ui.importFile.addEventListener('change', async () => {
  const [file] = ui.importFile.files;
  ui.importFile.value = '';
  if (!file) return;
  ui.backupDialog.close();
  try {
    let incoming;
    try {
      incoming = JSON.parse(await file.text());
      if (!Array.isArray(incoming)) throw new Error('formato');
    } catch {
      return notify('Ese archivo no es una copia válida de VideoTk.', true);
    }
    const added = await uploadItems(incoming.map(sanitizeItem));
    notify(`Importación lista. Videos añadidos: ${added}.`);
  } catch {
    notify('No se pudo importar. Revisa tu conexión.', true);
  }
});

async function logout() {
  const ok = await askConfirm({
    title: '¿Cerrar sesión?',
    text: 'Tus videos siguen guardados en tu cuenta.',
    confirmText: 'Sí, salir',
  });
  if (!ok) return;
  if (ui.backupDialog.open) ui.backupDialog.close();
  try { localStorage.removeItem(cacheKey()); } catch { /* nada que borrar */ }
  await run(db.auth.signOut({ scope: 'local' }));
  await applySession(null);
}

$('logoutBtn').addEventListener('click', logout);
$('logoutTopBtn').addEventListener('click', logout);

/* ---------- Login ---------- */

function setAuthStatus(message, isError = false) {
  ui.authStatus.textContent = message;
  ui.authStatus.classList.toggle('error', isError);
}

function showView(loggedIn) {
  ui.authView.hidden = loggedIn;
  ui.appView.hidden = !loggedIn;
}

async function applySession(session) {
  const next = session ? session.user : null;
  if ((next && next.id) === (user && user.id)) return;
  user = next;
  [ui.newDialog, ui.viewer, ui.editDialog, ui.backupDialog].forEach((dialog) => { if (dialog.open) dialog.close(); });

  if (!user) {
    items = [];
    render();
    showView(false);
    return;
  }

  ui.accountEmail.textContent = user.email || '';
  showView(true);
  await loadItems();
  await migrateLegacy();
  if (sharedPending) {
    openComposer();
    ui.url.value = normalizeUrl(sharedPending) || sharedPending;
    sharedPending = '';
    requestPreview();
  }
}

let signingUp = false;
const authConfirmRow = $('authConfirmRow');
const authConfirm = $('authConfirm');
const authSwitch = $('authSwitch');
const authSwitchText = $('authSwitchText');

function setAuthMode(signup) {
  signingUp = signup;
  authConfirmRow.hidden = !signup;
  authConfirm.required = signup;
  authConfirm.value = '';
  ui.authPassword.autocomplete = signup ? 'new-password' : 'current-password';
  ui.authBtn.textContent = signup ? 'Crear cuenta' : 'Entrar';
  authSwitchText.textContent = signup ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?';
  authSwitch.textContent = signup ? 'Entrar' : 'Crear cuenta';
  setAuthStatus('');
}

authSwitch.addEventListener('click', () => setAuthMode(!signingUp));

function authErrorMessage(error) {
  const code = error.code || '';
  if (code === 'email_not_confirmed') return 'Primero confirma tu correo: abre el enlace que te enviamos.';
  if (code === 'user_already_exists' || code === 'email_exists') return 'Ese correo ya tiene cuenta. Entra con tu contraseña.';
  if (code === 'weak_password') return 'La contraseña es muy débil. Usa al menos 6 caracteres.';
  if (code === 'signup_disabled') return 'El registro de cuentas nuevas está cerrado.';
  if (code === 'over_email_send_rate_limit' || error.status === 429) return 'Demasiados intentos. Espera un rato y vuelve a probar.';
  if (code === 'email_address_invalid') return 'Ese correo no es válido.';
  if (!signingUp && error.status === 400) return 'Correo o contraseña incorrectos.';
  return signingUp ? 'No se pudo crear la cuenta. Revisa tu conexión.' : 'No se pudo entrar. Revisa tu conexión.';
}

ui.authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!db) return;
  const email = ui.authEmail.value.trim();
  const password = ui.authPassword.value;
  if (signingUp && password !== authConfirm.value) {
    setAuthStatus('Las contraseñas no coinciden.', true);
    return;
  }

  ui.authBtn.disabled = true;
  setAuthStatus(signingUp ? 'Creando cuenta…' : 'Entrando…');
  const { data, error } = await run(signingUp
    ? db.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
    : db.auth.signInWithPassword({ email, password }));
  ui.authBtn.disabled = false;
  if (error) {
    setAuthStatus(authErrorMessage(error), true);
    return;
  }

  if (signingUp && !data.session) {
    // Con la confirmación por correo activada, Supabase no da sesión hasta confirmar.
    // Si el correo ya existía, devuelve un usuario sin identidades.
    const exists = data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0;
    setAuthMode(false);
    ui.authPassword.value = '';
    setAuthStatus(exists
      ? 'Ese correo ya tiene cuenta. Entra con tu contraseña.'
      : 'Te enviamos un correo para confirmar la cuenta. Ábrelo y luego entra aquí.', exists);
    return;
  }

  ui.authPassword.value = '';
  setAuthMode(false);
  await applySession(data.session);
});

/* ---------- Inicio ---------- */

// Android puede abrir la app desde el menú Compartir con el link en la URL.
function readSharedLink() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (!shared) return;
  history.replaceState(null, '', location.pathname);
  sharedPending = shared; // se abre en cuanto haya sesión
}

async function init() {
  readSharedLink();
  render();

  if (!window.supabase || !CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    showView(false);
    ui.authBtn.disabled = true;
    setAuthStatus(window.supabase
      ? 'Falta poner los datos de Supabase en config.js.'
      : 'No se pudo cargar la app. Revisa tu conexión y recarga.', true);
    return;
  }

  db = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
  // setTimeout: Supabase recomienda no llamar a la base de datos dentro de este aviso.
  db.auth.onAuthStateChange((_event, session) => { setTimeout(() => applySession(session), 0); });
  const { data } = await run(db.auth.getSession());
  await applySession(data && data.session);
  if (!user) showView(false);
}

init();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
