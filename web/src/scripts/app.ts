import type { Paper, Venue, SavedSearch } from './types';
import { toBibtex, toCsv, type ExportRow } from './export';

// --- constants & storage keys ------------------------------------------
const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');
const K_SELECTED = 'confcrawl.selected';
const K_FAVS = 'confcrawl.favorites';
const K_THEME = 'confcrawl.theme';
const K_SAVED = 'confcrawl.savedSearches';
const PAGE = 200;

// --- helpers -----------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function joinList(values: string[], fallback = 'Not listed') {
  return values.length ? values.join('; ') : fallback;
}
function shortList(values: string[], max = 1) {
  if (!values.length) return 'Not listed';
  const visible = values.slice(0, max).join('; ');
  const hidden = values.length - max;
  return hidden > 0 ? `${visible} +${hidden}` : visible;
}
function searchBlob(p: Paper): string {
  if (p._search === undefined) {
    p._search = [
      p.id, p.title, p.abstract, p.eventType, p.authorInstitutions,
      ...p.authors, ...p.tracks, ...p.sessionTitles, ...p.locations,
    ].join(' ').toLowerCase();
  }
  return p._search;
}
function eventList(p: Paper): string[] {
  return p.eventType ? p.eventType.split(';').map((s) => s.trim()).filter(Boolean) : [];
}

// --- state -------------------------------------------------------------
const manifest: Venue[] = JSON.parse($('#venues-data').textContent || '[]');
const venueById = new Map(manifest.map((v) => [v.id, v]));

const state = {
  selected: new Set<string>(),
  loaded: new Map<string, Paper[]>(),
  rows: [] as { p: Paper; v: string }[],
  query: '',
  tracks: new Set<string>(),
  events: new Set<string>(),
  venuesFacet: new Set<string>(),
  sort: 'venue',
  favOnly: false,
  favs: new Set<string>(readJson<string[]>(K_FAVS, [])),
  sel: new Set<string>(),
  saved: readJson<SavedSearch[]>(K_SAVED, []),
  shown: PAGE,
};

const key = (v: string, id: string) => `${v}:${id}`;

// --- URL state ---------------------------------------------------------
function readUrl() {
  const q = new URLSearchParams(location.search);
  const v = q.get('v');
  if (v) v.split(',').filter(Boolean).forEach((id) => state.selected.add(id));
  state.query = q.get('q') ?? '';
  state.sort = q.get('sort') ?? 'venue';
  state.favOnly = q.get('fav') === '1';
  (q.get('track') ?? '').split(',').filter(Boolean).forEach((t) => state.tracks.add(t));
  (q.get('event') ?? '').split(',').filter(Boolean).forEach((e) => state.events.add(e));
  return !!v || q.has('q') || q.has('track');
}
function writeUrl() {
  const q = new URLSearchParams();
  if (state.selected.size) q.set('v', [...state.selected].join(','));
  if (state.query) q.set('q', state.query);
  if (state.sort !== 'venue') q.set('sort', state.sort);
  if (state.favOnly) q.set('fav', '1');
  if (state.tracks.size) q.set('track', [...state.tracks].join(','));
  if (state.events.size) q.set('event', [...state.events].join(','));
  const qs = q.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  writeJson(K_SELECTED, [...state.selected]);
}

// --- data loading ------------------------------------------------------
const loadingBar = Object.assign(document.createElement('div'), { className: 'loading-bar' });
document.body.appendChild(loadingBar);

async function ensureLoaded(ids: string[]) {
  const todo = ids.filter((id) => !state.loaded.has(id) && venueById.has(id));
  if (!todo.length) { rebuildRows(); return; }
  let done = 0;
  loadingBar.classList.remove('done');
  loadingBar.style.width = '8%';
  await Promise.all(
    todo.map(async (id) => {
      try {
        const res = await fetch(`${BASE}data/${id}.json`);
        state.loaded.set(id, res.ok ? await res.json() : []);
      } catch {
        state.loaded.set(id, []);
      }
      done += 1;
      loadingBar.style.width = `${8 + (done / todo.length) * 92}%`;
    }),
  );
  loadingBar.classList.add('done');
  setTimeout(() => { loadingBar.style.width = '0'; }, 320);
  rebuildRows();
}

function rebuildRows() {
  const rows: { p: Paper; v: string }[] = [];
  for (const v of manifest) {
    if (!state.selected.has(v.id)) continue;
    for (const p of state.loaded.get(v.id) ?? []) rows.push({ p, v: v.id });
  }
  state.rows = rows;
}

// --- filtering & sorting ----------------------------------------------
function matches(row: { p: Paper; v: string }): boolean {
  const { p, v } = row;
  if (state.favOnly && !state.favs.has(key(v, p.id))) return false;
  if (state.venuesFacet.size && !state.venuesFacet.has(v)) return false;
  if (state.tracks.size && !p.tracks.some((t) => state.tracks.has(t))) return false;
  if (state.events.size && !eventList(p).some((e) => state.events.has(e))) return false;
  if (state.query && !searchBlob(p).includes(state.query)) return false;
  return true;
}
function sortRows(rows: { p: Paper; v: string }[]) {
  const s = state.sort;
  return rows.sort((a, b) => {
    if (s === 'title') return a.p.title.localeCompare(b.p.title);
    if (s === 'authors') return (a.p.authors[0] ?? '').localeCompare(b.p.authors[0] ?? '');
    if (s === 'id') return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    // venue: group by manifest order, then id
    if (a.v !== b.v) return manifest.findIndex((m) => m.id === a.v) - manifest.findIndex((m) => m.id === b.v);
    return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
  });
}

// --- rendering ---------------------------------------------------------
const els = {
  list: $('#paperList'),
  more: $('#listMore'),
  summary: $('#resultSummary'),
  facets: $<HTMLElement>('#facets'),
  facetCount: $('#facetActiveCount'),
  active: $('#activeFilters'),
  exportBar: $('#exportBar'),
  selCount: $('#selCount'),
  search: $<HTMLInputElement>('#searchInput'),
  searchClear: $<HTMLButtonElement>('[data-search-clear]'),
  sort: $<HTMLSelectElement>('#sortSelect'),
  favOnly: $<HTMLInputElement>('#favOnly'),
};

function cardHtml(p: Paper, v: string): string {
  const venue = venueById.get(v)!;
  const k = key(v, p.id);
  const fav = state.favs.has(k);
  const sel = state.sel.has(k);
  const authors = p.authors.length
    ? p.authors.map((a) => `<button class="link-author" data-author="${esc(a)}">${esc(a)}</button>`).join(', ')
    : 'Not listed';
  const tracks = p.tracks.slice(0, 5).map((t) => `<button class="chip chip-track" data-track="${esc(t)}">${esc(t)}</button>`).join('');
  const extra = p.tracks.length > 5 ? `<span class="chip">+${p.tracks.length - 5} more</span>` : '';
  return `<article class="paper-card${sel ? ' is-selected' : ''}" data-key="${esc(k)}">
    <span class="card-select"><input type="checkbox" data-sel ${sel ? 'checked' : ''} aria-label="Select"></span>
    <div class="card-head">
      <button class="venue-badge" data-venue-badge title="Filter to ${esc(venue.name)}">${esc(venue.name)}</button>
      <span class="paper-id">${esc(p.id)}</span>
    </div>
    <h2 class="paper-title">${esc(p.title)}</h2>
    <p class="paper-authors">${authors}</p>
    <button class="icon-btn favorite-button" data-fav aria-pressed="${fav}" title="${fav ? 'Remove from favorites' : 'Save to favorites'}">${fav ? '★' : '☆'}</button>
    <div class="compact-meta">
      <span class="meta-item" title="${esc(joinList(p.dates))}"><strong>Date:</strong>${esc(shortList(p.dates))}</span>
      <span class="meta-item" title="${esc(joinList(p.locations))}"><strong>Location:</strong>${esc(shortList(p.locations))}</span>
      <span class="meta-item" title="${esc(joinList(p.sessionTitles))}"><strong>Session:</strong>${esc(shortList(p.sessionTitles))}</span>
    </div>
    ${p.abstract ? `<details class="paper-abstract"><summary>Abstract</summary><p>${esc(p.abstract)}</p></details>` : ''}
    ${tracks || extra ? `<div class="chips">${tracks}${extra}</div>` : ''}
    ${p.urls[0] ? `<a class="icon-btn program-link" href="${esc(p.urls[0])}" target="_blank" rel="noreferrer" title="Open program page" aria-label="Open program page">↗</a>` : ''}
  </article>`;
}

function renderFacets(base: { p: Paper; v: string }[]) {
  const trackCount = new Map<string, number>();
  const eventCount = new Map<string, number>();
  const venueCount = new Map<string, number>();
  for (const { p, v } of base) {
    for (const t of new Set(p.tracks)) trackCount.set(t, (trackCount.get(t) ?? 0) + 1);
    for (const e of new Set(eventList(p))) eventCount.set(e, (eventCount.get(e) ?? 0) + 1);
    venueCount.set(v, (venueCount.get(v) ?? 0) + 1);
  }
  const group = (title: string, counts: Map<string, number>, active: Set<string>, kind: string, label: (id: string) => string) => {
    const opts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!opts.length) return '';
    const rows = opts.map(([val, n]) =>
      `<label class="facet-option"><input type="checkbox" data-facet="${kind}" value="${esc(val)}" ${active.has(val) ? 'checked' : ''}>
        <span class="facet-label">${esc(label(val))}</span><span class="facet-count">${n}</span></label>`).join('');
    return `<div class="facet-group"><p class="facet-title">${title}</p><div class="facet-options">${rows}</div></div>`;
  };
  const venueGroup = state.selected.size > 1
    ? group('Venue', venueCount, state.venuesFacet, 'venue', (id) => venueById.get(id)?.name ?? id) : '';
  els.facets.innerHTML =
    group('Track', trackCount, state.tracks, 'track', (x) => x) +
    group('Event type', eventCount, state.events, 'event', (x) => x) +
    venueGroup;
  const activeN = state.tracks.size + state.events.size + state.venuesFacet.size;
  els.facetCount.textContent = String(activeN);
  els.facetCount.hidden = activeN === 0;
}

function renderActiveFilters() {
  const chips: string[] = [];
  const add = (kind: string, val: string, label: string) =>
    chips.push(`<span class="filter-chip">${esc(label)}<button data-remove-filter data-kind="${kind}" data-val="${esc(val)}" aria-label="Remove">×</button></span>`);
  state.tracks.forEach((t) => add('track', t, t));
  state.events.forEach((e) => add('event', e, e));
  state.venuesFacet.forEach((v) => add('venue', v, venueById.get(v)?.name ?? v));
  els.active.innerHTML = chips.join('');
}

function render() {
  // reflect simple controls
  els.search.value = state.query;
  els.searchClear.hidden = !state.query;
  els.sort.value = state.sort;
  els.favOnly.checked = state.favOnly;

  if (!state.selected.size) {
    els.list.innerHTML = `<div class="empty-state"><h2>No venues selected</h2><p>Pick one or more venues from the left to browse their papers.</p></div>`;
    els.summary.textContent = 'Select a venue to begin.';
    els.facets.innerHTML = '';
    renderActiveFilters();
    updateExportBar();
    els.more.hidden = true;
    return;
  }

  const queryFavBase = state.rows.filter((r) => {
    if (state.favOnly && !state.favs.has(key(r.v, r.p.id))) return false;
    if (state.query && !searchBlob(r.p).includes(state.query)) return false;
    return true;
  });
  renderFacets(queryFavBase);

  const filtered = sortRows(state.rows.filter(matches));
  const slice = filtered.slice(0, state.shown);
  els.list.innerHTML = slice.length
    ? slice.map((r) => cardHtml(r.p, r.v)).join('')
    : `<div class="empty-state"><h2>No matching papers</h2><p>Try clearing the search or filters.</p></div>`;

  const venuesShown = new Set(filtered.map((r) => r.v)).size;
  els.summary.textContent = `${filtered.length.toLocaleString()} of ${state.rows.length.toLocaleString()} papers · ${venuesShown} venue${venuesShown === 1 ? '' : 's'}`;

  if (filtered.length > state.shown) {
    els.more.hidden = false;
    els.more.innerHTML = `<button class="text-btn" id="showMore">Show ${Math.min(PAGE, filtered.length - state.shown)} more (${filtered.length - state.shown} hidden)</button>`;
  } else {
    els.more.hidden = true;
  }
  renderActiveFilters();
  updateExportBar();
}

function updateExportBar() {
  const n = state.sel.size;
  els.exportBar.hidden = n === 0;
  els.selCount.textContent = `${n} selected`;
}

// --- sidebar -----------------------------------------------------------
function reflectSidebar() {
  document.querySelectorAll<HTMLInputElement>('[data-venue-check]').forEach((cb) => {
    cb.checked = state.selected.has(cb.value);
    cb.closest('.venue-row')?.classList.toggle('is-active', cb.checked);
  });
}

function setVenue(id: string, on: boolean) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  state.shown = PAGE;
  reflectSidebar();
  writeUrl();
  ensureLoaded([...state.selected]).then(render);
}

// --- toast -------------------------------------------------------------
let toastTimer = 0;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 2200);
}

// --- export & saved searches ------------------------------------------
function currentExportRows(): ExportRow[] {
  const source = state.sel.size
    ? state.rows.filter((r) => state.sel.has(key(r.v, r.p.id)))
    : sortRows(state.rows.filter(matches));
  return source.map((r) => ({ paper: r.p, venue: venueById.get(r.v)! }));
}
async function doExport(format: string) {
  if (format === 'clear') { state.sel.clear(); render(); return; }
  const rows = currentExportRows();
  if (!rows.length) { toast('Nothing to export'); return; }
  if (format === 'bibtex') {
    try { await navigator.clipboard.writeText(toBibtex(rows)); toast(`Copied ${rows.length} BibTeX entries`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'csv') {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'confcrawl-papers.csv' });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Downloaded ${rows.length} rows`);
  }
}

function renderSaved() {
  const list = $('#savedList');
  if (!state.saved.length) { list.innerHTML = '<p class="saved-empty">No saved searches yet.</p>'; return; }
  list.innerHTML = state.saved.map((s, i) =>
    `<div class="saved-item"><button class="saved-load" data-saved-load="${i}">${esc(s.name)}</button><button class="saved-del" data-saved-del="${i}" aria-label="Delete">×</button></div>`).join('');
}
function saveCurrentSearch() {
  const name = window.prompt('Name this search:', state.query || 'My search');
  if (!name) return;
  state.saved.push({
    name, query: state.query, sort: state.sort, favOnly: state.favOnly,
    tracks: [...state.tracks], events: [...state.events], venues: [...state.selected],
  });
  writeJson(K_SAVED, state.saved);
  toast('Search saved');
}
function loadSaved(i: number) {
  const s = state.saved[i];
  if (!s) return;
  state.query = s.query; state.sort = s.sort; state.favOnly = s.favOnly;
  state.tracks = new Set(s.tracks); state.events = new Set(s.events);
  state.selected = new Set(s.venues); state.venuesFacet.clear(); state.shown = PAGE;
  reflectSidebar(); writeUrl(); closeModals();
  ensureLoaded([...state.selected]).then(render);
}

// --- modals ------------------------------------------------------------
function closeModals() { document.querySelectorAll<HTMLElement>('.modal').forEach((m) => { m.hidden = true; }); }

// --- theme -------------------------------------------------------------
function reflectTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('[data-theme-icon]').forEach((el) => { el.textContent = dark ? '☀️' : '🌙'; });
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(K_THEME, dark ? 'light' : 'dark'); } catch { /* ignore */ }
  reflectTheme();
}

// --- events ------------------------------------------------------------
function wire() {
  // sidebar venue checkboxes
  document.querySelectorAll<HTMLInputElement>('[data-venue-check]').forEach((cb) => {
    cb.addEventListener('change', () => setVenue(cb.value, cb.checked));
  });
  // collapse categories
  document.querySelectorAll<HTMLButtonElement>('[data-cat-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'false';
      btn.setAttribute('aria-expanded', String(!open));
      (btn.nextElementSibling as HTMLElement).hidden = open;
    });
  });
  // venue filter in sidebar
  $<HTMLInputElement>('[data-venue-search]').addEventListener('input', (e) => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>('[data-venue-row]').forEach((row) => {
      row.hidden = q.length > 0 && !(row.dataset.venueName ?? '').includes(q);
    });
    document.querySelectorAll<HTMLElement>('.venue-cat').forEach((cat) => {
      cat.hidden = !cat.querySelector('[data-venue-row]:not([hidden])');
    });
  });
  $('[data-select-all]').addEventListener('click', () => { manifest.forEach((v) => state.selected.add(v.id)); state.shown = PAGE; reflectSidebar(); writeUrl(); ensureLoaded([...state.selected]).then(render); });
  $('[data-select-none]').addEventListener('click', () => { state.selected.clear(); reflectSidebar(); writeUrl(); rebuildRows(); render(); });

  // search
  let t = 0;
  els.search.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(() => { state.query = els.search.value.trim().toLowerCase(); state.shown = PAGE; writeUrl(); render(); }, 130);
  });
  els.searchClear.addEventListener('click', () => { state.query = ''; els.search.value = ''; writeUrl(); render(); els.search.focus(); });
  els.sort.addEventListener('change', () => { state.sort = els.sort.value; writeUrl(); render(); });
  els.favOnly.addEventListener('change', () => {
    state.favOnly = els.favOnly.checked; state.shown = PAGE;
    // ensure venues with favorites are loaded
    if (state.favOnly) {
      const need = [...state.favs].map((k) => k.split(':')[0]).filter((id) => venueById.has(id) && !state.selected.has(id));
      need.forEach((id) => state.selected.add(id));
      reflectSidebar();
      ensureLoaded([...state.selected]).then(() => { writeUrl(); render(); });
    } else { writeUrl(); render(); }
  });

  // facets toggle + changes
  $('[data-facets-toggle]').addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const open = els.facets.hidden;
    els.facets.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  els.facets.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement;
    if (!cb.dataset.facet) return;
    const set = cb.dataset.facet === 'track' ? state.tracks : cb.dataset.facet === 'event' ? state.events : state.venuesFacet;
    if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    state.shown = PAGE; writeUrl(); render();
  });
  els.active.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-remove-filter]');
    if (!btn) return;
    const set = btn.dataset.kind === 'track' ? state.tracks : btn.dataset.kind === 'event' ? state.events : state.venuesFacet;
    set.delete(btn.dataset.val ?? '');
    writeUrl(); render();
  });

  // paper list delegation
  els.list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('.paper-card');
    if (!card) return;
    const k = card.dataset.key ?? '';
    if (target.closest('[data-fav]')) {
      if (state.favs.has(k)) state.favs.delete(k); else state.favs.add(k);
      writeJson(K_FAVS, [...state.favs].sort());
      render();
    } else if (target.closest('[data-venue-badge]')) {
      const v = k.split(':')[0];
      state.venuesFacet.has(v) ? state.venuesFacet.delete(v) : state.venuesFacet.add(v);
      state.shown = PAGE; writeUrl(); render();
    } else if (target.closest('[data-author]')) {
      state.query = (target.closest('[data-author]') as HTMLElement).dataset.author!.toLowerCase();
      state.shown = PAGE; writeUrl(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (target.closest('[data-track]')) {
      const tr = (target.closest('[data-track]') as HTMLElement).dataset.track!;
      state.tracks.has(tr) ? state.tracks.delete(tr) : state.tracks.add(tr);
      state.shown = PAGE; writeUrl(); render();
    }
  });
  els.list.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement;
    if (!cb.matches('[data-sel]')) return;
    const k = cb.closest<HTMLElement>('.paper-card')!.dataset.key ?? '';
    if (cb.checked) state.sel.add(k); else state.sel.delete(k);
    cb.closest('.paper-card')?.classList.toggle('is-selected', cb.checked);
    updateExportBar();
  });
  els.more.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'showMore') { state.shown += PAGE; render(); }
  });

  // export bar
  els.exportBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-export]');
    if (btn) doExport(btn.dataset.export!);
  });

  // saved searches
  $('[data-open-saved]').addEventListener('click', () => { renderSaved(); $('#savedModal').hidden = false; });
  $('[data-save-current]').addEventListener('click', () => { saveCurrentSearch(); renderSaved(); });

  // theme, help, modals
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
  $('[data-help]').addEventListener('click', () => { $('#helpModal').hidden = false; });
  document.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));
  $('#savedList').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const load = target.closest<HTMLElement>('[data-saved-load]');
    const del = target.closest<HTMLElement>('[data-saved-del]');
    if (load) loadSaved(Number(load.dataset.savedLoad));
    if (del) { state.saved.splice(Number(del.dataset.savedDel), 1); writeJson(K_SAVED, state.saved); renderSaved(); }
  });

  // mobile sidebar
  $('[data-sidebar-toggle]').addEventListener('click', () => $('#app').classList.add('sidebar-open'));
  $('#sidebarScrim').addEventListener('click', () => $('#app').classList.remove('sidebar-open'));

  // back to top
  const back = $('#backToTop');
  back.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => { back.hidden = window.scrollY < 400; }, { passive: true });

  // keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); els.search.focus(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); const m = $('#helpModal'); m.hidden = !m.hidden; }
    else if (e.key === 'Escape') {
      if (document.activeElement === els.search && state.query) { state.query = ''; els.search.value = ''; writeUrl(); render(); }
      else { closeModals(); $('#app').classList.remove('sidebar-open'); }
    } else if (e.key === 'f' && !typing) { els.facets.hidden = !els.facets.hidden; $('[data-facets-toggle]').setAttribute('aria-expanded', String(!els.facets.hidden)); }
  });
}

// --- init --------------------------------------------------------------
function init() {
  reflectTheme();
  const fromUrl = readUrl();
  if (!fromUrl) {
    const stored = readJson<string[]>(K_SELECTED, []);
    const ids = stored.length ? stored : manifest.map((v) => v.id);
    ids.forEach((id) => { if (venueById.has(id)) state.selected.add(id); });
  }
  renderSaved();
  wire();
  reflectSidebar();
  if (state.favOnly) els.favOnly.checked = true;
  ensureLoaded([...state.selected]).then(render);
}

init();
