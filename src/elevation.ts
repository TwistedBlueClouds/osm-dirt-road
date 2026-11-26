// Heights for bridges, ramps and other raised roads.
//
// OSM's `layer` is an ordering, not a height, and approach ramps are usually tagged as
// plain ground-level roads. So, following the idea described in osm-simple3d-editor's
// docs/3d-bridges-tunnels.md: nodes of raised ways get a height from their layer, and
// that height spreads out through the road network as a cone with a maximum grade, so
// the approaches climb to the bridge however they are split into ways.

import type { OsmData, Tags } from './osm';

/** Height of one `layer` step, metres. */
export const LEVEL_STEP_M = 6;
/** Maximum grade of an approach ramp. */
export const ROAD_GRADE = 0.07;

export function isBridge(t: Tags): boolean {
  return t.bridge !== undefined && t.bridge !== 'no';
}

export function isTunnel(t: Tags): boolean {
  return (t.tunnel !== undefined && t.tunnel !== 'no' && t.tunnel !== 'building_passage') || t.covered === 'yes';
}

/** Level above ground: bridges are at least 1, tunnels never raise anything. */
export function roadLevel(t: Tags): number {
  const layer = parseInt(t.layer ?? '0', 10) || 0;
  if (isTunnel(t)) return Math.min(layer, 0);
  if (isBridge(t)) return Math.max(layer, 1);
  return layer;
}

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((b.lon - a.lon) * 111320 * k, (b.lat - a.lat) * 110540);
}

/** Height above ground for every node that isn't on the ground. */
export function solveHeights(data: OsmData): Map<number, number> {
  const h = new Map<number, number>();
  const adj = new Map<number, { to: number; len: number }[]>();
  for (const w of data.ways.values()) {
    const level = roadLevel(w.tags);
    if (level > 0) for (const n of w.nodes) h.set(n, Math.max(h.get(n) ?? 0, level * LEVEL_STEP_M));
    if (isTunnel(w.tags)) continue; // ramps don't climb out of tunnels
    for (let i = 1; i < w.nodes.length; i++) {
      const a = w.nodes[i - 1];
      const b = w.nodes[i];
      const len = metres(data.nodes.get(a)!, data.nodes.get(b)!);
      (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, len });
      (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, len });
    }
  }
  if (!h.size) return h;
  // Spread from the highest node down (Dijkstra on descending height).
  const queue = Array.from(h, ([id, v]) => ({ id, v })).sort((a, b) => a.v - b.v);
  while (queue.length) {
    const { id, v } = queue.pop()!;
    if (v < (h.get(id) ?? 0)) continue;
    for (const e of adj.get(id) ?? []) {
      const nv = v - e.len * ROAD_GRADE;
      if (nv > 0.05 && nv > (h.get(e.to) ?? 0)) {
        h.set(e.to, nv);
        // Insert keeping the array sorted ascending (small queues; fine).
        let lo = 0, hi = queue.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (queue[mid].v < nv) lo = mid + 1;
          else hi = mid;
        }
        queue.splice(lo, 0, { id: e.to, v: nv });
      }
    }
  }
  return h;
}
