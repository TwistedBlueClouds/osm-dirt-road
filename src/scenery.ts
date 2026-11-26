// Scenery worked out from the download: railway tracks with trains and trams, boats on
// waterways, benches, and model houses for simple detached-house footprints. Everything
// here is decoration around the lanes; none of it is editable.

import { line, pointAt, polyLength, strip, type V2 } from './geom.ts';
import { BOATS, HOUSES, TRAINS, TRAMS, hash2, type ModelName, type Placement } from './models.ts';
import { isBridge, isTunnel, roadLevel, LEVEL_STEP_M } from './elevation.ts';
import type { Footprint, OsmData, OsmWay } from './osm';

type Project = (lat: number, lon: number) => { x: number; z: number };

const RAILWAYS = new Set(['rail', 'light_rail', 'subway', 'tram', 'narrow_gauge']);
const BALLAST = [0.43, 0.4, 0.37];
const SLEEPER = [0.3, 0.25, 0.21];
const RAIL = [0.62, 0.63, 0.66];
const GAUGE = 1.435;

function wayPoints(w: OsmWay, data: OsmData, project: Project, h = 0): V2[] | null {
  const out: V2[] = [];
  for (const id of w.nodes) {
    const n = data.nodes.get(id);
    if (!n) return null;
    out.push({ ...project(n.lat, n.lon), h });
  }
  return out.length >= 2 ? out : null;
}

export interface Rails {
  /** Triangles and per-vertex colours of ballast, sleepers and rails. */
  pos: number[];
  col: number[];
  /** Bridge decks under raised track. */
  structure: number[];
  trains: Placement[];
}

/**
 * Tracks for every railway way that isn't in a tunnel, and a train or tram on some of them.
 * `deck` builds the bridge structure under raised track (shared with road bridges).
 */
export function buildRails(
  data: OsmData, project: Project, native: Map<ModelName, { x: number; z: number }>,
  deck: (out: number[], pts: V2[], left: number, right: number) => void,
): Rails {
  const r: Rails = { pos: [], col: [], structure: [], trains: [] };
  const paint = (from: number, c: number[]) => {
    for (let i = from; i < r.pos.length; i += 3) r.col.push(c[0], c[1], c[2]);
  };
  for (const w of data.allWays.values()) {
    const kind = w.tags.railway;
    if (!kind || !RAILWAYS.has(kind) || isTunnel(w.tags)) continue;
    const h = isBridge(w.tags) ? Math.max(roadLevel(w.tags), 1) * LEVEL_STEP_M : 0;
    const pts = wayPoints(w, data, project, h);
    if (!pts) continue;
    const gauge = (parseFloat(w.tags.gauge ?? '') || GAUGE * 1000) / 1000;
    const tram = kind === 'tram';
    let from = r.pos.length;
    if (!tram) {
      // Tram track is usually set into the street; everything else sits on ballast.
      strip(r.pos, pts, -1.7, 1.7, 0.03);
      paint(from, BALLAST);
      from = r.pos.length;
      line(r.pos, pts, 0, 2.5, 0.05, [0.26, 0.42]);
      paint(from, SLEEPER);
      from = r.pos.length;
    }
    for (const side of [-1, 1]) line(r.pos, pts, (side * gauge) / 2, 0.09, tram ? 0.035 : 0.12);
    paint(from, RAIL);
    if (h > 0) deck(r.structure, pts, -2.1, 2.1);

    // Rolling stock: not on sidings, and only on some stretches.
    const L = polyLength(pts);
    if (w.tags.service || L < 45 || hash2(w.id, 3) > (tram ? 0.5 : 0.4)) continue;
    const set = tram ? [TRAMS[Math.floor(hash2(w.id, 7) * TRAMS.length)]] : TRAINS[kind === 'rail' ? 0 : 1];
    const units = tram ? 2 : Math.min(4, Math.max(2, Math.floor(L / 30)));
    let at = L * (0.25 + hash2(w.id, 11) * 0.3);
    for (let u = 0; u < units; u++) {
      const model = set[u === 0 ? 0 : u === units - 1 ? Math.min(2, set.length - 1) : Math.min(1, set.length - 1)];
      const n = native.get(model);
      const len = n ? (Math.max(n.x, n.z) / Math.min(n.x, n.z)) * 2.65 : 6;
      if (at + len > L - 2) break;
      const { p, dir } = pointAt(pts, at + len / 2);
      // The last unit faces backwards so both ends of the train have a cab.
      const flip = u === units - 1 && units > 1 ? Math.PI : 0;
      r.trains.push({ model, x: p.x, y: (p.h ?? 0) + (tram ? 0.05 : 0.2), z: p.z, heading: Math.atan2(dir.x, dir.z) + flip });
      at += len + 0.25;
    }
  }
  return r;
}

/** A few boats along rivers and canals. */
export function boatPlacements(data: OsmData, project: Project): Placement[] {
  const out: Placement[] = [];
  for (const w of data.allWays.values()) {
    if ((w.tags.waterway !== 'river' && w.tags.waterway !== 'canal') || isTunnel(w.tags)) continue;
    const pts = wayPoints(w, data, project);
    if (!pts) continue;
    const L = polyLength(pts);
    for (let at = 30, k = 0; at < L - 20; at += 80, k++) {
      const r = hash2(w.id + k, 5);
      if (r > 0.45) continue;
      const { p, dir } = pointAt(pts, at + r * 40);
      const off = (hash2(k, w.id) - 0.5) * 7;
      const back = hash2(w.id, k + 2) > 0.5 ? Math.PI : 0;
      out.push({
        model: BOATS[Math.floor(hash2(k + 1, w.id * 0.3) * BOATS.length)],
        x: p.x - dir.z * off, y: 0.05, z: p.z + dir.x * off,
        heading: Math.atan2(dir.x, dir.z) + back,
      });
    }
  }
  return out;
}

/** Direction (unit vector) from a point to the nearest of `targets`. */
function toNearest(p: { x: number; z: number }, targets: { x: number; z: number }[]): { x: number; z: number } {
  let best = Infinity, bx = 0, bz = 1;
  for (const q of targets) {
    const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (d < best && d > 0.01) { best = d; bx = q.x - p.x; bz = q.z - p.z; }
  }
  const l = Math.hypot(bx, bz) || 1;
  return { x: bx / l, z: bz / l };
}

/** Benches from amenity=bench nodes, facing their `direction` tag or the nearest road. */
export function benchPlacements(data: OsmData, project: Project, road: { x: number; z: number }[]): Placement[] {
  const out: Placement[] = [];
  for (const n of data.nodes.values()) {
    if (n.tags?.amenity !== 'bench') continue;
    const p = project(n.lat, n.lon);
    const deg = parseFloat(n.tags.direction ?? '');
    let face: { x: number; z: number };
    if (Number.isFinite(deg)) face = { x: Math.sin((deg * Math.PI) / 180), z: -Math.cos((deg * Math.PI) / 180) };
    else face = toNearest(p, road);
    out.push({ model: 'bench', x: p.x, y: 0, z: p.z, heading: Math.atan2(face.x, face.z) });
  }
  return out;
}

const HOUSE_TYPES = new Set(['house', 'detached', 'bungalow', 'semidetached_house', 'cabin']);

/**
 * Model houses for plain detached-house footprints. Only buildings the mapper has not
 * described in 3D (no height, roof or colour tags) and whose outline is close to a
 * rectangle are swapped; the model is stretched to the outline's bounding rectangle.
 * Returns the placements and the footprints they replace.
 */
export function housePlacements(
  buildings: Footprint[], project: Project, native: Map<ModelName, { x: number; y: number; z: number }>, road: { x: number; z: number }[],
): { placements: Placement[]; replaced: Set<Footprint> } {
  const placements: Placement[] = [];
  const replaced = new Set<Footprint>();
  for (const b of buildings) {
    const t = b.tags;
    if (!HOUSE_TYPES.has(t.building) || b.inners.length) continue;
    if (t.height || t['roof:shape'] || t['roof:height'] || t['building:colour'] || t['roof:colour'] || t['building:part']) continue;
    const levels = parseFloat(t['building:levels'] ?? '');
    if (levels > 3) continue;
    const pts = b.outer.slice(0, -1).map(([lon, lat]) => project(lat, lon));
    if (pts.length < 4 || pts.length > 10) continue;
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
    area = Math.abs(area) / 2;
    if (area < 35 || area > 420) continue;
    // Smallest bounding rectangle among those aligned with an edge.
    let best: { theta: number; w: number; d: number; cx: number; cz: number } | null = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const theta = Math.atan2(c.z - a.z, c.x - a.x);
      const cos = Math.cos(theta), sin = Math.sin(theta);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of pts) {
        const u = p.x * cos + p.z * sin, v = -p.x * sin + p.z * cos;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const w = u1 - u0, d = v1 - v0;
      if (!best || w * d < best.w * best.d) {
        const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
        best = { theta, w, d, cx: mu * cos - mv * sin, cz: mu * sin + mv * cos };
      }
    }
    if (!best || area / (best.w * best.d) < 0.8 || Math.min(best.w, best.d) < 4.5) continue;

    // Pick a model with similar proportions.
    const aspect = Math.max(best.w, best.d) / Math.min(best.w, best.d);
    const ranked = HOUSES.filter((m) => native.has(m))
      .map((m) => ({ m, n: native.get(m)! }))
      .sort((p, q) => Math.abs(Math.max(p.n.x, p.n.z) / Math.min(p.n.x, p.n.z) - aspect) - Math.abs(Math.max(q.n.x, q.n.z) / Math.min(q.n.x, q.n.z) - aspect));
    if (!ranked.length) continue;
    const pick = ranked[Math.floor(hash2(best.cx, best.cz) * Math.min(4, ranked.length))];
    // Turn the model so its long side lies along the outline's long side.
    const quarter = (pick.n.x >= pick.n.z) === (best.w >= best.d) ? 0 : Math.PI / 2;
    let heading = -best.theta + quarter;
    const box: [number, number, number] = quarter ? [best.d, 0, best.w] : [best.w, 0, best.d];
    const scale = Math.sqrt((box[0] * box[2]) / (pick.n.x * pick.n.z));
    box[1] = Number.isFinite(levels) && levels > 0 ? levels * 3 + 2.2 : Math.min(Math.max(pick.n.y * scale, 4.5), 9.5);
    // Front door toward the street.
    const face = toNearest({ x: best.cx, z: best.cz }, road);
    if (Math.sin(heading) * face.x + Math.cos(heading) * face.z < 0) heading += Math.PI;
    placements.push({ model: pick.m, x: best.cx, y: 0, z: best.cz, heading, box });
    replaced.add(b);
  }
  return { placements, replaced };
}
