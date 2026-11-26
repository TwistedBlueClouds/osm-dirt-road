// OSM data model, loading (API 0.6 / Overpass), and osmChange generation.

export type Tags = Record<string, string>;

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  version: number;
}

export interface OsmWay {
  id: number;
  version: number;
  nodes: number[];
  tags: Tags;
  /** Tags as loaded from the server; used to detect modifications. */
  origTags: Tags;
}

export interface OsmData {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
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
  doc.querySelectorAll('node').forEach((n) => {
    const id = Number(n.getAttribute('id'));
    nodes.set(id, {
      id,
      lat: Number(n.getAttribute('lat')),
      lon: Number(n.getAttribute('lon')),
      version: Number(n.getAttribute('version') ?? 0),
    });
  });
  doc.querySelectorAll('way').forEach((w) => {
    const tags: Tags = {};
    w.querySelectorAll('tag').forEach((t) => {
      tags[t.getAttribute('k')!] = t.getAttribute('v') ?? '';
    });
    const id = Number(w.getAttribute('id'));
    ways.set(id, {
      id,
      version: Number(w.getAttribute('version') ?? 0),
      nodes: Array.from(w.querySelectorAll('nd')).map((nd) => Number(nd.getAttribute('ref'))),
      tags,
      origTags: { ...tags },
    });
  });
  return { nodes, ways };
}

/** Keep only road ways whose nodes are all present. */
export function filterRoads(data: OsmData): OsmData {
  const ways = new Map<number, OsmWay>();
  for (const w of data.ways.values()) {
    if (!w.tags.highway || !ROAD_HIGHWAYS.has(w.tags.highway)) continue;
    if (w.tags.area === 'yes') continue;
    if (!w.nodes.every((id) => data.nodes.has(id))) continue;
    ways.set(w.id, w);
  }
  return { nodes: data.nodes, ways };
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
  return filterRoads(parseOsmXml(await fetchText(url)));
}

/**
 * Load just the roads via Overpass (handles larger areas). Overpass can lag the
 * main database by a few minutes; a stale version shows up as a 409 conflict
 * on upload rather than silently overwriting someone's edit.
 */
export async function loadFromOverpass(b: BBox): Promise<OsmData> {
  const hw = Array.from(ROAD_HIGHWAYS).join('|');
  const q = `[out:xml][timeout:60];way["highway"~"^(${hw})$"](${b.south},${b.west},${b.north},${b.east});(._;>;);out meta;`;
  const text = await fetchText('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: q }),
  });
  return filterRoads(parseOsmXml(text));
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

/** osmChange document for all modified ways (tag-only edits). */
export function buildOsmChange(ways: OsmWay[], changesetId: number | string): string {
  const body = ways
    .map((w) => {
      const nds = w.nodes.map((n) => `      <nd ref="${n}"/>`).join('\n');
      return `    <way id="${w.id}" version="${w.version}" changeset="${changesetId}">\n${nds}\n${tagXml(w.tags, '      ')}\n    </way>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<osmChange version="0.6" generator="${GENERATOR}">\n  <modify>\n${body}\n  </modify>\n</osmChange>\n`;
}

export function buildChangesetXml(tags: Tags): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<osm>\n  <changeset>\n${tagXml(tags, '    ')}\n  </changeset>\n</osm>\n`;
}

/** Apply new versions from a diffResult so further uploads don't conflict. */
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
}
