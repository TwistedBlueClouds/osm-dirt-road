// Lane model: parse OSM lane tagging into a per-lane structure and write it back.
//
// Conventions (see https://wiki.openstreetmap.org/wiki/Lanes):
//  - `*:lanes` values list lanes left → right in the direction of travel.
//  - On a two-way road, `*:lanes:forward` / `*:lanes:backward` are used per direction.
//  - `lanes:both_ways=1` is a centre two-way (turn) lane.

import type { Tags } from './osm';

export type Dir = 'forward' | 'backward';
export type Oneway = 'no' | 'yes' | '-1';
export type DrivingSide = 'right' | 'left';

/** Per-lane attributes this editor manages. Key = OSM key prefix. */
export const LANE_KEYS = ['turn', 'destination', 'destination:ref', 'change', 'width'] as const;
export type LaneKey = (typeof LANE_KEYS)[number];

export type Lane = Record<LaneKey, string>;

export const TURN_VALUES = [
  'sharp_left', 'left', 'slight_left', 'through', 'slight_right', 'right', 'sharp_right',
  'reverse', 'merge_to_left', 'merge_to_right', 'none',
] as const;

export const CHANGE_VALUES = ['', 'yes', 'no', 'not_left', 'not_right'] as const;

export interface RoadModel {
  oneway: Oneway;
  forward: Lane[];
  backward: Lane[];
  /** Centre two-way lane (lanes:both_ways). */
  bothWays: Lane | null;
  /** True when lane counts were guessed (no lanes tags present). */
  implied: boolean;
}

export function emptyLane(): Lane {
  return { turn: '', destination: '', 'destination:ref': '', change: '', width: '' };
}

const TRUTHY = new Set(['yes', 'true', '1']);

export function parseOneway(tags: Tags): Oneway {
  const v = tags.oneway;
  if (v && TRUTHY.has(v)) return 'yes';
  if (v === '-1' || v === 'reverse') return '-1';
  if (v === 'no' || v === 'false' || v === '0') return 'no';
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 'yes';
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 'yes';
  return 'no';
}

function int(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function split(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split('|').map((s) => s.trim());
}

/** Tag key for a lane attribute in a given direction. */
export function laneTagKey(key: LaneKey, oneway: boolean, dir: Dir | 'both_ways'): string {
  if (dir === 'both_ways') return `${key}:lanes:both_ways`;
  return oneway ? `${key}:lanes` : `${key}:lanes:${dir}`;
}

export function parseRoad(tags: Tags): RoadModel {
  const oneway = parseOneway(tags);
  const isOneway = oneway !== 'no';
  const total = int(tags.lanes);
  const both = Math.min(int(tags['lanes:both_ways']) ?? 0, 1);

  const counted = (dir: Dir): number | undefined => {
    let n: number | undefined;
    for (const k of LANE_KEYS) {
      const parts = split(tags[laneTagKey(k, isOneway, dir)]);
      if (parts) n = Math.max(n ?? 0, parts.length);
    }
    return n;
  };

  let nf: number;
  let nb: number;
  let implied = false;
  if (isOneway) {
    nf = total ?? counted('forward') ?? 1;
    nb = 0;
    implied = total === undefined && counted('forward') === undefined;
  } else {
    let f = int(tags['lanes:forward']) ?? counted('forward');
    let b = int(tags['lanes:backward']) ?? counted('backward');
    if (f === undefined && b === undefined) {
      if (total !== undefined) {
        const rest = Math.max(total - both, 0);
        f = Math.ceil(rest / 2);
        b = rest - f;
      } else {
        f = 1;
        b = 1;
        implied = true;
      }
    } else if (f === undefined) {
      f = total !== undefined ? Math.max(total - both - b!, 0) : 1;
    } else if (b === undefined) {
      b = total !== undefined ? Math.max(total - both - f, 0) : 1;
    }
    nf = f!;
    nb = b!;
  }

  const build = (dir: Dir, n: number): Lane[] => {
    const lanes = Array.from({ length: n }, emptyLane);
    for (const k of LANE_KEYS) {
      let parts = split(tags[laneTagKey(k, isOneway, dir)]);
      // Tolerate the plain `*:lanes` form on the forward side of a two-way road.
      if (!parts && !isOneway && dir === 'forward' && nb === 0) parts = split(tags[`${k}:lanes`]);
      parts?.forEach((v, i) => {
        if (i < n) lanes[i][k] = v;
      });
    }
    return lanes;
  };

  let bothWays: Lane | null = null;
  if (both && !isOneway) {
    bothWays = emptyLane();
    for (const k of LANE_KEYS) {
      const v = tags[laneTagKey(k, false, 'both_ways')];
      if (v !== undefined) bothWays[k] = v;
    }
    if (!bothWays.turn) bothWays.turn = '';
  }

  return { oneway, forward: build('forward', nf), backward: build('backward', nb), bothWays, implied };
}

/** Remove every key this module manages so the model can be rewritten cleanly. */
function clearLaneTags(tags: Tags): void {
  for (const k of Object.keys(tags)) {
    if (/^(lanes(:forward|:backward|:both_ways)?)$/.test(k)) delete tags[k];
    for (const lk of LANE_KEYS) {
      if (k === `${lk}:lanes` || k.startsWith(`${lk}:lanes:`)) delete tags[k];
    }
  }
}

/** Write the model into a copy of `tags` and return it. */
export function writeRoad(orig: Tags, m: RoadModel): Tags {
  const tags = { ...orig };
  const hadForwardCount = 'lanes:forward' in orig || 'lanes:backward' in orig;
  clearLaneTags(tags);

  // oneway: avoid redundant tags where the highway type already implies it.
  const withoutOneway = { ...orig };
  delete withoutOneway.oneway;
  const implicitOneway = parseOneway(withoutOneway) === 'yes';
  delete tags.oneway;
  if (m.oneway === 'yes') {
    if (!implicitOneway || orig.oneway) tags.oneway = 'yes';
  } else if (m.oneway === '-1') {
    tags.oneway = '-1';
  } else if (implicitOneway || orig.oneway) {
    tags.oneway = 'no';
  }

  const isOneway = m.oneway !== 'no';
  const nf = m.forward.length;
  const nb = isOneway ? 0 : m.backward.length;
  const both = !isOneway && m.bothWays ? 1 : 0;
  tags.lanes = String(nf + nb + both);
  if (!isOneway && (hadForwardCount || nf !== nb || both)) {
    tags['lanes:forward'] = String(nf);
    tags['lanes:backward'] = String(nb);
  }
  if (both) tags['lanes:both_ways'] = '1';

  const put = (dir: Dir, lanes: Lane[]) => {
    for (const k of LANE_KEYS) {
      const vals = lanes.map((l) => l[k].trim());
      if (vals.some((v) => v !== '')) tags[laneTagKey(k, isOneway, dir)] = vals.join('|');
    }
  };
  put('forward', m.forward);
  if (!isOneway) put('backward', m.backward);
  if (both && m.bothWays) {
    for (const k of LANE_KEYS) {
      const v = m.bothWays[k].trim();
      if (v) tags[laneTagKey(k, false, 'both_ways')] = v;
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Layout helpers shared by the 3D view.

export interface LaneSlot {
  dir: Dir | 'both_ways';
  /** Index within its direction's OSM list (left → right in travel direction). */
  index: number;
  lane: Lane;
  /** Left / right offsets (metres, + is right of the way's drawing direction). */
  left: number;
  right: number;
}

export function defaultLaneWidth(highway: string | undefined): number {
  switch (highway) {
    case 'motorway': case 'trunk': case 'motorway_link': case 'trunk_link': return 3.6;
    case 'primary': case 'secondary': case 'primary_link': case 'secondary_link': return 3.3;
    case 'service': case 'track': case 'living_street': return 2.8;
    default: return 3.0;
  }
}

function widthOf(l: Lane, def: number): number {
  const w = parseFloat(l.width);
  return Number.isFinite(w) && w > 0.5 && w < 10 ? w : def;
}

/**
 * Compute every lane's lateral position, left → right as seen when walking
 * along the way in its drawing direction. For `oneway=-1` the caller should
 * reverse the geometry and treat lanes as forward.
 */
export function layoutLanes(tags: Tags, m: RoadModel, side: DrivingSide): LaneSlot[] {
  const def = defaultLaneWidth(tags.highway);
  const isOneway = m.oneway !== 'no';
  const fw = m.forward.map((lane, index) => ({ dir: 'forward' as const, index, lane }));
  const bw = isOneway ? [] : m.backward.map((lane, index) => ({ dir: 'backward' as const, index, lane })).reverse();
  const mid = !isOneway && m.bothWays ? [{ dir: 'both_ways' as const, index: 0, lane: m.bothWays }] : [];
  const ordered = isOneway ? fw : side === 'right' ? [...bw, ...mid, ...fw] : [...fw, ...mid, ...bw];

  const widths = ordered.map((s) => widthOf(s.lane, def));
  const total = widths.reduce((a, b) => a + b, 0);

  // Where does the way sit on the carriageway? Default: the middle, except
  // for asymmetric two-way roads where OSM convention is also the middle.
  let start = -total / 2;
  const placement = tags.placement ?? tags['placement:forward'];
  if (placement) {
    const [kind, nStr] = placement.split(':');
    const n = parseInt(nStr, 10);
    if (Number.isFinite(n) && n >= 1 && n <= ordered.length) {
      // placement counts lanes left → right in the forward direction.
      const fwdOrder = isOneway ? ordered : ordered.filter((s) => s.dir === 'forward');
      const target = fwdOrder[n - 1];
      const ti = ordered.indexOf(target);
      const leftEdge = widths.slice(0, ti).reduce((a, b) => a + b, 0);
      const w = widths[ti];
      const at = kind === 'left_of' ? leftEdge : kind === 'right_of' ? leftEdge + w : leftEdge + w / 2;
      if (kind === 'left_of' || kind === 'right_of' || kind === 'middle_of') start = -at;
    }
  }

  let x = start;
  return ordered.map((s, i) => {
    const slot: LaneSlot = { ...s, left: x, right: x + widths[i] };
    x += widths[i];
    return slot;
  });
}

/** Whether a vehicle may cross from lane `l` into its neighbour on side `side`. */
export function mayChange(l: Lane, side: 'left' | 'right'): boolean {
  const c = l.change;
  if (c === 'no') return false;
  if (c === 'not_left') return side !== 'left';
  if (c === 'not_right') return side !== 'right';
  return true;
}

export interface Warning {
  level: 'warn' | 'info';
  text: string;
}

/** Light validation of the raw tags, so mistakes are visible before upload. */
export function validate(tags: Tags): Warning[] {
  const out: Warning[] = [];
  const m = parseRoad(tags);
  const isOneway = m.oneway !== 'no';
  const lanes = int(tags.lanes);
  const nf = m.forward.length;
  const nb = isOneway ? 0 : m.backward.length;
  const both = m.bothWays ? 1 : 0;
  if (lanes !== undefined && lanes !== nf + nb + both) {
    out.push({ level: 'warn', text: `lanes=${lanes} but forward+backward+both_ways = ${nf + nb + both}` });
  }
  for (const [k, v] of Object.entries(tags)) {
    const mm = /^([a-z:_]+):lanes(?::(forward|backward))?$/.exec(k);
    if (!mm) continue;
    const dir = (mm[2] as Dir | undefined) ?? 'forward';
    const expect = dir === 'backward' ? nb : nf;
    const n = v.split('|').length;
    if (!mm[2] && !isOneway && k !== 'lanes') {
      out.push({ level: 'warn', text: `${k} on a two-way road is ambiguous; use ${k}:forward / :backward` });
    } else if (n !== expect && (LANE_KEYS as readonly string[]).includes(mm[1])) {
      out.push({ level: 'warn', text: `${k} has ${n} values, expected ${expect}` });
    }
    if (mm[1] === 'turn') {
      for (const part of v.split('|')) {
        for (const t of part.split(';')) {
          if (t && !(TURN_VALUES as readonly string[]).includes(t)) {
            out.push({ level: 'warn', text: `Unknown turn value "${t}" in ${k}` });
          }
        }
      }
    }
    if (mm[1] === 'change') {
      for (const part of v.split('|')) {
        if (part && !(CHANGE_VALUES as readonly string[]).includes(part)) {
          out.push({ level: 'warn', text: `Unknown change value "${part}" in ${k}` });
        }
      }
    }
  }
  if (m.implied) out.push({ level: 'info', text: 'No lane tags yet: showing an assumed 1 + 1 layout.' });
  return out;
}
