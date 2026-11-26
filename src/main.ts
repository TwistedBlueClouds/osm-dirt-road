import './style.css';
import { MapView, type Basemap } from './mapview';
import { LaneLayer } from './lanelayer';
import { LaneEditor, type LaneRef } from './editor';
import {
  API_MAX_AREA, SERVERS, bboxArea, buildOsmChange, diffTags, isModified, isRelationModified, loadFromApi, loadFromOverpass,
  tagsEqual, type BBox, type OsmData, type OsmRelation, type OsmWay, type Tags,
} from './osm';
import { Uploader, getClientId, redirectUri, setClientId } from './upload';
import type { DrivingSide } from './lanes';
import { findConnectivityRelation, formatConnectivity, travelLanes, type LaneId } from './junctions';
import type { SignStyle } from './textures';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Settings (persisted per browser)

interface Settings {
  server: 'production' | 'dev';
  drivingSide: DrivingSide;
  centreLine: 'yellow' | 'white';
  signStyle: SignStyle;
  basemap: Basemap;
  roadOpacity: number;
  surroundings: boolean;
}
const SETTINGS_KEY = 'osm-lanes-3d.settings';
const DRAFT_KEY = 'osm-lanes-3d.draft';

function loadSettings(): Settings {
  const def: Settings = { server: 'production', drivingSide: 'right', centreLine: 'white', signStyle: 'blue', basemap: 'imagery', roadOpacity: 0.85, surroundings: true };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return def;
  }
}
function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

let settings = loadSettings();
let uploader = new Uploader(SERVERS[settings.server], settings.server);

// ---------------------------------------------------------------------------
// State

let data: OsmData | null = null;
let selectedId: number | null = null;
let selectedLane: LaneRef | null = null;
type RelSnapshot = Pick<OsmRelation, 'tags' | 'members' | 'deleted'> | null;
type UndoEntry = { wayId: number; tags: Tags } | { relId: number; before: RelSnapshot; wayId: number };
const undoStack: UndoEntry[] = [];
/** Lane whose connections are being edited by clicking target lanes. */
let connectFrom: { wayId: number; lane: LaneRef } | null = null;
let nextNewId = -1;

const status = (msg: string, error = false) => {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', error);
};

const view = new MapView($('map'), settings.basemap);
const scene = new LaneLayer(settings);
scene.setRoadOpacity(settings.roadOpacity);
scene.setSurroundingsVisible(settings.surroundings);
view.ready.then(() => view.map.addLayer(scene));
view.map.on('click', (e) => {
  if (e.originalEvent.shiftKey) return;
  const pick = scene.pick(e.point.x, e.point.y);
  if (connectFrom) {
    if (pick?.slot && pick.slot.dir !== 'both_ways') toggleConnection({ wayId: pick.wayId, dir: pick.slot.dir, index: pick.slot.index });
    else status('Click a lane on a road leaving the junction (Esc to finish).');
    return;
  }
  if (pick) selectWay(pick.wayId, pick.slot ? { dir: pick.slot.dir, index: pick.slot.index } : null, false);
});
view.onOverlayClick = (id) => {
  if (selectedId !== id) selectWay(id);
};
const editor = new LaneEditor($('editor'));
editor.server = SERVERS[settings.server];
editor.show(null);

function selectWay(id: number | null, lane: LaneRef | null = null, fly = true) {
  if (connectFrom) setConnectMode(null);
  editor.connecting = null;
  selectedId = id;
  selectedLane = lane;
  view.select(id);
  const way = id != null ? data?.ways.get(id) ?? null : null;
  editor.show(way, lane);
  scene.select(id, lane);
  const frame = id != null && fly ? scene.wayFrame(id) : null;
  if (frame) view.focus(frame);
}

editor.onConnect = (ref) => {
  if (selectedId == null || !ref) return;
  const same = connectFrom && connectFrom.wayId === selectedId && connectFrom.lane.dir === ref.dir && connectFrom.lane.index === ref.index;
  setConnectMode(same ? null : { wayId: selectedId, lane: ref });
  selectedLane = ref;
  scene.select(selectedId, ref);
  editor.connecting = connectFrom?.lane ?? null;
  editor.show(data?.ways.get(selectedId) ?? null, ref);
};

editor.onFocusLane = (ref) => {
  selectedLane = ref;
  if (selectedId != null) scene.select(selectedId, ref);
};

function setTags(id: number, tags: Tags, pushUndo = true) {
  const w = data?.ways.get(id);
  if (!w || tagsEqual(w.tags, tags)) {
    editor.show(w ?? null, selectedLane);
    return;
  }
  if (pushUndo) undoStack.push({ wayId: id, tags: { ...w.tags } });
  w.tags = tags;
  scene.updateWay(id);
  view.restyle(id);
  if (selectedId === id) editor.show(w, selectedLane);
  refreshCounts();
  saveDraft();
}

editor.onChange = (id, tags) => setTags(id, tags);
editor.onRevert = (id) => {
  const w = data?.ways.get(id);
  if (w) setTags(id, { ...w.origTags });
};

function undo() {
  const e = undoStack.pop();
  if (!e || !data) return;
  if ('relId' in e) {
    if (e.before) {
      const r = data.relations.get(e.relId);
      if (r) Object.assign(r, { tags: e.before.tags, members: e.before.members, deleted: e.before.deleted });
    } else data.relations.delete(e.relId);
    scene.updateWay();
    scene.select(selectedId, selectedLane);
  } else {
    setTags(e.wayId, e.tags, false);
    if (selectedId !== e.wayId) selectWay(e.wayId);
  }
  refreshCounts();
}

function modifiedWays(): OsmWay[] {
  return data ? Array.from(data.ways.values()).filter(isModified) : [];
}

function modifiedRelations(): OsmRelation[] {
  return data ? Array.from(data.relations.values()).filter(isRelationModified) : [];
}

// ---------------------------------------------------------------------------
// Lane connections (type=connectivity relations)

function setConnectMode(from: { wayId: number; lane: LaneRef } | null) {
  connectFrom = from;
  view.map.getCanvas().style.cursor = from ? 'cell' : '';
  document.body.classList.toggle('connecting', !!from);
  if (from) status('Connecting lanes: click each lane this lane leads into (click again to remove). Esc to finish.');
}

/** Add or remove a connection from the lane being edited to `to`, writing the relation. */
function toggleConnection(to: LaneId) {
  if (!data || !connectFrom || connectFrom.lane.dir === 'both_ways') return;
  const from: LaneId = { wayId: connectFrom.wayId, dir: connectFrom.lane.dir, index: connectFrom.lane.index };
  const fromGeo = scene.getGeo(from.wayId);
  const toGeo = scene.getGeo(to.wayId);
  if (!fromGeo || !toGeo) return;
  // The lane arrives at the end of the way it travels toward.
  const via = from.dir === 'forward' ? fromGeo.endNode : fromGeo.startNode;
  const leaves = (to.dir === 'forward' ? toGeo.startNode : toGeo.endNode) === via;
  if (to.wayId === from.wayId || !leaves || !scene.endsAt(to.wayId, via)) {
    status('That lane does not leave the junction this lane arrives at. Pick a lane on a road that starts at the same junction.', true);
    return;
  }
  // Current connections for this from → to pair (mapped or worked out), as OSM lane numbers.
  const current = new Map<number, number[]>();
  const number = (g: typeof fromGeo, dir: 'forward' | 'backward', index: number) => travelLanes(g, dir).findIndex((s) => s.index === index) + 1;
  for (const c of scene.connectionsOf(from.wayId)) {
    if (c.via !== via || c.to.wayId !== to.wayId || c.from.dir !== from.dir) continue;
    const f = number(fromGeo, c.from.dir, c.from.index);
    current.set(f, [...(current.get(f) ?? []), number(toGeo, c.to.dir, c.to.index)]);
  }
  const f = number(fromGeo, from.dir, from.index);
  const t = number(toGeo, to.dir, to.index);
  const list = current.get(f) ?? [];
  const adding = !list.includes(t);
  current.set(f, adding ? [...list, t] : list.filter((x) => x !== t));
  const value = formatConnectivity(current);

  let rel = findConnectivityRelation(data.relations.values(), from.wayId, via, to.wayId);
  const snap = (r: OsmRelation): RelSnapshot => ({ tags: { ...r.tags }, members: r.members.map((x) => ({ ...x })), deleted: r.deleted });
  if (!rel) {
    rel = {
      id: nextNewId--, version: 0, orig: null,
      tags: { type: 'connectivity', connectivity: value },
      members: [{ type: 'way', ref: from.wayId, role: 'from' }, { type: 'node', ref: via, role: 'via' }, { type: 'way', ref: to.wayId, role: 'to' }],
    };
    data.relations.set(rel.id, rel);
    undoStack.push({ relId: rel.id, before: null, wayId: from.wayId });
  } else {
    undoStack.push({ relId: rel.id, before: snap(rel), wayId: from.wayId });
    rel.tags = { ...rel.tags, connectivity: value };
  }
  if (!value) {
    // Nothing connects any more: an empty connectivity relation is meaningless.
    if (rel.orig) rel.deleted = true;
    else data.relations.delete(rel.id);
  }
  scene.updateWay();
  scene.select(selectedId, selectedLane);
  refreshCounts();
  status(`${adding ? 'Connected' : 'Disconnected'} lane ${f} → lane ${t}. connectivity=${value || '(none)'}`);
}

function refreshCounts() {
  const n = modifiedWays().length + modifiedRelations().length;
  $('n-changes').textContent = String(n);
  ($('btn-upload') as HTMLButtonElement).disabled = n === 0;
  ($('btn-undo') as HTMLButtonElement).disabled = undoStack.length === 0;
}

// ---------------------------------------------------------------------------
// Draft persistence: edits survive a reload as long as the way hasn't changed upstream.

function saveDraft() {
  const out: Record<string, { version: number; tags: Tags }> = {};
  for (const w of modifiedWays()) out[w.id] = { version: w.version, tags: w.tags };
  try {
    if (Object.keys(out).length) localStorage.setItem(DRAFT_KEY + '.' + settings.server, JSON.stringify(out));
    else localStorage.removeItem(DRAFT_KEY + '.' + settings.server);
  } catch {
    /* ignore */
  }
}

function restoreDraft(d: OsmData): number {
  let draft: Record<string, { version: number; tags: Tags }> = {};
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY + '.' + settings.server) ?? '{}');
  } catch {
    return 0;
  }
  let n = 0;
  for (const [id, e] of Object.entries(draft)) {
    const w = d.ways.get(Number(id));
    if (w && w.version === e.version) {
      w.tags = e.tags;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Loading

view.onAreaChange = (b) => {
  if (b) status(`Area selected: ${describe(b)}. Press Load.`);
};

function describe(b: BBox): string {
  const km = (b.north - b.south) * 111.32;
  const kmw = (b.east - b.west) * 111.32 * Math.cos(((b.north + b.south) / 2) * Math.PI / 180);
  return `${kmw.toFixed(2)} × ${km.toFixed(2)} km`;
}

async function load() {
  const area = view.getArea() ?? view.getView();
  const source = ($('source') as HTMLSelectElement).value;
  if (modifiedWays().length && !confirm('You have edits that are not uploaded. Loading a new area discards them (a draft is kept in this browser). Continue?')) return;
  if (source === 'api' && bboxArea(area) > API_MAX_AREA) {
    status(`Area too large for the OSM API (${bboxArea(area).toFixed(3)} > ${API_MAX_AREA} sq. degrees). Zoom in, draw a smaller area, or use Overpass.`, true);
    return;
  }
  if (source === 'overpass' && bboxArea(area) > 0.5) {
    status('Area too large, please choose a smaller area.', true);
    return;
  }
  const btn = $('btn-load') as HTMLButtonElement;
  btn.disabled = true;
  status(`Loading ${describe(area)} from ${source === 'api' ? 'the OSM API' : 'Overpass'}…`);
  try {
    const d = source === 'api' ? await loadFromApi(SERVERS[settings.server], area) : await loadFromOverpass(area);
    const restored = restoreDraft(d);
    data = d;
    undoStack.length = 0;
    scene.setData(d, { lat: (area.north + area.south) / 2, lon: (area.east + area.west) / 2 });
    view.setLoaded(area, d);
    if (view.map.getZoom() < 16) view.fitLoaded();
    selectWay(null);
    refreshCounts();
    const withLanes = Array.from(d.ways.values()).filter((w) => Object.keys(w.tags).some((k) => k.includes(':lanes'))).length;
    status(`Loaded ${d.ways.size} roads (${withLanes} with per-lane tags), ${d.context.buildings.length} buildings, ${d.context.trees.length} trees${restored ? `, restored ${restored} unsaved edit(s) from your draft` : ''}.`);
  } catch (e) {
    status(`Load failed: ${(e as Error).message}`, true);
  } finally {
    btn.disabled = false;
  }
}

$('btn-load').addEventListener('click', load);
$('btn-draw').addEventListener('click', () => {
  view.setDrawing(true);
  status('Drag on the map to draw the area to load (Esc to cancel). Tip: Shift+drag works any time.');
});
$('btn-overview').addEventListener('click', () => view.fitLoaded());
($('opacity') as HTMLInputElement).value = String(settings.roadOpacity);
$('opacity').addEventListener('input', (e) => {
  settings.roadOpacity = Number((e.target as HTMLInputElement).value);
  saveSettings(settings);
  scene.setRoadOpacity(settings.roadOpacity);
});
($('surroundings') as HTMLInputElement).checked = settings.surroundings;
$('surroundings').addEventListener('change', (e) => {
  settings.surroundings = (e.target as HTMLInputElement).checked;
  saveSettings(settings);
  scene.setSurroundingsVisible(settings.surroundings);
});
($('basemap') as HTMLSelectElement).value = settings.basemap;
$('basemap').addEventListener('change', (e) => {
  settings.basemap = (e.target as HTMLSelectElement).value as Basemap;
  saveSettings(settings);
  view.setBasemap(settings.basemap);
});
$('btn-undo').addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t.matches('input, textarea, select');
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !typing) {
    e.preventDefault();
    undo();
  } else if (e.key === 'Escape' && connectFrom) {
    setConnectMode(null);
    status('Finished connecting lanes.');
    if (selectedId != null) editor.show(data?.ways.get(selectedId) ?? null, selectedLane);
  } else if (e.key === 'Escape' && !typing && !document.querySelector('dialog[open]')) {
    selectWay(null);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (modifiedWays().length || modifiedRelations().length) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Place search (Nominatim)

const results = $('search-results');
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = ($('search-q') as HTMLInputElement).value.trim();
  if (!q) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`);
    const list = (await res.json()) as { display_name: string; lat: string; lon: string; boundingbox: string[] }[];
    results.innerHTML = '';
    if (!list.length) results.innerHTML = '<button type="button" disabled>No results</button>';
    for (const r of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.display_name;
      b.onclick = () => {
        results.hidden = true;
        const [s, n, w, ea] = r.boundingbox.map(Number);
        view.map.fitBounds([[w, s], [ea, n]], { maxZoom: 17, duration: 0 });
      };
      results.appendChild(b);
    }
    results.hidden = false;
  } catch (err) {
    status(`Search failed: ${(err as Error).message}`, true);
  }
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#search')) results.hidden = true;
});

// ---------------------------------------------------------------------------
// Account

async function refreshAccount() {
  const btn = $('btn-account');
  if (uploader.authenticated()) {
    btn.textContent = 'Signed in';
    try {
      const name = await uploader.userName();
      btn.textContent = name ? `👤 ${name}` : 'Signed in';
      btn.title = 'Click to sign out';
    } catch {
      btn.textContent = 'Sign in';
    }
  } else {
    btn.textContent = 'Sign in';
    btn.title = 'Sign in to OpenStreetMap';
  }
}

$('btn-account').addEventListener('click', async () => {
  if (uploader.authenticated()) {
    if (confirm('Sign out of OpenStreetMap in this app?')) {
      uploader.logout();
      refreshAccount();
    }
    return;
  }
  try {
    status('Signing in — finish in the popup window…');
    await uploader.login();
    status('Signed in.');
    refreshAccount();
  } catch (e) {
    status(`Sign-in failed: ${(e as Error).message}`, true);
    if (!getClientId(settings.server)) openSettings();
  }
});

// ---------------------------------------------------------------------------
// Settings dialog

const dlgSettings = $('dlg-settings') as HTMLDialogElement;
function openSettings() {
  ($('set-server') as HTMLSelectElement).value = settings.server;
  ($('set-client') as HTMLInputElement).value = getClientId(settings.server);
  ($('set-side') as HTMLSelectElement).value = settings.drivingSide;
  ($('set-centre') as HTMLSelectElement).value = settings.centreLine;
  ($('set-sign') as HTMLSelectElement).value = settings.signStyle;
  $('set-redirect').textContent = redirectUri();
  dlgSettings.showModal();
}
$('set-server').addEventListener('change', (e) => {
  ($('set-client') as HTMLInputElement).value = getClientId((e.target as HTMLSelectElement).value);
});
$('btn-settings').addEventListener('click', openSettings);
dlgSettings.addEventListener('close', () => {
  if (dlgSettings.returnValue !== 'save') return;
  const server = ($('set-server') as HTMLSelectElement).value as Settings['server'];
  setClientId(server, ($('set-client') as HTMLInputElement).value.trim());
  const serverChanged = server !== settings.server;
  if (serverChanged && modifiedWays().length && !confirm('Switching server discards loaded data and unsent edits. Continue?')) return;
  settings = {
    ...settings,
    server,
    drivingSide: ($('set-side') as HTMLSelectElement).value as DrivingSide,
    centreLine: ($('set-centre') as HTMLSelectElement).value as Settings['centreLine'],
    signStyle: ($('set-sign') as HTMLSelectElement).value as SignStyle,
  };
  saveSettings(settings);
  uploader = new Uploader(SERVERS[server], server);
  editor.server = SERVERS[server];
  scene.setOptions(settings);
  if (serverChanged) {
    data = null;
    scene.clear();
    view.setLoaded(null, null);
    selectWay(null);
    status(`Server set to ${SERVERS[server].apiUrl}. Load an area to start.`);
  } else if (selectedId != null) {
    selectWay(selectedId, selectedLane, false);
  }
  refreshAccount();
});

// ---------------------------------------------------------------------------
// Upload dialog

const dlgUpload = $('dlg-upload') as HTMLDialogElement;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

$('btn-upload').addEventListener('click', () => {
  const ways = modifiedWays();
  $('up-server').textContent = `Uploading to ${SERVERS[settings.server].apiUrl}${settings.server === 'dev' ? ' (test server)' : ' — this changes the live map'}.`;
  $('up-list').innerHTML = ways.map((w) => `
    <h4>${esc(w.tags.name ?? w.tags.ref ?? w.tags.highway ?? '')} <small>way ${w.id}</small></h4>
    <div class="diff">${diffTags(w.origTags, w.tags).map((d) => `
      <div class="${d.before === undefined ? 'add' : d.after === undefined ? 'del' : 'mod'}"><code>${esc(d.key)}</code>
      ${d.before !== undefined ? `<s>${esc(d.before)}</s>` : ''}${d.after !== undefined ? ` → <b>${esc(d.after)}</b>` : ' (removed)'}</div>`).join('')}
    </div>`).join('') + modifiedRelations().map((r) => `
    <h4>Lane connection <small>relation ${r.id < 0 ? '(new)' : r.id}</small></h4>
    <div class="diff"><div class="${r.deleted ? 'del' : r.orig ? 'mod' : 'add'}">
      way ${r.members.find((x) => x.role === 'from')?.ref} → way ${r.members.find((x) => x.role === 'to')?.ref}:
      ${r.deleted ? '(deleted)' : `<code>connectivity</code> ${r.orig ? `<s>${esc(r.orig.tags.connectivity ?? '')}</s> → ` : ''}<b>${esc(r.tags.connectivity ?? '')}</b>`}
    </div></div>`).join('');
  $('up-msg').textContent = '';
  $('up-msg').className = 'hint';
  dlgUpload.showModal();
});

$('up-osc').addEventListener('click', () => {
  const blob = new Blob([buildOsmChange(modifiedWays(), -1, modifiedRelations())], { type: 'application/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lanes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.osc`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('up-go').addEventListener('click', async () => {
  const comment = ($('up-comment') as HTMLTextAreaElement).value.trim();
  const msg = $('up-msg');
  if (!comment) {
    msg.textContent = 'Please describe your changes in the changeset comment.';
    msg.className = 'hint error';
    return;
  }
  const tags: Tags = { comment, created_by: 'OSM Lanes 3D' };
  const src = ($('up-source') as HTMLInputElement).value.trim();
  const hashtags = ($('up-hashtags') as HTMLInputElement).value.trim();
  if (src) tags.source = src;
  if (hashtags) tags.hashtags = hashtags.split(/[\s,;]+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : '#' + h)).join(';');
  const go = $('up-go') as HTMLButtonElement;
  go.disabled = true;
  try {
    const ways = modifiedWays();
    const id = await uploader.upload(ways, modifiedRelations(), data!, tags, (s) => (msg.textContent = s));
    const url = `${SERVERS[settings.server].webUrl}/changeset/${id}`;
    msg.innerHTML = `Uploaded! <a href="${url}" target="_blank" rel="noopener">Changeset ${id}</a>`;
    msg.className = 'hint';
    for (const w of ways) {
      scene.updateWay(w.id);
      view.restyle(w.id);
    }
    undoStack.length = 0;
    refreshCounts();
    saveDraft();
    if (selectedId != null) editor.show(data!.ways.get(selectedId) ?? null, selectedLane);
    status(`Uploaded changeset ${id}.`);
    refreshAccount();
  } catch (e) {
    const m = (e as Error).message;
    msg.textContent = /409/.test(m)
      ? `Conflict: someone else edited one of these ways since you loaded it. Reload the area (your edits are kept as a draft only if versions match). Details: ${m}`
      : `Upload failed: ${m}`;
    msg.className = 'hint error';
  } finally {
    go.disabled = false;
  }
});

refreshCounts();
refreshAccount();
status('Pick an area: move the map and press Load, or draw a rectangle with “Draw area” / Shift+drag.');

// Dev-only handle for automated browser checks.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__lanes = { selectWay, getData: () => data, view, scene };
}
