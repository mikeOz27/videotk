'use strict';

const CONFIG = window.VIDEOTECA_CONFIG || {};
const LEGACY_KEY = 'videoteca.items.v1'; // videos guardados antes de tener cuenta
const COLUMNS = 'id,url,title,source,thumbnail,description,category_id,position,created_at';
const FILTER_KEY = 'videotk.filter';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const $ = (id) => document.getElementById(id);
// Dentro de la app de Android/iOS (Capacitor) la página vive en https://localhost:
// los enlaces de los correos (confirmar cuenta, cambiar contraseña) deben ir a la web publicada.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const APP_URL = IS_NATIVE ? 'https://mikeoz27.github.io/videotk/' : location.origin + location.pathname;

// Intro con el logo (la activa el script del <head>): dura ~1.7 s y luego se desvanece mientras entra el login.
(function finishIntro() {
  const root = document.documentElement;
  if (!root.classList.contains('show-intro')) return;
  try { sessionStorage.setItem('videotk.intro', '1'); } catch { /* se verá de nuevo al recargar */ }
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    root.classList.add('intro-out');
    setTimeout(() => root.classList.remove('show-intro', 'intro-out'), 550);
  }, quick ? 300 : 1700);
}());

const ui = {
  authView: $('authView'), appView: $('appView'), authForm: $('authForm'), authEmail: $('authEmail'),
  authPassword: $('authPassword'), authBtn: $('authBtn'), authStatus: $('authStatus'),
  accountEmail: $('accountEmail'),
  form: $('addForm'), url: $('urlInput'), paste: $('pasteBtn'), desc: $('descInput'),
  save: $('saveBtn'), status: $('status'), preview: $('preview'), previewImg: $('previewImg'),
  previewPh: $('previewPh'), previewSource: $('previewSource'), previewTitle: $('previewTitle'),
  search: $('search'), count: $('count'), list: $('list'), empty: $('empty'),
  editDialog: $('editDialog'), editForm: $('editForm'), editTitle: $('editTitle'), editDesc: $('editDesc'),
  accountDialog: $('accountDialog'), settingsDialog: $('settingsDialog'), importFile: $('importFile'),
  newDialog: $('newDialog'), notice: $('notice'),
  viewer: $('viewer'), player: $('player'), viewerSource: $('viewerSource'),
  viewerTitle: $('viewerTitle'), viewerDesc: $('viewerDesc'), viewerOpen: $('viewerOpen'),
  catPicker: $('catPicker'), editCatPicker: $('editCatPicker'), filters: $('filters'),
  catsDialog: $('catsDialog'), catAddForm: $('catAddForm'), catNewName: $('catNewName'),
  catsStatus: $('catsStatus'), catsList: $('catsList'), catsEmpty: $('catsEmpty'),
};

let db = null;           // cliente de Supabase
let user = null;         // usuario con sesión iniciada
let items = [];
let cats = [];           // categorías del usuario: [{ id, name }]
let draft = null;       // preview del link que se está escribiendo
let previewToken = 0;    // descarta respuestas de links anteriores
let previewPending = null;
let editingId = null;
let sharedPending = '';  // link compartido desde otra app antes de iniciar sesión
let activeFilter = null; // null = todas; '' = sin categoría; id = esa categoría
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

function catsCacheKey() {
  return `videoteca.cats.${user.id}`;
}

function readCache() {
  try {
    const parsedCats = JSON.parse(localStorage.getItem(catsCacheKey()) || '[]');
    cats = Array.isArray(parsedCats) ? parsedCats.map(sanitizeCat).filter(Boolean) : [];
    const parsed = JSON.parse(localStorage.getItem(cacheKey()) || '[]');
    return Array.isArray(parsed) ? parsed.map(sanitizeItem).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeCache() {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(items));
    localStorage.setItem(catsCacheKey(), JSON.stringify(cats));
  } catch { /* sin espacio: no es grave */ }
}

function fromRow(row) {
  return sanitizeItem({ ...row, categoryId: row.category_id, createdAt: Date.parse(row.created_at) });
}

function toRow(item) {
  return {
    user_id: user.id,
    url: item.url,
    title: item.title,
    source: item.source,
    thumbnail: item.thumbnail,
    description: item.description,
    category_id: item.categoryId || null,
  };
}

async function loadItems() {
  items = readCache();
  render();
  const [videos, categoryRows] = await Promise.all([
    run(db.from('videos').select(COLUMNS).order('position', { ascending: true }).order('created_at', { ascending: false })),
    run(db.from('categories').select('id,name').order('name')),
  ]);
  if (videos.error || categoryRows.error) {
    notify('Sin conexión con tu cuenta: se muestra la última copia de este teléfono.', true);
    return;
  }
  cats = categoryRows.data.map(sanitizeCat).filter(Boolean);
  sortCats();
  items = videos.data.map(fromRow).filter(Boolean);
  writeCache();
  render();
}

// Sube los videos que no estén ya en la cuenta. Devuelve cuántos subió.
// Las copias exportadas guardan el nombre de la categoría: se busca o se crea.
async function uploadItems(list) {
  const known = new Set(items.map((item) => videoKey(item.url)));
  const rows = [];
  for (const item of list) {
    if (!item || known.has(videoKey(item.url))) continue;
    known.add(videoKey(item.url));
    let categoryId = catById(item.categoryId) ? item.categoryId : '';
    if (!categoryId && item.categoryName) {
      const cat = await createCategory(item.categoryName);
      categoryId = cat ? cat.id : '';
    }
    rows.push({ ...toRow({ ...item, categoryId }), created_at: new Date(item.createdAt).toISOString() });
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
    categoryId: typeof raw.categoryId === 'string' && UUID.test(raw.categoryId) ? raw.categoryId : '',
    // Solo para importar copias: el nombre de la categoría tal como se exportó.
    categoryName: cleanCategory(raw.categoryName || raw.category),
    createdAt: Number(raw.createdAt) || Date.now(),
    position: raw.position !== null && raw.position !== undefined && Number.isFinite(Number(raw.position)) ? Number(raw.position) : null,
  };
}

function sanitizeCat(raw) {
  if (!raw || typeof raw.id !== 'string' || !UUID.test(raw.id)) return null;
  const name = cleanCategory(raw.name);
  return name ? { id: raw.id, name } : null;
}

/* ---------- Categorías ---------- */

function cleanCategory(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function sortCats() {
  cats.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

function catById(id) {
  return id ? cats.find((cat) => cat.id === id) : undefined;
}

function catName(id) {
  const cat = catById(id);
  return cat ? cat.name : '';
}

function catByName(name) {
  const key = cleanCategory(name).toLocaleLowerCase('es');
  return cats.find((cat) => cat.name.toLocaleLowerCase('es') === key);
}

function countIn(id) {
  return items.filter((item) => item.categoryId === id).length;
}

// Crea una categoría (o devuelve la que ya tenga ese nombre). null si falla.
async function createCategory(rawName) {
  const name = cleanCategory(rawName);
  if (!name) return null;
  const existing = catByName(name);
  if (existing) return existing;
  const { data, error } = await run(db.from('categories').insert({ user_id: user.id, name }).select('id,name').single());
  if (error) {
    if (error.code === '23505') { // creada desde otro teléfono: se recarga la lista
      const { data: rows } = await run(db.from('categories').select('id,name').order('name'));
      if (rows) { cats = rows.map(sanitizeCat).filter(Boolean); sortCats(); writeCache(); }
      return catByName(name) || null;
    }
    return null;
  }
  const cat = sanitizeCat(data);
  if (!cat) return null;
  cats.push(cat);
  sortCats();
  writeCache();
  return cat;
}

async function renameCategory(id, rawName) {
  const cat = catById(id);
  const name = cleanCategory(rawName);
  if (!cat || !name || name === cat.name) return { ok: true };
  const other = catByName(name);
  if (other && other.id !== id) return { ok: false, message: `Ya tienes una categoría «${other.name}».` };
  const { error } = await run(db.from('categories').update({ name }).eq('id', id));
  if (error) return { ok: false, message: error.code === '23505' ? 'Ya tienes una categoría con ese nombre.' : 'No se pudo cambiar el nombre. Revisa tu conexión.' };
  cat.name = name;
  sortCats();
  writeCache();
  return { ok: true };
}

// Solo se puede borrar una categoría sin videos (la base también lo impide).
async function deleteCategory(id) {
  const cat = catById(id);
  if (!cat) return;
  const count = countIn(id);
  if (count) {
    return showMessage({
      title: `«${cat.name}» está en uso`,
      text: `La ${count === 1 ? 'usa 1 video' : `usan ${count} videos`}. Cámbiale${count === 1 ? '' : 's'} la categoría con el lápiz y luego podrás borrarla.`,
    });
  }
  const ok = await askConfirm({
    title: `¿Borrar «${cat.name}»?`,
    text: 'No tiene videos.',
    confirmText: 'Sí, borrar',
    danger: true,
  });
  if (!ok) return;
  const { error } = await run(db.from('categories').delete().eq('id', id));
  if (error) {
    // 23503: otro teléfono le puso un video mientras tanto.
    if (error.code === '23503') { await loadItems(); return setCatsStatus(`«${cat.name}» tiene videos: no se puede borrar.`, true); }
    return setCatsStatus('No se pudo borrar. Revisa tu conexión.', true);
  }
  cats = cats.filter((entry) => entry.id !== id);
  writeCache();
  setCatsStatus(`Se borró «${cat.name}».`);
  refreshCategoryUi();
}

function chip(label, pressed, onClick, className = 'chip') {
  const button = el('button', className, label);
  button.type = 'button';
  if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

/* Selector de categoría (al guardar y al editar): una sola o ninguna. */

function pickerValue(container) {
  const id = container.dataset.value || '';
  return catById(id) ? id : '';
}

function setPicker(container, id) {
  container.dataset.value = id || '';
  container.dataset.adding = '';
  renderPicker(container);
}

function renderPicker(container) {
  const selected = pickerValue(container);
  const nodes = [chip('Sin categoría', selected === '', () => setPicker(container, ''), 'chip soft')];
  for (const cat of cats) nodes.push(chip(cat.name, selected === cat.id, () => setPicker(container, cat.id)));

  if (container.dataset.adding === '1') {
    const row = el('div', 'newcat');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = 'Nombre de la categoría';
    input.setAttribute('aria-label', 'Nombre de la nueva categoría');
    const add = el('button', 'primary', 'Crear');
    add.type = 'button';
    const cancel = el('button', 'ghost', 'Cancelar');
    cancel.type = 'button';
    const create = async () => {
      if (!cleanCategory(input.value)) return input.focus();
      add.disabled = true;
      const cat = await createCategory(input.value);
      add.disabled = false;
      if (!cat) { input.classList.add('invalid'); input.title = 'No se pudo crear. Revisa tu conexión.'; return; }
      setPicker(container, cat.id);
      refreshCategoryUi();
    };
    // Enter crea la categoría (y no envía el formulario del video).
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); create(); } });
    input.addEventListener('input', () => { input.classList.remove('invalid'); input.title = ''; });
    add.addEventListener('click', create);
    cancel.addEventListener('click', () => { container.dataset.adding = ''; renderPicker(container); });
    row.append(input, add, cancel);
    nodes.push(row);
    container.replaceChildren(...nodes);
    input.focus();
    return;
  }

  nodes.push(chip('+ Nueva', null, () => { container.dataset.adding = '1'; renderPicker(container); }, 'chip add'));
  container.replaceChildren(...nodes);
}

/* Filtros de la lista */

function setFilter(value) {
  activeFilter = value;
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(value)); } catch { /* no es grave */ }
  render();
}

// El filtro guardado solo se aplica si la categoría existe.
function currentFilter() {
  if (activeFilter === null) return null;
  if (activeFilter === '') return cats.length ? '' : null;
  return catById(activeFilter) ? activeFilter : null;
}

function renderFilters() {
  const filter = currentFilter();
  const uncategorized = items.filter((item) => !catById(item.categoryId)).length;
  const nodes = [chip(`Todas · ${items.length}`, filter === null, () => setFilter(null))];
  for (const cat of cats) nodes.push(chip(`${cat.name} · ${countIn(cat.id)}`, filter === cat.id, () => setFilter(cat.id)));
  if (cats.length && uncategorized) nodes.push(chip(`Sin categoría · ${uncategorized}`, filter === '', () => setFilter('')));
  ui.filters.replaceChildren(...nodes);
  updateFilterFade();
  const pressed = ui.filters.querySelector('[aria-pressed="true"]');
  if (pressed && filter !== null) pressed.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Difumina los bordes de la fila de filtros solo donde hay más para deslizar.
function updateFilterFade() {
  const row = ui.filters;
  row.classList.toggle('more-left', row.scrollLeft > 2);
  row.classList.toggle('more-right', row.scrollLeft + row.clientWidth < row.scrollWidth - 2);
}
ui.filters.addEventListener('scroll', updateFilterFade, { passive: true });
window.addEventListener('resize', updateFilterFade);
$('catsBtn').addEventListener('click', () => openCategories());

/* Ventana "Tus categorías" */

function setCatsStatus(message, isError = false) {
  ui.catsStatus.textContent = message;
  ui.catsStatus.classList.toggle('error', isError);
}

function renderCatsList() {
  ui.catsEmpty.hidden = cats.length > 0;
  ui.catsList.replaceChildren(...cats.map((cat) => {
    const row = el('li', 'catrow');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 40;
    input.value = cat.name;
    input.setAttribute('aria-label', `Nombre de la categoría ${cat.name}`);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
    input.addEventListener('change', async () => {
      const result = await renameCategory(cat.id, input.value);
      if (!result.ok) { input.value = cat.name; return setCatsStatus(result.message, true); }
      input.value = cat.name;
      setCatsStatus('Nombre guardado.');
      refreshCategoryUi();
    });
    const count = countIn(cat.id);
    const meta = el('span', 'catcount', count === 1 ? '1 video' : `${count} videos`);
    const remove = el('button', count ? 'danger locked' : 'danger');
    remove.type = 'button';
    remove.append(icon('trash'));
    remove.setAttribute('aria-label', count ? `${cat.name} está en uso y no se puede borrar` : `Borrar la categoría ${cat.name}`);
    remove.title = count ? 'En uso: no se puede borrar' : 'Borrar';
    remove.addEventListener('click', () => deleteCategory(cat.id));
    row.append(input, meta, remove);
    return row;
  }));
}

function openCategories() {
  setCatsStatus('');
  ui.catAddForm.reset();
  renderCatsList();
  ui.catsDialog.showModal();
}

// Vuelve a dibujar todo lo que muestra categorías después de un cambio.
function refreshCategoryUi() {
  if (ui.catsDialog.open) renderCatsList();
  if (ui.newDialog.open) renderPicker(ui.catPicker);
  if (ui.editDialog.open) renderPicker(ui.editCatPicker);
  render();
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
  setPicker(ui.catPicker, currentFilter() || '');
  ui.newDialog.showModal();
}

function resetComposer() {
  clearTimeout(ui.url.debounce);
  ui.form.reset();
  setPicker(ui.catPicker, '');
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
  ui.viewerSource.textContent = [item.source || embed.label, catName(item.categoryId)].filter(Boolean).join(' · ');
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
  tag: ['M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z', 'M7.5 7.5h.01'],
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
  card.dataset.id = item.id;

  const link = el('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.draggable = false; // el arrastre es el nuestro (mantener presionado), no el del navegador
  // Si el sitio se puede ver dentro de la app, abre el visor; si no, el link normal.
  link.addEventListener('click', (event) => {
    if (sorter.justDropped()) { event.preventDefault(); return; }
    if (openViewer(item)) event.preventDefault();
  });

  const thumb = el('div', 'thumb');
  const img = el('img');
  img.alt = '';
  img.draggable = false;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  const placeholder = el('span', 'ph', '▶');
  thumb.append(img, placeholder);
  setThumb(img, placeholder, item.thumbnail);

  const meta = el('div', 'meta');
  const source = el('p', 'source', item.source);
  const category = catName(item.categoryId);
  if (category) source.append(' · ', el('span', 'cattag', category));
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
  // Mientras se arrastra una tarjeta no se redibuja la lista (se hace al soltarla).
  if (sorter.active()) { sorter.later(render); return; }
  renderFilters();
  const filter = currentFilter();
  const query = ui.search.value.trim().toLowerCase();
  const visible = items.filter((item) =>
    (filter === null || (filter === '' ? !catById(item.categoryId) : item.categoryId === filter))
    && (!query || `${item.title} ${item.description} ${catName(item.categoryId)} ${item.source} ${item.url}`.toLowerCase().includes(query)));

  ui.list.replaceChildren(...visible.map(renderCard));
  const total = items.length === 1 ? '1 video' : `${items.length} videos`;
  ui.count.textContent = visible.length === items.length ? total : `${visible.length} de ${total}`;
  ui.empty.hidden = visible.length > 0;
  ui.empty.textContent = !items.length ? 'Pulsa «+ Nuevo» para guardar tu primer video.'
    : query ? 'Ningún video coincide con la búsqueda.'
    : 'No hay videos en esta categoría.';
  let hintSeen = false;
  try { hintSeen = localStorage.getItem(SORT_HINT_KEY) === 'visto'; } catch { /* se muestra */ }
  $('sortHint').hidden = hintSeen || visible.length < 2;
}

/* ---------- Ordenar: mantener presionada una tarjeta y arrastrarla ---------- */

const SORT_HINT_KEY = 'videotk.sortHint';

const sorter = (() => {
  const HOLD_TOUCH = 400; // ms presionando antes de "levantar" la tarjeta
  const HOLD_MOUSE = 250;
  const SLOP = 8;         // px que se puede mover el dedo sin cancelar (más = es un scroll)
  let pending = null;
  let drag = null;
  let droppedAt = 0;
  let afterDrop = null;

  const justDropped = () => Date.now() - droppedAt < 450;
  const active = () => Boolean(drag);

  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.card.classList.remove('pressing');
    pending = null;
  }

  function press(card, x, y, mouse) {
    cancelPending();
    pending = { card, x, y, mouse };
    card.classList.add('pressing');
    pending.timer = setTimeout(() => {
      const { card: c, x: px, y: py } = pending;
      pending = null;
      begin(c, px, py);
    }, mouse ? HOLD_MOUSE : HOLD_TOUCH);
  }

  // Posición de la tarjeta en la lista, sin el desplazamiento del arrastre.
  function baseRect(card) {
    const saved = card.style.transform;
    card.style.transform = 'none';
    const rect = card.getBoundingClientRect();
    card.style.transform = saved;
    return rect;
  }

  function begin(card, x, y) {
    card.classList.remove('pressing');
    const rect = card.getBoundingClientRect();
    drag = {
      card, x, y,
      grabX: x - rect.left,
      grabY: y - rect.top,
      lastSwap: 0,
      prevId: card.previousElementSibling ? card.previousElementSibling.dataset.id : null,
      nextId: card.nextElementSibling ? card.nextElementSibling.dataset.id : null,
    };
    card.classList.add('dragging');
    document.body.classList.add('sorting');
    if (navigator.vibrate) navigator.vibrate(12);
    place();
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function place() {
    const { card, x, y, grabX, grabY } = drag;
    const base = baseRect(card);
    card.style.transform = `translate(${x - grabX - base.left}px, ${y - grabY - base.top}px) scale(1.03)`;
  }

  // Mueve la tarjeta en la lista y anima a las demás hasta su nuevo sitio.
  function flip(mutate) {
    const others = [...ui.list.children].filter((c) => c !== drag.card);
    const before = new Map(others.map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    for (const c of others) {
      c.style.transition = 'none';
      c.style.transform = '';
      const a = before.get(c);
      const b = c.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) { c.style.transition = ''; continue; }
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      void c.offsetWidth;
      c.style.transition = '';
      c.style.transform = '';
    }
  }

  function reorder() {
    if (Date.now() - drag.lastSwap < 160) return; // espera a que termine la animación anterior
    const under = document.elementFromPoint(drag.x, drag.y);
    const target = under && under.closest('.card');
    if (!target || target === drag.card || target.parentElement !== ui.list) return;
    const cards = [...ui.list.children];
    const from = cards.indexOf(drag.card);
    const to = cards.indexOf(target);
    flip(() => ui.list.insertBefore(drag.card, from < to ? target.nextSibling : target));
    drag.lastSwap = Date.now();
    place();
  }

  function move(x, y) {
    drag.x = x;
    drag.y = y;
    place();
    reorder();
  }

  // Cerca del borde de arriba o de abajo, la pantalla se desliza sola.
  function autoScroll() {
    if (!drag) return;
    const edge = 80;
    let dy = 0;
    if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 5);
    else if (drag.y > innerHeight - edge) dy = Math.ceil((drag.y - (innerHeight - edge)) / 5);
    if (dy) { scrollBy(0, dy); place(); reorder(); }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function finish() {
    const { card, prevId, nextId } = drag;
    cancelAnimationFrame(drag.raf);
    drag = null;
    droppedAt = Date.now();
    document.body.classList.remove('sorting');

    // La tarjeta vuelve suave a su hueco.
    const now = card.getBoundingClientRect();
    card.style.transform = '';
    const slot = card.getBoundingClientRect();
    card.style.transform = `translate(${now.left - slot.left}px, ${now.top - slot.top}px)`;
    void card.offsetWidth;
    card.classList.remove('dragging');
    card.style.transform = '';

    const prev = card.previousElementSibling;
    const next = card.nextElementSibling;
    const moved = (prev ? prev.dataset.id : null) !== prevId || (next ? next.dataset.id : null) !== nextId;
    if (moved) saveOrder(card.dataset.id, prev && prev.dataset.id, next && next.dataset.id);
    if (afterDrop) { const fn = afterDrop; afterDrop = null; fn(); }
  }

  // Ratón: también empieza a arrastrar si se mueve con el botón apretado.
  ui.list.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const card = event.target.closest('.card');
    if (!card || event.target.closest('button')) return;
    press(card, event.clientX, event.clientY, true);
  });
  window.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    if (drag) return move(event.clientX, event.clientY);
    if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > SLOP) {
      const { card, x, y } = pending;
      cancelPending();
      begin(card, x, y);
      move(event.clientX, event.clientY);
    }
  });
  window.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') return;
    if (drag) finish(); else cancelPending();
  });

  // Dedo: hay que mantener presionado; si se mueve antes, es un scroll normal.
  ui.list.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) { cancelPending(); return; }
    const card = event.target.closest('.card');
    if (!card || event.target.closest('button')) return;
    const t = event.touches[0];
    press(card, t.clientX, t.clientY, false);
  }, { passive: true });
  ui.list.addEventListener('touchmove', (event) => {
    const t = event.touches[0];
    if (drag) { event.preventDefault(); move(t.clientX, t.clientY); return; }
    if (pending && Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > SLOP) cancelPending();
  }, { passive: false });
  const touchEnd = (event) => {
    if (drag) { event.preventDefault(); finish(); } else cancelPending();
  };
  ui.list.addEventListener('touchend', touchEnd, { passive: false });
  ui.list.addEventListener('touchcancel', touchEnd, { passive: false });
  // Sin el menú de "mantener presionado" del teléfono sobre las tarjetas.
  ui.list.addEventListener('contextmenu', (event) => { if (event.target.closest('.card')) event.preventDefault(); });
  window.addEventListener('scroll', () => { if (!drag) cancelPending(); }, { passive: true });

  return { justDropped, active, later: (fn) => { afterDrop = fn; } };
})();

// Guarda la nueva posición: queda entre sus vecinas, así solo cambia este video.
async function saveOrder(id, prevId, nextId) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  const prev = prevId ? items.find((entry) => entry.id === prevId) : null;
  const next = nextId ? items.find((entry) => entry.id === nextId) : null;
  const relocate = () => {
    const rest = items.filter((entry) => entry !== item);
    const index = prev ? rest.indexOf(prev) + 1 : rest.indexOf(next);
    rest.splice(Math.max(0, index), 0, item);
    return rest;
  };
  const known = (entry) => !entry || Number.isFinite(entry.position);

  try { localStorage.setItem(SORT_HINT_KEY, 'visto'); } catch { /* no es grave */ }
  $('sortHint').hidden = true;

  let position = null;
  if (known(prev) && known(next) && Number.isFinite(item.position)) {
    if (prev && next) position = (prev.position + next.position) / 2;
    else if (prev) position = prev.position + 1;
    else if (next) position = next.position - 1;
    // Sin espacio entre las vecinas (tras muchísimos movimientos): se renumera todo.
    if (position !== null && ((prev && position <= prev.position) || (next && position >= next.position))) position = null;
  }

  const before = items.map((entry) => [entry, entry.position]);
  items = relocate();
  let updates;
  if (position !== null) {
    item.position = position;
    updates = [[item.id, position]];
  } else {
    items.forEach((entry, index) => { entry.position = (index + 1) * 1024; });
    updates = items.map((entry) => [entry.id, entry.position]);
  }
  writeCache();

  const results = await Promise.all(updates.map(([videoId, pos]) =>
    run(db.from('videos').update({ position: pos }).eq('id', videoId))));
  if (results.some((result) => result.error)) {
    before.forEach(([entry, pos]) => { entry.position = pos; });
    items.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || b.createdAt - a.createdAt);
    writeCache();
    render();
    notify('No se pudo guardar el nuevo orden. Revisa tu conexión.', true);
  }
}

// Las ventanas abiertas con showModal() quedan por encima de todo lo demás de la página,
// así que la alerta se mete dentro de la ventana abierta para que se vea encima.
function alertTarget() {
  const open = [...document.querySelectorAll('dialog[open]')];
  return open.length ? open[open.length - 1] : 'body';
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
    target: alertTarget(),
    buttonsStyling: false,
    customClass: {
      popup: 'swal-vt',
      confirmButton: danger ? 'danger-solid' : 'primary',
      cancelButton: 'ghost',
    },
  });
  return result.isConfirmed;
}

// Aviso con un solo botón.
async function showMessage({ title, text }) {
  if (!window.Swal) { alert(`${title}\n\n${text}`); return; }
  await window.Swal.fire({
    title,
    text,
    icon: 'info',
    confirmButtonText: 'Entendido',
    target: alertTarget(),
    buttonsStyling: false,
    customClass: { popup: 'swal-vt', confirmButton: 'primary' },
  });
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
  setPicker(ui.editCatPicker, item.categoryId);
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
  const item = sanitizeItem({ ...meta, url, description: ui.desc.value.trim(), categoryId: pickerValue(ui.catPicker) });
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
  if (filter !== null && filter !== saved.categoryId) setFilter(saved.categoryId || null);
  notify(meta.title ? 'Video guardado.' : 'Guardado sin preview: este sitio no la ofrece.');
  render();
});

$('newBtn').addEventListener('click', openComposer);
$('cancelNew').addEventListener('click', () => { resetComposer(); ui.newDialog.close(); });
ui.newDialog.addEventListener('close', resetComposer);

ui.search.addEventListener('input', render);

ui.catAddForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = cleanCategory(ui.catNewName.value);
  if (!name) return;
  if (catByName(name)) return setCatsStatus(`Ya tienes «${catByName(name).name}».`, true);
  const cat = await createCategory(name);
  if (!cat) return setCatsStatus('No se pudo crear. Revisa tu conexión.', true);
  ui.catAddForm.reset();
  setCatsStatus(`Creada «${cat.name}».`);
  refreshCategoryUi();
  ui.catNewName.focus();
});
$('closeCats').addEventListener('click', () => ui.catsDialog.close());

ui.editForm.addEventListener('submit', async (event) => {
  if (!event.submitter || event.submitter.value !== 'ok') return;
  const item = items.find((entry) => entry.id === editingId);
  if (!item) return;
  const description = ui.editDesc.value.trim();
  const categoryId = pickerValue(ui.editCatPicker);
  const { error } = await run(db.from('videos').update({ description, category_id: categoryId || null }).eq('id', item.id));
  if (error) return notify('No se pudo guardar el cambio. Revisa tu conexión.', true);
  item.description = description;
  const filter = currentFilter();
  const moved = filter !== null && filter !== categoryId;
  item.categoryId = categoryId;
  if (moved) notify(categoryId ? `Movido a «${catName(categoryId)}».` : 'Movido a «Sin categoría».');
  writeCache();
  render();
});

$('menuBtn').addEventListener('click', () => { setPhotoStatus(''); renderAvatar(); ui.accountDialog.showModal(); });
$('closeAccount').addEventListener('click', () => ui.accountDialog.close());
$('settingsBtn').addEventListener('click', () => { renderTheme(); ui.settingsDialog.showModal(); });
$('closeSettings').addEventListener('click', () => ui.settingsDialog.close());
$('importBtn').addEventListener('click', () => ui.importFile.click());

/* ---------- Tema: sistema, claro u oscuro ---------- */

const THEME_KEY = 'videotk.theme';
const themeButtons = [...document.querySelectorAll('[data-theme-choice]')];

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(choice) {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  // Color de la barra del sistema (Android) acorde al fondo.
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#14151a' : '#f4f4f1';
}

function renderTheme() {
  const choice = savedTheme();
  themeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice)));
}

themeButtons.forEach((button) => button.addEventListener('click', () => {
  const choice = button.dataset.themeChoice;
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch { /* se aplica igual, aunque no se recuerde */ }
  applyTheme(choice);
  renderTheme();
}));

applyTheme(savedTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(savedTheme()));

$('exportBtn').addEventListener('click', () => {
  const copy = items.map(({ categoryName, ...item }) => ({ ...item, categoryName: catName(item.categoryId) }));
  const blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
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
  ui.settingsDialog.close();
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
  // Se cierra la ventana "Tu cuenta" antes de preguntar, para que la alerta nunca quede detrás.
  if (ui.accountDialog.open) ui.accountDialog.close();
  const ok = await askConfirm({
    title: '¿Cerrar sesión?',
    text: 'Tus videos siguen guardados en tu cuenta.',
    confirmText: 'Sí, salir',
  });
  if (!ok) return;
  try { localStorage.removeItem(cacheKey()); localStorage.removeItem(catsCacheKey()); } catch { /* nada que borrar */ }
  await run(db.auth.signOut({ scope: 'local' }));
  await applySession(null);
}

$('logoutBtn').addEventListener('click', logout);

/* ---------- Login ---------- */

function setAuthStatus(message, isError = false) {
  ui.authStatus.textContent = message;
  ui.authStatus.classList.toggle('error', isError);
  if (isError) { // pequeña sacudida de la tarjeta
    ui.authForm.classList.remove('shake');
    void ui.authForm.offsetWidth;
    ui.authForm.classList.add('shake');
  }
}
ui.authForm.addEventListener('animationend', () => ui.authForm.classList.remove('shake'));

// La etiqueta del campo sube cuando tiene texto. El autocompletado de iOS a veces
// rellena el campo sin avisar, así que además se revisa durante unos segundos.
const authInputs = [ui.authEmail, ui.authPassword, $('authConfirm'), $('authCode')];
function syncFilled() {
  authInputs.forEach((input) => input.parentElement.classList.toggle('filled', input.value !== ''));
}
authInputs.forEach((input) => {
  ['input', 'change', 'focus', 'blur', 'keyup'].forEach((type) => input.addEventListener(type, syncFilled));
  input.addEventListener('animationstart', (event) => {
    if (event.animationName === 'autofillIn') input.parentElement.classList.add('filled');
  });
});
function watchAutofill() {
  let checks = 0;
  clearInterval(watchAutofill.timer);
  watchAutofill.timer = setInterval(() => {
    syncFilled();
    if (++checks >= 20 || ui.authView.hidden) clearInterval(watchAutofill.timer);
  }, 250);
}

function setAuthBusy(busy) {
  ui.authBtn.disabled = busy;
  ui.authBtn.classList.toggle('loading', busy);
}

$('authEye').addEventListener('click', (event) => {
  const eye = event.currentTarget;
  const show = eye.getAttribute('aria-pressed') !== 'true';
  eye.setAttribute('aria-pressed', String(show));
  eye.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  ui.authPassword.type = show ? 'text' : 'password';
  $('authConfirm').type = show ? 'text' : 'password';
});

function showView(loggedIn) {
  ui.authView.hidden = loggedIn;
  ui.appView.hidden = !loggedIn;
  if (!loggedIn) watchAutofill();
}

// Llegó desde el enlace de "¿Olvidaste tu contraseña?": Supabase ya abrió sesión, pero no se entra
// a la app hasta elegir la contraseña nueva (aunque esa pestaña ya tuviera la sesión iniciada).
// Se guarda en sessionStorage para que recargar la página no se salte este paso.
let recovering = false;
function setRecovering(on) {
  recovering = on;
  try {
    if (on) sessionStorage.setItem('videotk.recovering', '1');
    else sessionStorage.removeItem('videotk.recovering');
  } catch { /* sin almacenamiento: solo dura mientras la página esté abierta */ }
}

async function applySession(session) {
  const next = session ? session.user : null;
  if (next && recovering) {
    user = next;
    [ui.newDialog, ui.viewer, ui.editDialog, ui.accountDialog, ui.settingsDialog, ui.catsDialog, $('passwordDialog')].forEach((dialog) => { if (dialog.open) dialog.close(); });
    showView(false);
    if (authMode !== 'reset') setAuthMode('reset');
    return;
  }
  if ((next && next.id) === (user && user.id)) {
    // Mismo usuario con datos nuevos (p. ej. cambió su foto en otro teléfono).
    if (next) { user = next; renderAvatar(); }
    return;
  }
  user = next;
  [ui.newDialog, ui.viewer, ui.editDialog, ui.accountDialog, ui.settingsDialog, ui.catsDialog, $('passwordDialog')].forEach((dialog) => { if (dialog.open) dialog.close(); });

  if (!user) {
    items = [];
    cats = [];
    render();
    showView(false);
    return;
  }
  await enterApp();
}

async function enterApp() {
  ui.accountEmail.textContent = user.email || '';
  renderAvatar();
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

// Pantallas del login:
//   login  → correo + contraseña        signup → crear cuenta
//   forgot → pedir enlace para cambiar la contraseña
//   otp    → pedir un código por correo  code   → escribir ese código
let authMode = 'login';
let signingUp = false;
let otpEmail = '';
let resendLeft = 0;
const authConfirmRow = $('authConfirmRow');
const authConfirm = $('authConfirm');
const authCode = $('authCode');
const authSwitch = $('authSwitch');
const authSwitchText = $('authSwitchText');
const RESEND_SECONDS = 60; // Supabase tampoco deja enviar dos correos al mismo usuario en menos de 60 s
const OTP_LENGTH = 6;      // = "Email OTP length" en Supabase (Authentication → Sign In / Providers → Email)
let verifyingOtp = false;

// Dibuja un cuadro por dígito; el cuadro activo (el siguiente por escribir) se resalta.
function renderOtp() {
  const boxes = $('otpBoxes');
  if (boxes.children.length !== OTP_LENGTH) {
    boxes.replaceChildren(...Array.from({ length: OTP_LENGTH }, () => el('span', 'otpbox')));
    boxes.style.setProperty('--otp-len', OTP_LENGTH);
    authCode.maxLength = OTP_LENGTH;
  }
  const value = authCode.value;
  const focused = document.activeElement === authCode;
  [...boxes.children].forEach((box, i) => {
    box.textContent = value[i] || '';
    box.classList.toggle('filled', i < value.length);
    box.classList.toggle('active', focused && i === Math.min(value.length, OTP_LENGTH - 1));
  });
}

// Fondo del login: columnas de "videos" que se desplazan sin fin (sin descargas, todo CSS).
(function buildAuthWall() {
  const wall = document.getElementById('authWall');
  if (!wall) return;
  const hues = [[12, 340], [330, 265], [265, 215], [200, 165], [28, 355], [290, 330], [180, 250], [45, 15]];
  const durs = ['0:42', '1:15', '3:08', '0:27', '12:40', '2:19', '0:58', '7:31', '4:05', '0:33'];
  let n = 0;
  for (let c = 0; c < 10; c += 1) {
    const col = el('div', 'wallcol');
    col.style.setProperty('--dur', `${48 + (c % 3) * 14}s`);
    if (c % 2) col.classList.add('down');
    const tiles = [];
    for (let t = 0; t < 14; t += 1) {
      n += 1;
      const [h1, h2] = hues[(n * 5 + c) % hues.length];
      // Clases (no :nth-child) para que la copia del bucle sea idéntica y no se note el reinicio.
      const tile = el('div', `walltile${(n + c) % 4 === 0 ? ' tall' : ''}${t % 3 === 0 ? ' moving' : ''}`);
      tile.style.setProperty('--h1', h1);
      tile.style.setProperty('--h2', h2);
      tile.style.setProperty('--w', (0.15 + ((n * 37) % 70) / 100).toFixed(2));
      tile.append(el('span', 'wallplay'), el('span', 'walltime', durs[n % durs.length]), el('span', 'wallbar'));
      tiles.push(tile);
    }
    // Dos copias seguidas para que el bucle no tenga saltos.
    col.append(...tiles, ...tiles.map((t) => t.cloneNode(true)));
    wall.append(col);
  }
  const pause = () => document.documentElement.classList.toggle('bg-paused', document.hidden);
  document.addEventListener('visibilitychange', pause);
  pause();
}());

const AUTH_SCREENS = {
  login: { title: 'Bienvenido de nuevo', button: 'Entrar' },
  signup: { title: 'Crea tu cuenta', button: 'Crear cuenta' },
  forgot: {
    title: 'Recupera tu contraseña',
    button: 'Enviar enlace',
    hint: 'Escribe tu correo y te enviaremos un enlace para crear una contraseña nueva.',
  },
  otp: {
    title: 'Entrar con un código',
    button: 'Enviarme un código',
    hint: 'Te enviaremos un código a tu correo para entrar sin contraseña.',
  },
  code: { title: 'Revisa tu correo', button: 'Entrar' },
  reset: { title: 'Crea tu contraseña nueva', button: 'Guardar contraseña' },
};

function setAuthMode(mode) {
  if (mode === true) mode = 'signup';   // compatibilidad: setAuthMode(true/false)
  if (mode === false) mode = 'login';
  authMode = mode;
  signingUp = mode === 'signup';
  const screen = AUTH_SCREENS[mode];
  const withPassword = mode === 'login' || mode === 'signup';
  const isReset = mode === 'reset';
  const showConfirm = signingUp || isReset;

  $('authTitle').textContent = screen.title;
  const hint = mode === 'code'
    ? `Escribe o pega el código de ${OTP_LENGTH} dígitos que enviamos a ${otpEmail}. Si no lo ves, revisa spam.`
    : isReset
      ? `Elige una contraseña nueva para ${(user && user.email) || 'tu cuenta'} (mínimo 6 caracteres).`
      : screen.hint || '';
  $('authHint').textContent = hint;
  $('authHint').hidden = !hint;
  ui.authBtn.querySelector('.label').textContent = screen.button;

  $('authEmailField').hidden = mode === 'code' || isReset;
  $('authPasswordField').hidden = !withPassword && !isReset;
  document.querySelector('label[for="authPassword"]').textContent = isReset ? 'Contraseña nueva' : 'Contraseña';
  if (isReset) ui.authPassword.value = '';
  authConfirmRow.classList.toggle('open', showConfirm);
  authConfirmRow.inert = !showConfirm;
  authConfirm.required = showConfirm;
  authConfirm.value = '';
  $('authCodeField').hidden = mode !== 'code';
  if (mode !== 'code') authCode.value = '';
  renderOtp();

  $('authLoginExtras').hidden = mode !== 'login';
  $('authCodeExtras').hidden = mode !== 'code';
  $('authSwitchRow').hidden = !withPassword;
  $('authBackRow').hidden = withPassword;
  authSwitchText.textContent = signingUp ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?';
  authSwitch.textContent = signingUp ? 'Entrar' : 'Crear cuenta';
  $('authBack').textContent = isReset ? '← Volver al inicio de sesión' : '← Volver a entrar con contraseña';
  ui.authPassword.autocomplete = showConfirm ? 'new-password' : 'current-password';

  syncFilled();
  setAuthStatus('');
  if (mode === 'code') authCode.focus();
  else if (isReset) ui.authPassword.focus();
  else if (!withPassword && !ui.authEmail.value) ui.authEmail.focus();
}

authSwitch.addEventListener('click', () => setAuthMode(signingUp ? 'login' : 'signup'));
$('authForgot').addEventListener('click', () => setAuthMode('forgot'));
$('authOtpBtn').addEventListener('click', () => setAuthMode('otp'));
$('authOtherEmail').addEventListener('click', () => setAuthMode('otp'));
$('authBack').addEventListener('click', async () => {
  if (authMode !== 'reset') return setAuthMode('login');
  // Sin contraseña nueva no se entra: se cierra la sesión que abrió el enlace.
  setRecovering(false);
  setAuthMode('login');
  if (db) await run(db.auth.signOut());
});

async function saveNewPassword() {
  const password = ui.authPassword.value;
  if (password.length < 6) return setAuthStatus('Debe tener al menos 6 caracteres.', true);
  if (password !== authConfirm.value) return setAuthStatus('Las contraseñas no coinciden.', true);
  setAuthBusy(true);
  setAuthStatus('Guardando…');
  const { error } = await run(db.auth.updateUser({ password }));
  setAuthBusy(false);
  if (error) {
    return setAuthStatus(error.code === 'same_password'
      ? 'Esa ya es tu contraseña actual. Elige otra.'
      : error.code === 'weak_password' ? 'Es muy débil. Usa al menos 6 caracteres.'
      : isNetworkError(error) ? 'No se pudo guardar. Revisa tu conexión.'
      : 'El enlace ya no es válido. Pide uno nuevo desde "¿Olvidaste tu contraseña?".', true);
  }
  setRecovering(false);
  ui.authPassword.value = '';
  setAuthMode('login');
  await enterApp();
  notify('Contraseña cambiada. Úsala la próxima vez que entres.');
}
// Solo dígitos; al completar los cuadros (escribiendo, pegando o con el autocompletado) se comprueba solo.
authCode.addEventListener('input', () => {
  authCode.value = authCode.value.replace(/\D/g, '').slice(0, OTP_LENGTH);
  renderOtp();
  if (authCode.value.length === OTP_LENGTH && !verifyingOtp) verifyOtpCode();
});
['focus', 'blur', 'keyup', 'click'].forEach((type) => authCode.addEventListener(type, renderOtp));
// Que el cursor quede siempre al final (se escribe en orden, cuadro a cuadro).
authCode.addEventListener('select', () => { const end = authCode.value.length; authCode.setSelectionRange(end, end); });

function startResendCooldown() {
  resendLeft = RESEND_SECONDS;
  const button = $('authResend');
  const tick = () => {
    button.disabled = resendLeft > 0;
    button.textContent = resendLeft > 0 ? `Reenviar código (${resendLeft} s)` : 'Reenviar código';
    if (resendLeft-- > 0) startResendCooldown.timer = setTimeout(tick, 1000);
  };
  clearTimeout(startResendCooldown.timer);
  tick();
}

const isRateLimited = (error) => error && (error.status === 429 || /rate_limit/.test(error.code || ''));
// 5xx: falló el servicio de correo (p. ej. el SMTP rechazó el envío). Se avisa en vez de decir "enviado".
const isServerError = (error) => error && error.status >= 500;
// Un fallo de red llega como excepción (TypeError) o sin código HTTP.
const isNetworkError = (error) => error && (error instanceof TypeError || (!error.status && !error.code));

// Por seguridad, el mensaje es el mismo exista o no la cuenta (así nadie puede averiguar qué correos están registrados).
async function sendResetLink(email) {
  setAuthBusy(true);
  const { error } = await run(db.auth.resetPasswordForEmail(email, { redirectTo: APP_URL }));
  setAuthBusy(false);
  if (isRateLimited(error)) return setAuthStatus('Ya se envió un correo hace poco. Espera un minuto y vuelve a probar.', true);
  if (isNetworkError(error)) return setAuthStatus('No se pudo enviar. Revisa tu conexión.', true);
  if (isServerError(error)) return setAuthStatus('No pudimos enviar el correo en este momento. Inténtalo más tarde.', true);
  setAuthStatus(`Si existe una cuenta con ${email}, te enviamos un enlace para restablecer la contraseña. Revisa también la carpeta de spam.`);
}

// Pide el código. No crea cuentas nuevas (para eso está "Crear cuenta").
// Si el correo no tiene cuenta, la pantalla sigue igual que si la tuviera, por la misma razón de seguridad.
async function sendOtpCode(email, isResend) {
  setAuthBusy(true);
  const { error } = await run(db.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }));
  setAuthBusy(false);
  if (isRateLimited(error)) return setAuthStatus('Ya se envió un código hace poco. Espera un minuto y vuelve a probar.', true);
  if (isNetworkError(error)) return setAuthStatus('No se pudo enviar el código. Revisa tu conexión.', true);
  if (isServerError(error)) return setAuthStatus('No pudimos enviar el correo en este momento. Inténtalo más tarde.', true);
  otpEmail = email;
  if (!isResend) setAuthMode('code');
  startResendCooldown();
  if (isResend) setAuthStatus('Te enviamos un código nuevo.');
}

async function verifyOtpCode() {
  const token = authCode.value.replace(/\D/g, '');
  if (token.length < OTP_LENGTH) return setAuthStatus(`Escribe los ${OTP_LENGTH} dígitos del código que llegó a tu correo.`, true);
  verifyingOtp = true;
  setAuthBusy(true);
  setAuthStatus('Comprobando el código…');
  const { data, error } = await run(db.auth.verifyOtp({ email: otpEmail, token, type: 'email' }));
  setAuthBusy(false);
  verifyingOtp = false;
  if (error) {
    // Se vacían los cuadros para escribir o pegar el código otra vez.
    authCode.value = '';
    renderOtp();
    authCode.focus();
    return setAuthStatus(isNetworkError(error)
      ? 'No se pudo comprobar el código. Revisa tu conexión.'
      : 'El código no es correcto o ya caducó. Revísalo o pide uno nuevo.', true);
  }
  setAuthMode('login');
  await applySession(data.session);
}

$('authResend').addEventListener('click', () => { if (resendLeft <= 0 && otpEmail) sendOtpCode(otpEmail, true); });

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
  if (authMode === 'code') return verifyOtpCode();
  if (authMode === 'reset') return saveNewPassword();
  const email = ui.authEmail.value.trim();
  const password = ui.authPassword.value;
  // El formulario no usa los globos del navegador (novalidate): los mensajes salen aquí.
  if (!email || !ui.authEmail.checkValidity()) return setAuthStatus('Escribe un correo válido.', true);
  if (authMode === 'forgot') return sendResetLink(email);
  if (authMode === 'otp') return sendOtpCode(email, false);
  if (password.length < 6) return setAuthStatus('La contraseña debe tener al menos 6 caracteres.', true);
  if (signingUp && password !== authConfirm.value) {
    setAuthStatus('Las contraseñas no coinciden.', true);
    return;
  }

  setAuthBusy(true);
  setAuthStatus('');
  const { data, error } = await run(signingUp
    ? db.auth.signUp({ email, password, options: { emailRedirectTo: APP_URL } })
    : db.auth.signInWithPassword({ email, password }));
  setAuthBusy(false);
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
    syncFilled();
    setAuthStatus(exists
      ? 'Ese correo ya tiene cuenta. Entra con tu contraseña.'
      : 'Te enviamos un correo para confirmar la cuenta. Ábrelo y luego entra aquí.', exists);
    return;
  }

  ui.authPassword.value = '';
  setAuthMode(false);
  syncFilled();
  await applySession(data.session);
});

/* ---------- Foto de perfil ---------- */

const AVATAR_SIZE = 256; // px: se recorta a un cuadrado y se guarda pequeña (unos 20-40 KB)

function avatarUrl() {
  const url = user && user.user_metadata && user.user_metadata.avatar_url;
  return safeHttpUrl(url);
}

// Dibuja la foto, o la inicial del correo sobre un degradado si no hay foto.
function paintAvatar(node) {
  const url = avatarUrl();
  node.replaceChildren();
  node.classList.toggle('hasphoto', Boolean(url));
  if (url) {
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { node.classList.remove('hasphoto'); node.replaceChildren(initialOf()); };
    img.src = url;
    node.append(img);
  } else {
    node.append(initialOf());
  }
}

function initialOf() {
  const letter = ((user && user.email) || '?').trim().charAt(0).toUpperCase();
  return el('span', 'initial', letter || '?');
}

function renderAvatar() {
  paintAvatar($('avatarTop'));
  paintAvatar($('avatarBig'));
  $('removePhotoBtn').hidden = !avatarUrl();
}

function setPhotoStatus(message, isError = false) {
  $('photoStatus').textContent = message;
  $('photoStatus').classList.toggle('error', isError);
}

// Lee la imagen elegida y la recorta al centro en un cuadrado de AVATAR_SIZE.
async function squareImage(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width;
  const h = source.height;
  const side = Math.min(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  if (source.close) source.close();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('imagen'))), 'image/jpeg', 0.85));
}

$('changePhotoBtn').addEventListener('click', () => $('photoFile').click());

$('photoFile').addEventListener('change', async () => {
  const [file] = $('photoFile').files;
  $('photoFile').value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return setPhotoStatus('Elige una imagen (foto o captura).', true);

  $('changePhotoBtn').disabled = true;
  setPhotoStatus('Subiendo foto…');
  try {
    const blob = await squareImage(file);
    const path = `${user.id}/avatar.jpg`;
    const { error: upError } = await run(db.storage.from('avatars').upload(path, blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '3600' }));
    if (upError) throw upError;
    const { data } = db.storage.from('avatars').getPublicUrl(path);
    // ?v= cambia en cada subida para que el teléfono no muestre la foto anterior guardada.
    const { data: updated, error } = await run(db.auth.updateUser({ data: { avatar_url: `${data.publicUrl}?v=${Date.now()}` } }));
    if (error) throw error;
    if (updated && updated.user) user = updated.user;
    renderAvatar();
    setPhotoStatus('Foto actualizada.');
  } catch (error) {
    setPhotoStatus(error && error.message === 'imagen'
      ? 'No se pudo leer esa imagen. Prueba con otra.'
      : 'No se pudo subir la foto. Revisa tu conexión.', true);
  } finally {
    $('changePhotoBtn').disabled = false;
  }
});

$('removePhotoBtn').addEventListener('click', async () => {
  setPhotoStatus('Quitando foto…');
  await run(db.storage.from('avatars').remove([`${user.id}/avatar.jpg`]));
  const { data: updated, error } = await run(db.auth.updateUser({ data: { avatar_url: null } }));
  if (error) return setPhotoStatus('No se pudo quitar la foto. Revisa tu conexión.', true);
  if (updated && updated.user) user = updated.user;
  renderAvatar();
  setPhotoStatus('Foto quitada.');
});

/* ---------- Contraseña olvidada y cambio de contraseña ---------- */

// El enlace del correo de recuperación (ver sendResetLink) abre la app con sesión y pide la contraseña nueva.
const passwordDialog = $('passwordDialog');
const passwordForm = $('passwordForm');
const newPassword = $('newPassword');
const newPassword2 = $('newPassword2');

function setPasswordStatus(message, isError = false) {
  $('passwordStatus').textContent = message;
  $('passwordStatus').classList.toggle('error', isError);
}

function openPasswordDialog(fromEmail) {
  passwordForm.reset();
  setPasswordStatus('');
  $('passwordTitle').textContent = fromEmail ? 'Crea tu contraseña nueva' : 'Cambiar contraseña';
  $('passwordHint').textContent = fromEmail
    ? 'Entraste con el enlace del correo. Ahora elige una contraseña nueva (mínimo 6 caracteres).'
    : 'Escribe tu nueva contraseña (mínimo 6 caracteres).';
  if (!passwordDialog.open) passwordDialog.showModal();
  newPassword.focus();
}

$('changePasswordBtn').addEventListener('click', () => {
  ui.accountDialog.close();
  openPasswordDialog(false);
});
$('cancelPassword').addEventListener('click', () => passwordDialog.close());

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (newPassword.value.length < 6) return setPasswordStatus('Debe tener al menos 6 caracteres.', true);
  if (newPassword.value !== newPassword2.value) return setPasswordStatus('Las contraseñas no coinciden.', true);
  $('savePassword').disabled = true;
  setPasswordStatus('Guardando…');
  const { error } = await run(db.auth.updateUser({ password: newPassword.value }));
  $('savePassword').disabled = false;
  if (error) {
    return setPasswordStatus(error.code === 'same_password'
      ? 'Esa ya es tu contraseña actual. Elige otra.'
      : error.code === 'weak_password' ? 'Es muy débil. Usa al menos 6 caracteres.'
      : 'No se pudo cambiar. Revisa tu conexión.', true);
  }
  passwordDialog.close();
  notify('Contraseña cambiada. Úsala la próxima vez que entres.');
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

  // Se lee el enlace del correo antes de que Supabase lo quite de la dirección.
  const linkParams = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  let pending = false;
  try { pending = sessionStorage.getItem('videotk.recovering') === '1'; } catch { /* nada */ }
  if (linkParams.get('type') === 'recovery' || pending) setRecovering(true);
  const linkError = linkParams.get('error_code') || linkParams.get('error');

  db = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
  // setTimeout: Supabase recomienda no llamar a la base de datos dentro de este aviso.
  db.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    setTimeout(() => applySession(session), 0);
  });
  const { data } = await run(db.auth.getSession());
  const session = data && data.session;
  if (recovering && !session) setRecovering(false); // el enlace no abrió sesión (caducado o usado)
  if (linkParams.get('type') === 'recovery') history.replaceState(null, '', location.pathname);
  await applySession(session);
  if (!user) showView(false);

  if (linkError) {
    history.replaceState(null, '', location.pathname);
    const message = 'El enlace del correo ya no es válido o caducó. Pide uno nuevo.';
    if (user) notify(message);
    else { setAuthMode('forgot'); setAuthStatus(message, true); }
  }
}

init();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
// En la app de Android/iOS los archivos ya vienen dentro: no hace falta el service worker.
if ('serviceWorker' in navigator && !IS_NATIVE) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
