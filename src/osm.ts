// OSM data model, loading (API 0.6 / Overpass), and osmChange generation.

export type Tags = Record<string, string>;

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  version: number;
  /** Only present on tagged nodes (crossings, signals, trees, …). */
  tags?: Tags;
}

export interface OsmWay {
  id: number;
  version: number;
  nodes: number[];
  tags: Tags;
  /** Tags as loaded from the server; used to detect modifications. */
  origTags: Tags;
}

export interface OsmRelation {
  id: number;
  version: number;
  tags: Tags;
  members: RelMember[];
  /** State on the server; null for a relation created in this session. */
  orig: { tags: Tags; members: RelMember[] } | null;
  /** Marked for deletion on upload. */
  deleted?: boolean;
}

export interface RelMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

export type LonLat = [number, number];

/** A building or building part footprint. */
export interface Footprint {
  tags: Tags;
  outer: LonLat[];
  inners: LonLat[][];
}

/** Read-only surroundings drawn for orientation. */
export interface Context {
  buildings: Footprint[];
  trees: { lon: number; lat: number; tags: Tags }[];
}

export interface OsmData {
  nodes: Map<number, OsmNode>;
  /** Editable road ways. */
  ways: Map<number, OsmWay>;
  /** Every way in the download, roads or not (used for surroundings and street features). */
  allWays: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
  context: Context;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ServerConfig {
  /** API base, e.g. https://api.openstreetmap.org */
  apiUrl: string;
  /** Website / OAuth base, e.g. https://www.openstreetmap.org */
  webUrl: string;
}

export const SERVERS: Record<string, ServerConfig> = {
  production: {
    apiUrl: 'https://api.openstreetmap.org',
    webUrl: 'https://www.openstreetmap.org',
  },
  dev: {
    apiUrl: 'https://master.apis.dev.openstreetmap.org',
    webUrl: 'https://master.apis.dev.openstreetmap.org',
  },
};

/** Highway values that carry vehicle lanes and are worth showing in 3D. */
export const ROAD_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'road', 'busway', 'track',
]);

export function bboxArea(b: BBox): number {
  return Math.abs(b.north - b.south) * Math.abs(b.east - b.west);
}

/** OSM API /map call is limited to 0.25 square degrees. */
export const API_MAX_AREA = 0.25;

function parseOsmXml(text: string): OsmData {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Could not parse OSM XML response');
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const readTags = (el: Element): Tags => {
    const tags: Tags = {};
    for (const t of el.children) if (t.tagName === 'tag') tags[t.getAttribute('k')!] = t.getAttribute('v') ?? '';
    return tags;
  };
  doc.querySelectorAll('osm > node').forEach((n) => {
    const id = Number(n.getAttribute('id'));
    const node: OsmNode = {
      id,
      lat: Number(n.getAttribute('lat')),
      lon: Number(n.getAttribute('lon')),
      version: Number(n.getAttribute('version') ?? 0),
    };
    if (n.children.length) node.tags = readTags(n);
    nodes.set(id, node);
  });
  doc.querySelectorAll('osm > way').forEach((w) => {
    const tags = readTags(w);
    const id = Number(w.getAttribute('id'));
    ways.set(id, {
      id,
      version: Number(w.getAttribute('version') ?? 0),
      nodes: Array.from(w.querySelectorAll('nd')).map((nd) => Number(nd.getAttribute('ref'))),
      tags,
      origTags: { ...tags },
    });
  });
  const relations = new Map<number, OsmRelation>();
  doc.querySelectorAll('osm > relation').forEach((r) => {
    const id = Number(r.getAttribute('id'));
    const tags = readTags(r);
    const members: RelMember[] = Array.from(r.querySelectorAll('member')).map((m) => ({
      type: m.getAttribute('type') as RelMember['type'],
      ref: Number(m.getAttribute('ref')),
      role: m.getAttribute('role') ?? '',
    }));
    relations.set(id, {
      id, version: Number(r.getAttribute('version') ?? 0), tags, members,
      orig: { tags: { ...tags }, members: members.map((m) => ({ ...m })) },
    });
  });
  return assemble(nodes, ways, relations);
}

/** Split a raw download into editable roads and read-only surroundings. */
export function assemble(nodes: Map<number, OsmNode>, allWays: Map<number, OsmWay>, relations: Map<number, OsmRelation>): OsmData {
  const ways = new Map<number, OsmWay>();
  for (const w of allWays.values()) {
    if (!w.tags.highway || !ROAD_HIGHWAYS.has(w.tags.highway)) continue;
    if (w.tags.area === 'yes') continue;
    if (w.nodes.length < 2 || !w.nodes.every((id) => nodes.has(id))) continue;
    ways.set(w.id, w);
  }
  return { nodes, ways, allWays, relations, context: buildContext(nodes, allWays, relations) };
}

const isBuilding = (t: Tags) => (t.building !== undefined && t.building !== 'no') || (t['building:part'] !== undefined && t['building:part'] !== 'no');

function buildContext(nodes: Map<number, OsmNode>, ways: Map<number, OsmWay>, relations: Map<number, OsmRelation>): Context {
  const ringOf = (ids: number[]): LonLat[] | null => {
    const out: LonLat[] = [];
    for (const id of ids) {
      const n = nodes.get(id);
      if (!n) return null;
      out.push([n.lon, n.lat]);
    }
    return out;
  };
  const closed = (w: OsmWay) => w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];

  /** Join member ways end to end into closed rings of node ids. */
  const joinRings = (members: OsmWay[]): number[][] => {
    const rings: number[][] = [];
    const pool = members.map((w) => w.nodes.slice());
    while (pool.length) {
      let cur = pool.pop()!;
      let grew = true;
      while (cur[0] !== cur[cur.length - 1] && grew) {
        grew = false;
        for (let i = 0; i < pool.length; i++) {
          const c = pool[i];
          const tail = cur[cur.length - 1];
          if (c[0] === tail) cur = cur.concat(c.slice(1));
          else if (c[c.length - 1] === tail) cur = cur.concat(c.slice(0, -1).reverse());
          else continue;
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
      if (cur.length >= 4 && cur[0] === cur[cur.length - 1]) rings.push(cur);
    }
    return rings;
  };

  const buildings: Footprint[] = [];
  const usedAsOuter = new Set<number>();
  for (const r of relations.values()) {
    if (r.tags.type !== 'multipolygon' || !isBuilding(r.tags)) continue;
    const pick = (role: string) => r.members.filter((m) => m.type === 'way' && (m.role === role || (role === 'outer' && m.role === ''))).map((m) => ways.get(m.ref)).filter((w): w is OsmWay => !!w);
    const outers = joinRings(pick('outer')).map(ringOf).filter((x): x is LonLat[] => !!x);
    const inners = joinRings(pick('inner')).map(ringOf).filter((x): x is LonLat[] => !!x);
    r.members.forEach((m) => m.role !== 'inner' && usedAsOuter.add(m.ref));
    outers.forEach((outer) => buildings.push({ tags: r.tags, outer, inners: inners.filter((h) => pointInRing(h[0], outer)) }));
  }
  const trees: Context['trees'] = [];
  for (const w of ways.values()) {
    if (isBuilding(w.tags) && closed(w) && !(usedAsOuter.has(w.id) && !w.tags['building:part'])) {
      const outer = ringOf(w.nodes);
      if (outer) buildings.push({ tags: w.tags, outer, inners: [] });
    } else if (w.tags.natural === 'tree_row') {
      const line = ringOf(w.nodes);
      if (!line) continue;
      // One tree roughly every 9 m along the row.
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        const metres = Math.hypot((b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * 110540);
        const n = Math.max(1, Math.round(metres / 9));
        for (let k = i === 1 ? 0 : 1; k <= n; k++) {
          trees.push({ lon: a[0] + ((b[0] - a[0]) * k) / n, lat: a[1] + ((b[1] - a[1]) * k) / n, tags: w.tags });
        }
      }
    }
  }
  for (const n of nodes.values()) if (n.tags?.natural === 'tree') trees.push({ lon: n.lon, lat: n.lat, tags: n.tags });

  // Simple 3D Buildings: an outline that contains building parts is not drawn itself.
  const parts = buildings.filter((b) => b.tags['building:part'] !== undefined);
  const drawn = buildings.filter((b) => {
    if (b.tags['building:part'] !== undefined) return true;
    return !parts.some((p) => pointInRing(centroid(p.outer), b.outer));
  });
  return { buildings: drawn, trees };
}

function centroid(r: LonLat[]): LonLat {
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length];
}

export function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}${body ? ': ' + body.slice(0, 300) : ''}`);
  }
  return body;
}

/** Authoritative load straight from the OSM editing API (area ≤ 0.25 deg²). */
export async function loadFromApi(server: ServerConfig, b: BBox): Promise<OsmData> {
  const url = `${server.apiUrl}/api/0.6/map?bbox=${b.west},${b.south},${b.east},${b.north}`;
  return parseOsmXml(await fetchText(url));
}

/**
 * Load just the roads via Overpass (handles larger areas). Overpass can lag the
 * main database by a few minutes; a stale version shows up as a 409 conflict
 * on upload rather than silently overwriting someone's edit.
 */
export async function loadFromOverpass(b: BBox): Promise<OsmData> {
  const bb = `(${b.south},${b.west},${b.north},${b.east})`;
  const q = `[out:xml][timeout:90];(way["highway"]${bb};way["building"]${bb};way["building:part"]${bb};way["natural"="tree_row"]${bb};` +
    `node["natural"="tree"]${bb};relation["building"]${bb};relation["type"~"^(connectivity|restriction)$"]${bb};way["railway"]${bb};);(._;>>;);out meta;`;
  const text = await fetchText('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: q }),
  });
  return parseOsmXml(text);
}

export function tagsEqual(a: Tags, b: Tags): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] === a[k]);
}

export function isModified(w: OsmWay): boolean {
  return !tagsEqual(w.tags, w.origTags);
}

export interface TagDiff {
  key: string;
  before?: string;
  after?: string;
}

export function diffTags(before: Tags, after: Tags): TagDiff[] {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return keys
    .filter((k) => before[k] !== after[k])
    .map((k) => ({ key: k, before: before[k], after: after[k] }));
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');
}

function tagXml(tags: Tags, indent: string): string {
  return Object.keys(tags)
    .sort()
    .map((k) => `${indent}<tag k="${esc(k)}" v="${esc(tags[k])}"/>`)
    .join('\n');
}

const GENERATOR = 'OSM Lanes 3D';

export function isRelationModified(r: OsmRelation): boolean {
  if (!r.orig) return !r.deleted;
  if (r.deleted) return true;
  return !tagsEqual(r.tags, r.orig.tags) || JSON.stringify(r.members) !== JSON.stringify(r.orig.members);
}

/** osmChange document: modified ways (tags only) plus created / modified / deleted relations. */
export function buildOsmChange(ways: OsmWay[], changesetId: number | string, relations: OsmRelation[] = []): string {
  const wayXml = (w: OsmWay) => {
    const nds = w.nodes.map((n) => `      <nd ref="${n}"/>`).join('\n');
    return `    <way id="${w.id}" version="${w.version}" changeset="${changesetId}">\n${nds}\n${tagXml(w.tags, '      ')}\n    </way>`;
  };
  const relXml = (r: OsmRelation, body = true) => {
    const head = `    <relation id="${r.id}" version="${r.version}" changeset="${changesetId}"`;
    if (!body) return `${head}/>`;
    const ms = r.members.map((m) => `      <member type="${m.type}" ref="${m.ref}" role="${esc(m.role)}"/>`).join('\n');
    return `${head}>\n${ms}\n${tagXml(r.tags, '      ')}\n    </relation>`;
  };
  const created = relations.filter((r) => !r.orig && !r.deleted);
  const deleted = relations.filter((r) => r.orig && r.deleted);
  const modified = relations.filter((r) => r.orig && !r.deleted && isRelationModified(r));
  const block = (name: string, items: string[]) => (items.length ? `  <${name}>\n${items.join('\n')}\n  </${name}>\n` : '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<osmChange version="0.6" generator="${GENERATOR}">\n` +
    block('create', created.map((r) => relXml(r))) +
    block('modify', [...ways.map(wayXml), ...modified.map((r) => relXml(r))]) +
    block('delete', deleted.map((r) => relXml(r, false))) +
    `</osmChange>\n`;
}

export function buildChangesetXml(tags: Tags): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<osm>\n  <changeset>\n${tagXml(tags, '    ')}\n  </changeset>\n</osm>\n`;
}

/** Apply new ids / versions from a diffResult so further uploads don't conflict. */
export function applyDiffResult(xml: string, data: OsmData): void {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  doc.querySelectorAll('way').forEach((el) => {
    const id = Number(el.getAttribute('old_id'));
    const w = data.ways.get(id);
    const v = el.getAttribute('new_version');
    if (w && v) {
      w.version = Number(v);
      w.origTags = { ...w.tags };
    }
  });
  doc.querySelectorAll('relation').forEach((el) => {
    const oldId = Number(el.getAttribute('old_id'));
    const r = data.relations.get(oldId);
    if (!r) return;
    const newId = el.getAttribute('new_id');
    if (!newId) {
      data.relations.delete(oldId); // deleted
      return;
    }
    data.relations.delete(oldId);
    r.id = Number(newId);
    r.version = Number(el.getAttribute('new_version') ?? r.version);
    r.orig = { tags: { ...r.tags }, members: r.members.map((m) => ({ ...m })) };
    data.relations.set(r.id, r);
  });
}
