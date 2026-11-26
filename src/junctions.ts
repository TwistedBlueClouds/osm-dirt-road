// Junction geometry and lane connections.
//
// Geometry: where three or more road ends meet, each road is cut back to where its edges
// meet its neighbours' edges, and the gap is filled with a junction surface with rounded
// corners. Connections: which lanes each lane leads into, from `type=connectivity`
// relations where mapped, otherwise worked out from turn:lanes and the exits' angles.
//
// The feature set follows Lane Studio's junctions and connectivity (ISC, © Lane Studio
// contributors, https://github.com/MarcelMarzec/LaneStudio); the implementation here is
// independent and much simpler.

import { pointAt, polyLength, slice, type V2 } from './geom.ts';
import type { DrivingSide, LaneSlot } from './lanes';
import type { OsmRelation, OsmWay } from './osm';

/** A way prepared for drawing: geometry in drawing direction plus its lane layout. */
export interface WayGeo {
  way: OsmWay;
  /** Full centre line in drawing direction (reversed for oneway=-1). */
  pts: V2[];
  L: number;
  slots: LaneSlot[];
  reversed: boolean;
  /** Node ids at the start / end of `pts`. */
  startNode: number;
  endNode: number;
  /** Carriageway extent, drawing offsets. */
  left: number;
  right: number;
  /** How much is cut off at the start / end for junctions. */
  trim: [number, number];
  /** `pts` with the trims applied. */
  body: V2[];
  /** Arc length of each way node along `pts` (drawing order). */
  nodeS: number[];
}

export interface Arm {
  geo: WayGeo;
  /** Which end of the way sits on the node; 'through' = the node is inside the way. */
  end: 'start' | 'end';
  through: boolean;
  /** Unit vector pointing away from the node along the way. */
  dir: V2;
  angle: number;
  /** Half-widths to the left / right when looking away from the node. */
  wl: number;
  wr: number;
}

export interface Junction {
  node: number;
  centre: V2;
  arms: Arm[];
  /** Fan triangles (x, y, z) of the junction surface. */
  surface: number[];
}

const norm = (x: number, z: number): V2 => {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
};

function armOf(geo: WayGeo, end: 'start' | 'end', through = false, at?: number): Arm {
  // Direction from a point a few metres along, so a kink right at the node doesn't skew it.
  const reach = Math.min(8, geo.L / 2);
  const base = at ?? (end === 'start' ? 0 : geo.L);
  const a = pointAt(geo.pts, base).p;
  const b = pointAt(geo.pts, end === 'start' ? Math.min(geo.L, base + reach) : Math.max(0, base - reach)).p;
  const dir = norm(b.x - a.x, b.z - a.z);
  // Looking away from the node: at the start that is the drawing direction, at the end the opposite.
  const wl = end === 'start' ? -geo.left : geo.right;
  const wr = end === 'start' ? geo.right : -geo.left;
  return { geo, end, through, dir, angle: Math.atan2(dir.z, dir.x), wl, wr };
}

/** Every node where ways meet, with the arms around it sorted clockwise (seen from above). */
export function findArms(geos: Iterable<WayGeo>): Map<number, Arm[]> {
  const out = new Map<number, Arm[]>();
  const add = (n: number, a: Arm) => (out.get(n) ?? out.set(n, []).get(n)!).push(a);
  for (const g of geos) {
    if (g.pts.length < 2 || g.L < 0.5) continue;
    add(g.startNode, armOf(g, 'start'));
    add(g.endNode, armOf(g, 'end'));
    // Interior nodes: the way passes through, contributing two untrimmed arms.
    const ids = g.reversed ? g.way.nodes.slice().reverse() : g.way.nodes;
    if (ids.length > 2) {
      for (let i = 1; i < ids.length - 1; i++) {
        add(ids[i], armOf(g, 'start', true, g.nodeS[i]));
        add(ids[i], armOf(g, 'end', true, g.nodeS[i]));
      }
    }
  }
  for (const arms of out.values()) arms.sort((a, b) => a.angle - b.angle);
  return out;
}

const MIN_TRIM = 0.6;
const MAX_TRIM = 28;

/** Where arm A's right edge meets the next arm B's left edge: distances along each arm. */
function edgeMeet(a: Arm, b: Arm): { t: number; u: number } | null {
  // A right edge: n_a * wr + t * d_a ; B left edge: -n_b * wl + u * d_b ; n = (-d.z, d.x)
  const ax = -a.dir.z * a.wr, az = a.dir.x * a.wr;
  const bx = b.dir.z * b.wl, bz = -b.dir.x * b.wl;
  const det = a.dir.x * -b.dir.z + b.dir.x * a.dir.z;
  if (Math.abs(det) < 0.12) return null; // nearly parallel: straight on, or a very sharp fork
  const rx = bx - ax, rz = bz - az;
  const t = (rx * -b.dir.z + b.dir.x * rz) / det;
  const u = (a.dir.x * rz - a.dir.z * rx) / det;
  return { t, u };
}

/**
 * Compute trims for every way end and the junction surfaces. Mutates `trim` and `body`
 * on the geos.
 */
export function solveJunctions(geos: Map<number, WayGeo>, nodeH: Map<number, number>): { junctions: Junction[]; armsAt: Map<number, Arm[]> } {
  for (const g of geos.values()) g.trim = [0, 0];
  const armsAt = findArms(geos.values());
  const junctions: Junction[] = [];
  const cuts = new Map<Arm, number>();

  for (const [node, arms] of armsAt) {
    if (arms.length < 3) continue;
    const n = arms.length;
    const need = arms.map(() => MIN_TRIM);
    const meets: ({ t: number; u: number } | null)[] = [];
    for (let i = 0; i < n; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % n];
      const m = a.geo === b.geo && a.through ? null : edgeMeet(a, b);
      meets.push(m);
      if (m) {
        if (m.t > 0) need[i] = Math.max(need[i], m.t);
        if (m.u > 0) need[(i + 1) % n] = Math.max(need[(i + 1) % n], m.u);
      }
    }
    arms.forEach((a, i) => {
      const cap = Math.min(MAX_TRIM, a.geo.L * 0.45);
      const cut = a.through ? 0 : Math.min(need[i], cap);
      cuts.set(a, cut);
      if (!a.through) a.geo.trim[a.end === 'start' ? 0 : 1] = cut;
    });

    // Surface: walk the arms clockwise; each contributes its two end corners, and the
    // gap to the next arm is bridged by a curve through where the edges would meet.
    const g0 = arms[0].geo;
    const centre = pointAt(g0.pts, arms[0].through ? g0.nodeS[nodeIndex(g0, node)] ?? 0 : arms[0].end === 'start' ? 0 : g0.L).p;
    const h = nodeH.get(node) ?? 0;
    const ring: V2[] = [];
    const corner = (a: Arm, side: 'l' | 'r'): V2 => {
      const c = cuts.get(a) ?? 0;
      const w = side === 'r' ? a.wr : -a.wl;
      return { x: centre.x + a.dir.x * c - a.dir.z * w, z: centre.z + a.dir.z * c + a.dir.x * w };
    };
    for (let i = 0; i < n; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % n];
      const p0 = corner(a, 'r');
      const p1 = corner(b, 'l');
      ring.push(corner(a, 'l'), p0);
      const m = meets[i];
      if (m && m.t > -2 && m.u > -2 && m.t < MAX_TRIM * 1.5 && m.u < MAX_TRIM * 1.5) {
        const x = { x: centre.x - a.dir.z * a.wr + a.dir.x * m.t, z: centre.z + a.dir.x * a.wr + a.dir.z * m.t };
        for (let k = 1; k < 6; k++) {
          const t = k / 6;
          ring.push({
            x: (1 - t) * (1 - t) * p0.x + 2 * t * (1 - t) * x.x + t * t * p1.x,
            z: (1 - t) * (1 - t) * p0.z + 2 * t * (1 - t) * x.z + t * t * p1.z,
          });
        }
      }
    }
    const surface: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      surface.push(centre.x, h, centre.z, p.x, h, p.z, q.x, h, q.z);
    }
    junctions.push({ node, centre: { ...centre, h }, arms, surface });
  }

  for (const g of geos.values()) {
    // Never let the two trims swallow the whole way.
    const sum = g.trim[0] + g.trim[1];
    if (sum > g.L * 0.9) {
      const k = (g.L * 0.9) / sum;
      g.trim = [g.trim[0] * k, g.trim[1] * k];
    }
    g.body = g.trim[0] > 0 || g.trim[1] > 0 ? slice(g.pts, g.trim[0], g.L - g.trim[1]) : g.pts;
    if (g.body.length < 2) g.body = g.pts;
  }
  return { junctions, armsAt };
}

function nodeIndex(g: WayGeo, node: number): number {
  const ids = g.reversed ? g.way.nodes.slice().reverse() : g.way.nodes;
  return ids.indexOf(node);
}

// ---------------------------------------------------------------------------
// Lane connections

/** A lane identified the way OSM counts it. */
export interface LaneId {
  wayId: number;
  /** Direction in drawing terms (see WayGeo.reversed). */
  dir: 'forward' | 'backward';
  /** Index among that direction's lanes, left → right in travel direction. */
  index: number;
}

export interface Connection {
  from: LaneId;
  to: LaneId;
  via: number;
  source: 'relation' | 'turn' | 'default';
  /** What kind of movement this is, for colouring and guide lines. */
  move: 'through' | 'left' | 'right' | 'reverse';
  relationId?: number;
}

/** Signed turn angle in degrees from heading `a` to heading `b`; positive = to the right. */
function turnAngle(a: V2, b: V2): number {
  const d = (Math.atan2(b.z, b.x) - Math.atan2(a.z, a.x)) * 180 / Math.PI;
  return ((d + 540) % 360) - 180;
}

const TURN_TARGET: Record<string, number> = {
  through: 0, slight_left: -40, left: -90, sharp_left: -135, slight_right: 40, right: 90, sharp_right: 135, reverse: 180,
};

/** Lanes of a way travelling in a drawing direction, left → right in travel direction. */
export function travelLanes(g: WayGeo, dir: 'forward' | 'backward'): LaneSlot[] {
  return g.slots.filter((s) => s.dir === dir).sort((a, b) => a.index - b.index);
}

interface Exit {
  arm: Arm;
  /** Drawing direction of the lanes leaving the node on this arm. */
  dir: 'forward' | 'backward';
  lanes: LaneSlot[];
  phi: number;
}

function parseConnectivity(v: string | undefined): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const part of (v ?? '').split('|')) {
    const [from, to] = part.split(':');
    const f = parseInt(from, 10);
    if (!Number.isFinite(f) || !to) continue;
    const list = to.split(',').map((s) => parseInt(s.replace(/[()]/g, ''), 10)).filter(Number.isFinite);
    if (list.length) out.set(f, list);
  }
  return out;
}

export function formatConnectivity(m: Map<number, number[]>): string {
  return Array.from(m.entries())
    .filter(([, to]) => to.length)
    .sort((a, b) => a[0] - b[0])
    .map(([f, to]) => `${f}:${Array.from(new Set(to)).sort((a, b) => a - b).join(',')}`)
    .join('|');
}

/** The connectivity relation for a from → via → to movement, if one is mapped. */
export function findConnectivityRelation(relations: Iterable<OsmRelation>, from: number, via: number, to: number): OsmRelation | undefined {
  for (const r of relations) {
    if (r.tags.type !== 'connectivity' || r.deleted) continue;
    const has = (role: string, type: string, ref: number) => r.members.some((m) => m.role === role && m.type === type && m.ref === ref);
    if (has('from', 'way', from) && has('via', 'node', via) && has('to', 'way', to)) return r;
  }
  return undefined;
}

/**
 * Connections out of every lane of `geo` that arrives at one of its end nodes.
 * `armsAt` comes from findArms.
 */
export function connectionsFrom(
  geo: WayGeo, armsAt: Map<number, Arm[]>, relations: Iterable<OsmRelation>, side: DrivingSide,
): Connection[] {
  const out: Connection[] = [];
  const rels = Array.from(relations).filter((r) => r.tags.type === 'connectivity' && !r.deleted);
  for (const end of ['end', 'start'] as const) {
    // Lanes travelling toward this end.
    const dir = end === 'end' ? 'forward' : 'backward';
    const lanes = travelLanes(geo, dir);
    if (!lanes.length) continue;
    const node = end === 'end' ? geo.endNode : geo.startNode;
    const arms = armsAt.get(node) ?? [];
    const self = arms.find((a) => a.geo === geo && a.end === end && !a.through);
    if (!self) continue;
    const heading = { x: -self.dir.x, z: -self.dir.z };
    const exits: Exit[] = [];
    for (const arm of arms) {
      const isSelf = arm === self;
      // Leaving the node along `arm`: at a start end that is the drawing direction.
      const outDir = arm.end === 'start' ? 'forward' : 'backward';
      const ls = travelLanes(arm.geo, outDir);
      if (!ls.length) continue;
      exits.push({ arm, dir: outDir, lanes: ls, phi: isSelf ? 180 : turnAngle(heading, arm.dir) });
    }
    if (!exits.length) continue;
    const others = exits.filter((e) => e.arm !== self);
    const hasTurnTags = lanes.some((l) => l.lane.turn && l.lane.turn !== 'none');
    const through = others.filter((e) => Math.abs(e.phi) < 60).sort((a, b) => Math.abs(a.phi) - Math.abs(b.phi))[0];

    // exit → source lanes that use it (and why)
    const uses = new Map<Exit, { lane: LaneSlot; source: Connection['source'] }[]>();
    const use = (e: Exit | undefined, lane: LaneSlot, source: Connection['source']) => {
      if (!e) return;
      const list = uses.get(e) ?? uses.set(e, []).get(e)!;
      if (!list.some((x) => x.lane === lane)) list.push({ lane, source });
    };
    const pickFor = (t: string): Exit | undefined => {
      const target = TURN_TARGET[t];
      if (target === undefined) return undefined;
      if (t === 'reverse') return exits.find((e) => e.arm === self) ?? others.filter((e) => Math.abs(e.phi) > 150)[0];
      const ok = others.filter((e) => (t === 'through' ? Math.abs(e.phi) < 60 : t.endsWith('left') ? e.phi < -12 : e.phi > 12));
      return ok.sort((a, b) => Math.abs(a.phi - target) - Math.abs(b.phi - target))[0];
    };
    lanes.forEach((lane, i) => {
      const turns = (lane.lane.turn || '').split(';').map((s) => s.trim()).filter((s) => s && s !== 'none');
      if (hasTurnTags) {
        const real = turns.filter((t) => t in TURN_TARGET);
        if (!real.length) use(through ?? (others.length === 1 ? others[0] : undefined), lane, 'turn');
        for (const t of real) use(pickFor(t), lane, 'turn');
      } else {
        // No arrows mapped: everyone may go straight on; the outer lanes may also turn.
        use(through, lane, 'default');
        if (i === 0 || !through) for (const e of others) if (e.phi <= -12 && e !== through) use(e, lane, 'default');
        if (i === lanes.length - 1 || !through) for (const e of others) if (e.phi >= 12 && e !== through) use(e, lane, 'default');
        if (others.length === 1) use(others[0], lane, 'default');
      }
    });

    for (const e of exits) {
      const move: Connection['move'] = e.arm === self || Math.abs(e.phi) > 150 ? 'reverse' : Math.abs(e.phi) < 30 ? 'through' : e.phi < 0 ? 'left' : 'right';
      const rel = e.arm.through ? undefined : rels.find((r) => findConnectivityRelation([r], geo.way.id, node, e.arm.geo.way.id));
      const nT = e.lanes.length;
      const push = (fromLane: LaneSlot, toIdx: number, source: Connection['source'], relationId?: number) => {
        if (toIdx < 0 || toIdx >= nT) return;
        out.push({
          from: { wayId: geo.way.id, dir, index: fromLane.index },
          to: { wayId: e.arm.geo.way.id, dir: e.dir, index: e.lanes[toIdx].index },
          via: node, source, move, relationId,
        });
      };
      if (rel) {
        for (const [f, tos] of parseConnectivity(rel.tags.connectivity)) {
          const lane = lanes[f - 1];
          if (lane) for (const t of tos) push(lane, t - 1, 'relation', rel.id);
        }
        continue;
      }
      const src = (uses.get(e) ?? []).sort((a, b) => a.lane.index - b.lane.index);
      const k = src.length;
      if (!k) continue;
      // Which side to line the lanes up on when the exit has more lanes than arrive.
      let shift = 0;
      if (k < nT) {
        if (move === 'right' || (move === 'reverse' && side === 'left')) shift = nT - k;
        else if (move === 'through') {
          const droppedLeft = src[0].lane.index > 0;
          const droppedRight = src[k - 1].lane.index < lanes.length - 1;
          shift = droppedLeft && !droppedRight ? nT - k : !droppedLeft && droppedRight ? 0 : side === 'right' ? nT - k : 0;
        }
      }
      src.forEach((s, j) => push(s.lane, Math.min(j + shift, nT - 1), s.source));
    }
  }
  return out;
}

/** Centre-line points of a guide curve from one lane's end to another lane's start. */
export function connectionCurve(c: Connection, geos: Map<number, WayGeo>): V2[] | null {
  const a = geos.get(c.from.wayId);
  const b = geos.get(c.to.wayId);
  if (!a || !b) return null;
  const sa = a.slots.find((s) => s.dir === c.from.dir && s.index === c.from.index);
  const sb = b.slots.find((s) => s.dir === c.to.dir && s.index === c.to.index);
  if (!sa || !sb) return null;
  const endOf = (g: WayGeo, slot: LaneSlot, dir: 'forward' | 'backward', leaving: boolean, node: number): { p: V2; t: V2 } => {
    // Arriving lanes end at the body end in their travel direction; leaving lanes start
    // at the body end nearest the node (or at the node itself on a through way).
    const body = g.body;
    const L = polyLength(body);
    let at: number;
    if (node === g.startNode) at = 0;
    else if (node === g.endNode) at = L;
    else at = Math.min(Math.max((g.nodeS[nodeIndex(g, node)] ?? 0) - g.trim[0], 0), L);
    if (leaving && node !== g.startNode && node !== g.endNode) at = Math.min(Math.max(at + (dir === 'forward' ? 6 : -6), 0), L);
    const { p, dir: d } = pointAt(body, at);
    const mid = (slot.left + slot.right) / 2;
    const travel = dir === 'forward' ? d : { x: -d.x, z: -d.z };
    return { p: { x: p.x - d.z * mid, z: p.z + d.x * mid, h: p.h }, t: travel };
  };
  const s = endOf(a, sa, c.from.dir, false, c.via);
  const e = endOf(b, sb, c.to.dir, true, c.via);
  const dist = Math.hypot(e.p.x - s.p.x, e.p.z - s.p.z);
  const k = Math.max(dist * 0.4, 1.5);
  const c1 = { x: s.p.x + s.t.x * k, z: s.p.z + s.t.z * k };
  const c2 = { x: e.p.x - e.t.x * k, z: e.p.z - e.t.z * k };
  const out: V2[] = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const m = 1 - t;
    out.push({
      x: m * m * m * s.p.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * e.p.x,
      z: m * m * m * s.p.z + 3 * m * m * t * c1.z + 3 * m * t * t * c2.z + t * t * t * e.p.z,
      h: (s.p.h ?? 0) * m + (e.p.h ?? 0) * t,
    });
  }
  return out;
}
