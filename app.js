'use strict';

const STORAGE_KEY = 'videoteca.items.v1';
const $ = (id) => document.getElementById(id);

const ui = {
  form: $('addForm'), url: $('urlInput'), paste: $('pasteBtn'), desc: $('descInput'),
  save: $('saveBtn'), status: $('status'), preview: $('preview'), previewImg: $('previewImg'),
  previewPh: $('previewPh'), previewSource: $('previewSource'), previewTitle: $('previewTitle'),
  search: $('search'), count: $('count'), list: $('list'), empty: $('empty'),
  editDialog: $('editDialog'), editForm: $('editForm'), editTitle: $('editTitle'), editDesc: $('editDesc'),
  backupDialog: $('backupDialog'), importFile: $('importFile'),
  newDialog: $('newDialog'), notice: $('notice'),
  viewer: $('viewer'), player: $('player'), viewerSource: $('viewerSource'),
  viewerTitle: $('viewerTitle'), viewerDesc: $('viewerDesc'), viewerOpen: $('viewerOpen'),
};

let items = load();
let draft = null;        // preview del link que se está escribiendo
let previewToken = 0;    // descarta respuestas de links anteriores
let previewPending = null;
let editingId = null;

/* ---------- Almacenamiento ---------- */

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.map(sanitizeItem).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return true;
  } catch {
    const message = 'No se pudo guardar: el almacenamiento del teléfono está lleno.';
    setStatus(message, true);
    notify(message, true);
    return false;
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
    createdAt: Number(raw.createdAt) || Date.now(),
  };
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
  if (!ui.newDialog.open) ui.newDialog.showModal();
}

function resetComposer() {
  clearTimeout(ui.url.debounce);
  ui.form.reset();
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
  ui.viewerSource.textContent = item.source || embed.label;
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
  meta.append(el('p', 'source', item.source), el('p', 'title', item.title || item.url));
  link.append(thumb, meta);
  card.append(link);

  if (item.description) card.append(el('p', 'desc', item.description));

  const actions = el('div', 'cardactions');
  const edit = el('button', 'ghost', '✎');
  edit.type = 'button';
  edit.setAttribute('aria-label', 'Editar');
  edit.addEventListener('click', () => openEditor(item.id));
  const remove = el('button', 'danger', '✕');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Borrar');
  remove.addEventListener('click', () => removeItem(item.id));
  actions.append(edit, remove);
  card.append(actions);
  return card;
}

function render() {
  const query = ui.search.value.trim().toLowerCase();
  const visible = items.filter((item) =>
    !query || `${item.title} ${item.description} ${item.source} ${item.url}`.toLowerCase().includes(query));

  ui.list.replaceChildren(...visible.map(renderCard));
  ui.count.textContent = items.length === 1 ? '1 video' : `${items.length} videos`;
  ui.empty.hidden = visible.length > 0;
  ui.empty.textContent = items.length ? 'Ningún video coincide con la búsqueda.' : 'Pulsa «+ Nuevo» para guardar tu primer video.';
}

function removeItem(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item || !confirm(`¿Borrar "${item.title || item.url}"?`)) return;
  items = items.filter((entry) => entry.id !== id);
  persist();
  render();
}

function openEditor(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  editingId = id;
  ui.editTitle.textContent = item.title || item.url;
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
  ui.save.disabled = false;

  items.unshift(sanitizeItem({ ...meta, url, description: ui.desc.value.trim(), createdAt: Date.now() }));
  if (!persist()) { items.shift(); return; }

  resetComposer();
  ui.newDialog.close();
  notify(meta.title ? 'Video guardado.' : 'Guardado sin preview: este sitio no la ofrece.');
  render();
});

$('newBtn').addEventListener('click', openComposer);
$('cancelNew').addEventListener('click', () => { resetComposer(); ui.newDialog.close(); });
ui.newDialog.addEventListener('close', resetComposer);

ui.search.addEventListener('input', render);

ui.editForm.addEventListener('submit', (event) => {
  if (event.submitter && event.submitter.value === 'ok') {
    const item = items.find((entry) => entry.id === editingId);
    if (item) {
      item.description = ui.editDesc.value.trim();
      persist();
      render();
    }
  }
});

$('menuBtn').addEventListener('click', () => ui.backupDialog.showModal());
$('closeBackup').addEventListener('click', () => ui.backupDialog.close());
$('importBtn').addEventListener('click', () => ui.importFile.click());

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = `videoteca-${new Date().toISOString().slice(0, 10)}.json`;
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
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming)) throw new Error('formato');
    const known = new Set(items.map((item) => videoKey(item.url)));
    const added = incoming.map(sanitizeItem).filter((item) => {
      if (!item || known.has(videoKey(item.url))) return false;
      known.add(videoKey(item.url));
      return true;
    });
    items = [...added, ...items].sort((a, b) => b.createdAt - a.createdAt);
    persist();
    render();
    notify(`Importación lista. Videos añadidos: ${added.length}.`);
  } catch {
    notify('Ese archivo no es una copia válida de Videoteca.', true);
  }
});

/* ---------- Inicio ---------- */

// Android puede abrir la app desde el menú Compartir con el link en la URL.
function readSharedLink() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (!shared) return;
  history.replaceState(null, '', location.pathname);
  openComposer();
  ui.url.value = normalizeUrl(shared) || shared;
  requestPreview();
}

render();
readSharedLink();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
