// Moving traffic, for looks only: cars follow each lane and its connections through
// junctions, drive at the speed limit, slow for turns, queue behind one another, take
// turns at junctions and stop at traffic signals. Nothing here reads or writes OSM data
// beyond the lane layout, and it is not a traffic model you could measure anything with.

import { offsetLine, polyLength, slice, type V2 } from './geom.ts';
import { connectionCurve, travelLanes, type Arm, type Connection, type WayGeo } from './junctions.ts';
import { laneKind } from './lanes.ts';
import { parseSpeed } from './speed.ts';

/** Speed assumed where no limit is tagged, km/h. */
const DEFAULT_KMH: Record<string, number> = {
  motorway: 110, motorway_link: 60, trunk: 90, trunk_link: 50, primary: 50, primary_link: 40,
  secondary: 50, secondary_link: 40, tertiary: 50, tertiary_link: 40, unclassified: 40,
  residential: 30, living_street: 10, service: 15, busway: 40, road: 40,
};
const TURN_MS = 6.5; // through a left or right turn
const ACCEL = 2.2;
const BRAKE = 4.5;
const MIN_GAP = 2.2;
const CYCLE_S = 44;
const INSIDE_JUNCTION_M = 28;

export interface Segment {
  id: number;
  kind: 'lane' | 'link';
  pts: V2[];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
  /** Free-flow speed, m/s. */
  speed: number;
  next: number[];
  /** Relative likelihood of each entry of `next`. */
  weight: number[];
  incoming: number;
  /** For a link that joins a road part-way along: where, and which stretch leads up to it. */
  merge?: { at: number; prev: number };
  cars: Car[];
  /** Junction node: for a link, the one it crosses; for a lane, the one it runs into. */
  junction?: number;
  /** Which of the two crossing flows this approach belongs to (by compass heading). */
  group: 0 | 1;
  /** Lane ends at traffic signals. */
  signal: boolean;
  /** Signals where no other road joins (a pedestrian crossing): mostly green. */
  crossingOnly: boolean;
  /** Signal timing offset, shared by everything within the same large junction. */
  phase: number;
  taxiOnly: boolean;
}

export interface Car {
  seg: number;
  s: number;
  v: number;
  /** Index into the list of vehicle kinds the caller passed. */
  kind: number;
  len: number;
  /** Personal speed factor around 1. */
  factor: number;
  next: number;
  /** Seconds spent standing still. */
  wait: number;
  /** Metres left before this vehicle ends its trip and leaves the map. */
  trip: number;
  x: number;
  y: number;
  z: number;
  heading: number;
}

interface JunctionState {
  count: number;
  group: 0 | 1;
  since: number;
  wantSwitch: boolean;
}

export interface VehicleKind {
  length: number;
  /** Relative share among ordinary traffic; 0 for kinds only used on taxi lanes. */
  weight: number;
  taxi?: boolean;
}

/** Small deterministic generator, so a given map always gets the same traffic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function laneSpeedMs(geo: WayGeo, laneMax: string | undefined): number {
  const s = parseSpeed(laneMax) ?? parseSpeed(geo.way.tags.maxspeed);
  const kmh = s ? s.kmh : DEFAULT_KMH[geo.way.tags.highway] ?? 40;
  return Math.min(Math.max(kmh, 5), 130) / 3.6;
}

export class TrafficSim {
  segs: Segment[] = [];
  cars: Car[] = [];
  time = 0;
  private junctions = new Map<number, JunctionState>();
  private random = rng(12345);
  private kinds: VehicleKind[] = [];
  private laneLength = 0;
  private want = 0;

  /**
   * Build the lane graph. `signalled(geo, end)` says whether the lanes arriving at that
   * end of the way are controlled by traffic signals.
   */
  build(
    geos: Map<number, WayGeo>, connectionsOf: (wayId: number) => Connection[],
    signalled: (geo: WayGeo, end: 'start' | 'end') => boolean, kinds: VehicleKind[], armsAt: Map<number, Arm[]> = new Map(),
  ) {
    this.segs = [];
    this.cars = [];
    this.junctions.clear();
    this.kinds = kinds;
    this.laneLength = 0;
    const key = (wayId: number, dir: string, index: number) => `${wayId}|${dir}|${index}`;
    /** Each lane as a chain of stretches, cut at every junction along the road. */
    const laneOf = new Map<string, { subs: number[]; startNode: (number | undefined)[] }>();
    const add = (s: Omit<Segment, 'id' | 'cum' | 'length' | 'next' | 'weight' | 'incoming' | 'cars'>): Segment => {
      const cum = [0];
      for (let i = 1; i < s.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].z - s.pts[i - 1].z));
      const seg: Segment = { ...s, id: this.segs.length, cum, length: cum[cum.length - 1], next: [], weight: [], incoming: 0, cars: [] };
      this.segs.push(seg);
      return seg;
    };
    const join = (from: Segment, to: Segment, weight: number) => {
      from.next.push(to.id);
      from.weight.push(weight);
      to.incoming++;
    };
    const headingOf = (p: V2[]) => {
      const a = p[p.length - 2];
      const b = p[p.length - 1];
      return Math.atan2(b.z - a.z, b.x - a.x);
    };
    const phaseAt = (p: V2) => (Math.abs(Math.round(p.x / 90) * 7 + Math.round(p.z / 90) * 13) % 11) * (CYCLE_S / 11);
    /** Turn-offs part-way along a road, added once every lane exists. */
    const turnOffs: { from: number; node: number; geo: WayGeo; heading: number; first: boolean; last: boolean }[] = [];

    for (const g of geos.values()) {
      const hw = g.way.tags.highway;
      const bodyLen = polyLength(g.body);
      if (hw === 'track' || g.body.length < 2 || bodyLen < 1) continue;
      const ids = g.reversed ? g.way.nodes.slice().reverse() : g.way.nodes;
      for (const dir of ['forward', 'backward'] as const) {
        const lanes = travelLanes(g, dir);
        if (!lanes.length) continue;
        const travel = dir === 'forward' ? g.body : g.body.slice().reverse();
        const sign = dir === 'forward' ? 1 : -1;
        const end = dir === 'forward' ? 'end' : 'start';
        // Where other roads join along the way, as distances in the travel direction.
        const cuts: { s: number; node: number }[] = [];
        for (let i = 1; i < ids.length - 1; i++) {
          if ((armsAt.get(ids[i])?.length ?? 0) < 3) continue;
          const along = g.nodeS[i] - g.trim[0];
          const sT = dir === 'forward' ? along : bodyLen - along;
          if (sT > 5 && sT < bodyLen - 5 && !cuts.some((c) => Math.abs(c.s - sT) < 5)) cuts.push({ s: sT, node: ids[i] });
        }
        cuts.sort((a, b) => a.s - b.s);
        const usable = lanes.filter((slot) => ['general', 'hov', 'taxi'].includes(laneKind(slot.lane, hw)));
        for (const slot of usable) {
          const lateral = ((slot.left + slot.right) / 2) * sign;
          const speed = laneSpeedMs(g, slot.lane.maxspeed);
          const taxiOnly = laneKind(slot.lane, hw) === 'taxi';
          const entry = { subs: [] as number[], startNode: [] as (number | undefined)[] };
          const bounds = [0, ...cuts.map((c) => c.s), bodyLen];
          let prev: Segment | null = null;
          for (let k = 0; k < bounds.length - 1; k++) {
            const centre = slice(travel, bounds[k], bounds[k + 1]);
            if (centre.length < 2) continue;
            const pts = offsetLine(centre, lateral);
            const heading = headingOf(pts);
            const lastStretch = k === bounds.length - 2;
            const seg = add({
              kind: 'lane', pts, speed, taxiOnly, crossingOnly: false,
              junction: lastStretch ? (dir === 'forward' ? g.endNode : g.startNode) : cuts[k].node,
              group: Math.abs(Math.cos(heading)) > Math.SQRT1_2 ? 0 : 1,
              signal: lastStretch && signalled(g, end),
              // Carriageways of one big junction are separate nodes a few metres apart: time them together.
              phase: phaseAt(pts[pts.length - 1]),
            });
            entry.subs.push(seg.id);
            entry.startNode.push(k === 0 ? undefined : cuts[k - 1].node);
            this.laneLength += seg.length;
            if (prev) join(prev, seg, 4); // carrying straight on is the usual choice
            if (!lastStretch) {
              turnOffs.push({ from: seg.id, node: cuts[k].node, geo: g, heading, first: slot === usable[0], last: slot === usable[usable.length - 1] });
            }
            prev = seg;
          }
          if (entry.subs.length) laneOf.set(key(g.way.id, dir, slot.index), entry);
        }
      }
    }

    // Links through junctions at the ends of roads. A junction needs turn-taking when more
    // than one road feeds it.
    const feeders = new Map<number, Set<number>>();
    const feed = (node: number, wayId: number) => (feeders.get(node) ?? feeders.set(node, new Set()).get(node)!).add(wayId);
    const links: { c: Connection; from: number; to: number; merge?: { at: number; prev: number } }[] = [];
    for (const g of geos.values()) {
      const cs = connectionsOf(g.way.id);
      const hasOther = new Set(cs.filter((c) => c.move !== 'reverse').map((c) => key(c.from.wayId, c.from.dir, c.from.index)));
      for (const c of cs) {
        const from = laneOf.get(key(c.from.wayId, c.from.dir, c.from.index));
        const to = laneOf.get(key(c.to.wayId, c.to.dir, c.to.index));
        if (!from || !to) continue;
        // U-turns only where a lane has nowhere else to go.
        if (c.move === 'reverse' && hasOther.has(key(c.from.wayId, c.from.dir, c.from.index))) continue;
        // Joining part-way along a road lands on the stretch that starts at that junction.
        const j = to.startNode.indexOf(c.via);
        links.push({
          c, from: from.subs[from.subs.length - 1], to: to.subs[Math.max(j, 0)],
          merge: j > 0 ? { at: Math.min(6, this.segs[to.subs[j]].length - 1), prev: to.subs[j - 1] } : undefined,
        });
        feed(c.via, c.from.wayId);
      }
    }
    for (const t of turnOffs) feed(t.node, t.geo.way.id);
    for (const seg of this.segs) {
      // A short lane between the carriageways of a big junction is inside the junction:
      // cars on it must clear, not wait at a second signal.
      if (seg.kind === 'lane' && seg.length < INSIDE_JUNCTION_M) seg.signal = false;
      if (seg.kind === 'lane' && seg.signal) seg.crossingOnly = (feeders.get(seg.junction!)?.size ?? 0) <= 1;
    }
    const turning = (node: number) => ((feeders.get(node)?.size ?? 0) > 1 ? node : undefined);
    for (const { c, from, to, merge } of links) {
      const curve = connectionCurve(c, geos);
      if (!curve || curve.length < 2) continue;
      const f = this.segs[from];
      const t = this.segs[to];
      const through = c.move === 'through';
      const link = add({
        kind: 'link', pts: curve, speed: Math.min(f.speed, t.speed, through ? Infinity : TURN_MS),
        junction: turning(c.via), group: f.group, signal: false, crossingOnly: false, taxiOnly: false, phase: f.phase, merge,
      });
      join(link, t, 1);
      join(f, link, through ? 3 : 1);
    }

    // Turning off part-way along a road: the outer lanes may turn into roads that start there.
    for (const t of turnOffs) {
      const f = this.segs[t.from];
      const p0 = f.pts[f.pts.length - 1];
      const d0 = { x: Math.cos(t.heading), z: Math.sin(t.heading) };
      for (const arm of armsAt.get(t.node) ?? []) {
        if (arm.through || arm.geo === t.geo) continue;
        const outDir = arm.end === 'start' ? 'forward' : 'backward';
        const targets = travelLanes(arm.geo, outDir).map((sl) => laneOf.get(key(arm.geo.way.id, outDir, sl.index))).filter((x): x is NonNullable<typeof x> => !!x);
        if (!targets.length) continue;
        let phi = ((Math.atan2(arm.dir.z, arm.dir.x) - t.heading) * 180) / Math.PI;
        phi = ((phi + 540) % 360) - 180; // + is a right turn
        if (Math.abs(phi) < 12 || Math.abs(phi) > 160) continue;
        const right = phi > 0;
        if (right ? !t.last : !t.first) continue;
        const target = this.segs[(right ? targets[targets.length - 1] : targets[0]).subs[0]];
        const p3 = target.pts[0];
        const d3 = { x: target.pts[1].x - p3.x, z: target.pts[1].z - p3.z };
        const l3 = Math.hypot(d3.x, d3.z) || 1;
        const k = Math.max(Math.hypot(p3.x - p0.x, p3.z - p0.z) * 0.4, 1.5);
        const curve: V2[] = [];
        for (let i = 0; i <= 10; i++) {
          const u = i / 10, m = 1 - u;
          const c1 = { x: p0.x + d0.x * k, z: p0.z + d0.z * k };
          const c2 = { x: p3.x - (d3.x / l3) * k, z: p3.z - (d3.z / l3) * k };
          curve.push({
            x: m * m * m * p0.x + 3 * m * m * u * c1.x + 3 * m * u * u * c2.x + u * u * u * p3.x,
            z: m * m * m * p0.z + 3 * m * m * u * c1.z + 3 * m * u * u * c2.z + u * u * u * p3.z,
            h: (p0.h ?? 0) * m + (p3.h ?? 0) * u,
          });
        }
        const link = add({
          kind: 'link', pts: curve, speed: Math.min(f.speed, target.speed, TURN_MS),
          junction: turning(t.node), group: f.group, signal: false, crossingOnly: false, taxiOnly: false, phase: f.phase,
        });
        join(link, target, 1);
        join(f, link, 1);
      }
    }
  }

  /** Aim for roughly `perKm` vehicles per kilometre of lane. */
  populate(perKm: number) {
    const want = Math.min(Math.round((this.laneLength / 1000) * perKm), 900);
    this.want = want;
    while (this.cars.length > want) this.remove(this.cars[this.cars.length - 1]);
    let tries = 0;
    while (this.cars.length < want && tries++ < want * 20) this.spawn(false);
  }

  private pickKind(taxiLane: boolean): number {
    if (taxiLane) {
      const t = this.kinds.findIndex((k) => k.taxi);
      if (t >= 0) return t;
    }
    const total = this.kinds.reduce((a, k) => a + k.weight, 0);
    let r = this.random() * total;
    for (let i = 0; i < this.kinds.length; i++) if ((r -= this.kinds[i].weight) <= 0) return i;
    return 0;
  }

  /** Put one car on the network; `atEntry` prefers the start of a lane nothing feeds. */
  private spawn(atEntry: boolean): boolean {
    const lanes = this.segs.filter((s) => s.kind === 'lane' && s.length > 12);
    if (!lanes.length) return false;
    let seg: Segment | undefined;
    let s = 0;
    if (atEntry) {
      const entries = lanes.filter((l) => l.incoming === 0);
      if (entries.length) {
        seg = entries[Math.floor(this.random() * entries.length)];
        s = 2;
      }
    }
    if (!seg) {
      // Weighted by length, so long roads aren't emptier than short ones.
      let r = this.random() * lanes.reduce((a, l) => a + l.length, 0);
      seg = lanes.find((l) => (r -= l.length) <= 0) ?? lanes[0];
      s = 4 + this.random() * (seg.length - 8);
    }
    if (seg.cars.some((c) => Math.abs(c.s - s) < 9)) return false;
    const kind = this.pickKind(seg.taxiOnly);
    const car: Car = {
      seg: seg.id, s, v: seg.speed * 0.6, kind, len: this.kinds[kind]?.length ?? 4.5,
      factor: 0.86 + this.random() * 0.2, next: -1, wait: 0, trip: 350 + this.random() * 900, x: 0, y: 0, z: 0, heading: 0,
    };
    seg.cars.push(car);
    this.cars.push(car);
    this.locate(car);
    return true;
  }

  private remove(car: Car) {
    const seg = this.segs[car.seg];
    seg.cars.splice(seg.cars.indexOf(car), 1);
    if (seg.kind === 'link') this.release(seg);
    this.cars.splice(this.cars.indexOf(car), 1);
  }

  private release(link: Segment) {
    const j = link.junction !== undefined ? this.junctions.get(link.junction) : undefined;
    if (j && --j.count <= 0) {
      j.count = 0;
      j.wantSwitch = false;
    }
  }

  private choose(seg: Segment): number {
    let r = this.random() * seg.weight.reduce((a, w) => a + w, 0);
    for (let i = 0; i < seg.next.length; i++) if ((r -= seg.weight[i]) <= 0) return seg.next[i];
    return seg.next[0];
  }

  /** Is the signal green for an approach? Two flows alternate with a short all-red gap. */
  green(phase: number, group: 0 | 1, crossingOnly = false): boolean {
    const t = (this.time + phase) % CYCLE_S;
    if (crossingOnly) return t >= 9; // a short red for people crossing
    return group === 0 ? t < 19 : t >= 22 && t < 41;
  }

  /** May `car` cross from the end of `from` onto `to` right now? */
  private mayEnter(car: Car, from: Segment, to: Segment): boolean {
    // A car that has waited far too long pushes in, so a jam can always clear itself.
    const pushy = car.wait > 25;
    const room = (seg: Segment, need: number) => {
      const tail = seg.cars.reduce<Car | null>((a, c) => (!a || c.s < a.s ? c : a), null);
      return !tail || tail.s - tail.len / 2 > need;
    };
    // Coming off a link that joins part-way along: only the spot it lands on matters.
    if (from.merge) return !to.cars.some((c) => Math.abs(c.s - from.merge!.at) < (car.len + c.len) / 2 + 0.5);
    if (!room(to, car.len / 2 + MIN_GAP)) return false;
    if (from.kind !== 'lane' || to.kind !== 'link') return true;
    if (from.signal && !this.green(from.phase, from.group, from.crossingOnly)) return false;
    // Already inside a big junction: just keep going, or the box locks up.
    if (pushy || from.length < INSIDE_JUNCTION_M) return true;
    const beyond = this.segs[to.next[0]];
    if (to.merge && beyond) {
      // Joining part-way along a road: wait for a gap in the traffic already on it.
      const { at, prev } = to.merge;
      const clear = car.len + MIN_GAP + 2;
      if (beyond.cars.some((c) => Math.abs(c.s - at) < clear)) return false;
      const before = this.segs[prev];
      if (before.cars.some((c) => before.length - c.s < 6 + c.v * 2.5)) return false;
    } else if (beyond && !room(beyond, car.len + MIN_GAP)) return false; // don't enter a junction you can't clear
    // Signals already separate the flows; turn-taking is for junctions without them.
    if (to.junction === undefined || (from.signal && !from.crossingOnly)) return true;
    const j = this.junctions.get(to.junction);
    if (!j || j.count === 0) return true;
    if (j.group === from.group) return !(j.wantSwitch && this.time - j.since > 9);
    j.wantSwitch = true;
    return false;
  }

  step(dt: number) {
    this.time += dt;
    const moves: Car[] = [];
    for (const seg of this.segs) {
      if (!seg.cars.length) continue;
      seg.cars.sort((a, b) => b.s - a.s);
      for (let i = 0; i < seg.cars.length; i++) {
        const car = seg.cars[i];
        const v0 = seg.speed * car.factor;
        let gap = Infinity;
        let limitAhead = Infinity;
        const remaining = seg.length - car.s;
        if (i > 0) {
          const lead = seg.cars[i - 1];
          gap = lead.s - lead.len / 2 - (car.s + car.len / 2);
        } else if (seg.next.length) {
          if (car.next < 0 || !seg.next.includes(car.next)) car.next = this.choose(seg);
          const n = this.segs[car.next];
          if (!this.mayEnter(car, seg, n)) gap = remaining - car.len / 2 - 0.6;
          else {
            const tail = n.cars.reduce<Car | null>((a, c) => (!a || c.s < a.s ? c : a), null);
            if (tail) gap = remaining + tail.s - tail.len / 2 - car.len / 2;
            limitAhead = n.speed * car.factor;
          }
        }
        let target = v0;
        if (gap !== Infinity) target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(gap - MIN_GAP, 0)));
        // Ease down in time for a slower stretch ahead (a turn, a lower limit).
        if (limitAhead < target) target = Math.min(target, Math.sqrt(limitAhead * limitAhead + 2 * 2.5 * remaining));
        car.v = Math.max(0, car.v + Math.min(Math.max(target - car.v, -BRAKE * 1.6 * dt), ACCEL * dt));
        car.s += car.v * dt;
        car.trip -= car.v * dt;
        car.wait = car.v < 0.3 ? car.wait + dt : 0;
        if (car.wait > 90) moves.push(car); // hopelessly stuck: taken off and put back elsewhere
        if (i > 0) {
          // Never drive through the car in front, whatever the time step.
          const lead = seg.cars[i - 1];
          const max = lead.s - lead.len / 2 - car.len / 2 - 0.4;
          if (car.s > max) { car.s = Math.max(max, 0); car.v = Math.min(car.v, lead.v); }
        }
        if (car.s >= seg.length) moves.push(car);
      }
    }
    for (const car of moves) {
      const seg = this.segs[car.seg];
      // Trips end at the end of a road, never mid-junction. Without an end, random turns
      // slowly collect every car in one-way loops, which then jam solid.
      if (!seg.next.length || car.wait > 90 || (car.trip <= 0 && seg.kind === 'lane')) {
        // Left the map (or finished its trip): another vehicle comes in somewhere else.
        this.remove(car);
        if (!this.spawn(true)) this.spawn(false);
        continue;
      }
      const n = this.segs[car.next];
      if (!n || !this.mayEnter(car, seg, n)) {
        car.s = seg.length - 0.01;
        car.v = 0;
        continue;
      }
      seg.cars.splice(seg.cars.indexOf(car), 1);
      if (seg.kind === 'link') this.release(seg);
      if (n.kind === 'link' && n.junction !== undefined) {
        const j = this.junctions.get(n.junction) ?? this.junctions.set(n.junction, { count: 0, group: 0, since: 0, wantSwitch: false }).get(n.junction)!;
        if (j.count === 0) { j.group = seg.group; j.since = this.time; }
        j.count++;
      }
      car.s -= seg.length;
      if (seg.merge) car.s = Math.min(car.s + seg.merge.at, n.length - 0.5);
      car.seg = n.id;
      car.next = -1;
      n.cars.push(car);
    }
    // Top up when a car that left the map could not come straight back in.
    if (this.cars.length < this.want) this.spawn(true);
    for (const car of this.cars) this.locate(car);
  }

  /** World position and heading of a car from its place along its segment. */
  private locate(car: Car) {
    const seg = this.segs[car.seg];
    const { pts, cum } = seg;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= car.s) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const l = cum[hi] - cum[lo] || 1;
    const t = Math.min(Math.max((car.s - cum[lo]) / l, 0), 1);
    car.x = a.x + (b.x - a.x) * t;
    car.z = a.z + (b.z - a.z) * t;
    car.y = (a.h ?? 0) + ((b.h ?? 0) - (a.h ?? 0)) * t;
    car.heading = Math.atan2(b.x - a.x, b.z - a.z);
  }
}
