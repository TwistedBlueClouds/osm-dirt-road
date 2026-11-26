// MapLibre custom layer (Three.js): renders every loaded road with lanes, markings,
// turn arrows and destination gantries on the map, and resolves clicks to a way / lane.
//
// The Three-in-MapLibre wiring (shared GL context, local metric frame placed with a
// model matrix folded into the projection) follows the approach used by
// osm-simple3d-editor (ISC, © Aleksandr Petrov): https://github.com/FelisPimeja/osm-simple3d-editor

import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { buildBuildings, buildTrees } from './context';
import { ROAD_GRADE, isBridge, isTunnel, solveHeights } from './elevation';
import { line, pointAt, polyLength, slice, strip, vertexNormals, type V2 } from './geom';
import type { OsmData, OsmWay } from './osm';
import { laneKind, layoutLanes, layoutSide, mayChange, parseRoad, type DrivingSide, type LaneSlot, type SideStrip } from './lanes';
import { arrowTexture, bikeTexture, roadTextTexture, signFaceTexture, signTexture, signalTexture, type SignStyle } from './textures';

export interface SceneOptions {
  drivingSide: DrivingSide;
  centreLine: 'yellow' | 'white';
  signStyle: SignStyle;
}

export interface LaneRef {
  dir: LaneSlot['dir'];
  index: number;
}

export interface PickResult {
  wayId: number;
  slot: LaneSlot | null;
}

// ---------------------------------------------------------------------------

const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'compacted', 'pebblestone', 'woodchips']);
const LOW_CLASS = new Set(['service', 'track', 'living_street', 'residential', 'unclassified', 'road']);
const FAST = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);

function surfaceColor(tags: Record<string, string>): THREE.Color {
  const s = tags.surface;
  if (s && UNPAVED.has(s)) return new THREE.Color(s === 'grass' ? 0x6f7f4a : s === 'compacted' || s.includes('gravel') ? 0x8f8676 : 0x7a5f45);
  if (s === 'concrete' || s?.startsWith('concrete:')) return new THREE.Color(0x8a8a86);
  if (s === 'paving_stones' || s === 'sett' || s === 'cobblestone') return new THREE.Color(0x7d6f66);
  if (!s && tags.highway === 'track') return new THREE.Color(0x7a5f45);
  return new THREE.Color(0x3a3c40);
}

const KIND_COLOR: Partial<Record<string, THREE.Color>> = {
  bus: new THREE.Color(0x7a3d38), psv: new THREE.Color(0x7a3d38), taxi: new THREE.Color(0x7a3d38),
  bicycle: new THREE.Color(0x3d7a58), restricted: new THREE.Color(0x26272a),
};
const KIND_LABEL: Partial<Record<string, string>> = { bus: 'BUS', psv: 'BUS', taxi: 'TAXI', hov: 'HOV', bicycle: 'bike' };
const SIDE_COLOR = { sidewalk: new THREE.Color(0xb9b5ac), cycle: new THREE.Color(0x3d7a58), parking: new THREE.Color(0x505359) };
const HUMP_COLOR = new THREE.Color(0x5d6066);
const KERB_M = 0.14;

interface Built {
  way: OsmWay;
  /** Geometry in drawing direction (already reversed for oneway=-1). */
  pts: V2[];
  slots: LaneSlot[];
  asphalt: number[];
  /** r, g, b for each asphalt triangle. */
  triColor: number[];
  /** Slot index for each asphalt triangle. */
  triSlot: number[];
  white: number[];
  centre: number[];
  /** Bridge decks, parapets, piers and ramp walls. */
  structure: number[];
  /** 1 = normal, lower for tunnels. */
  alpha: number;
  decor: THREE.Group;
}

export class LaneLayer implements CustomLayerInterface {
  readonly id = 'lanes-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map: MlMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  /** Everything lives under `root` in local metres: x east, y up, z south. */
  private readonly root = new THREE.Group();
  private model = new THREE.Matrix4();
  private lastProj = new THREE.Matrix4();
  private originMc = new MercatorCoordinate(0, 0, 0);
  private metre = 1;
  private data: OsmData | null = null;
  private built = new Map<number, Built>();
  private degree = new Map<number, number>();
  private nodeH = new Map<number, number>();
  private roads = new THREE.Group();
  private decor = new THREE.Group();
  private highlight = new THREE.Group();
  private surroundings = new THREE.Group();
  private asphaltMesh: THREE.Mesh | null = null;
  private triWay: Int32Array = new Int32Array(0);
  private triSlot: Int32Array = new Int32Array(0);
  private selected: { wayId: number; lane: LaneRef | null } | null = null;
  opts: SceneOptions;

  private matAsphalt = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  private matWhite = new THREE.MeshBasicMaterial({ color: 0xf2f2ee, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private matCentre = new THREE.MeshBasicMaterial({ color: 0xf2c21b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private matSel = new THREE.MeshBasicMaterial({ color: 0x29b6f6, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private matSelLane = new THREE.MeshBasicMaterial({ color: 0xff9800, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private matStructure = new THREE.MeshLambertMaterial({ color: 0xb9b6ae, side: THREE.DoubleSide });
  private matPole = new THREE.MeshLambertMaterial({ color: 0x23262a });
  private decalMats = new Map<THREE.Texture, THREE.MeshBasicMaterial>();
  private matSteel = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
  private matSignBack = new THREE.MeshLambertMaterial({ color: 0x6b7075 });

  constructor(opts: SceneOptions) {
    this.opts = opts;
    this.matCentre.color.set(opts.centreLine === 'yellow' ? 0xf2c21b : 0xf2f2ee);
    this.root.add(this.surroundings, this.roads, this.decor, this.highlight);
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556655, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(200, 400, 120);
    this.scene.add(sun);
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
  }

  onRemove() {
    this.renderer?.dispose();
    this.renderer = null;
  }

  render(_gl: unknown, options: CustomRenderMethodInput) {
    if (!this.renderer || !this.data) return;
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]);
    this.lastProj = main.multiply(this.model);
    this.camera.projectionMatrix.copy(this.lastProj);
    this.camera.projectionMatrixInverse.copy(this.lastProj).invert();
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  private repaint() {
    this.map?.triggerRepaint();
  }

  /** Resolve a screen point (CSS pixels in the map container) to a way / lane. */
  pick(x: number, y: number): PickResult | null {
    if (!this.asphaltMesh || !this.map) return null;
    const c = this.map.getContainer();
    const nx = (x / c.clientWidth) * 2 - 1;
    const ny = -(y / c.clientHeight) * 2 + 1;
    const inv = this.lastProj.clone().invert();
    const near = new THREE.Vector3(nx, ny, -1).applyMatrix4(inv);
    const far = new THREE.Vector3(nx, ny, 1).applyMatrix4(inv);
    const ray = new THREE.Raycaster(near, far.sub(near).normalize());
    this.scene.updateMatrixWorld();
    const hit = ray.intersectObject(this.asphaltMesh, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const wayId = this.triWay[hit.faceIndex];
    const b = this.built.get(wayId);
    const si = this.triSlot[hit.faceIndex];
    return { wayId, slot: b && si >= 0 ? b.slots[si] : null };
  }

  /** 0 = only markings over the imagery, 1 = solid road surface. */
  setRoadOpacity(v: number) {
    this.matAsphalt.opacity = v;
    this.matAsphalt.visible = v > 0.01;
    this.repaint();
  }

  setOptions(o: Partial<SceneOptions>) {
    this.opts = { ...this.opts, ...o };
    this.matCentre.color.set(this.opts.centreLine === 'yellow' ? 0xf2c21b : 0xf2f2ee);
    if (this.data) this.rebuildAll();
  }

  private project(lat: number, lon: number): V2 {
    const c = MercatorCoordinate.fromLngLat({ lng: lon, lat }, 0);
    return { x: (c.x - this.originMc.x) / this.metre, z: (c.y - this.originMc.y) / this.metre };
  }

  private unproject(p: V2): { lng: number; lat: number } {
    return new MercatorCoordinate(this.originMc.x + p.x * this.metre, this.originMc.y + p.z * this.metre, 0).toLngLat();
  }

  setData(data: OsmData, centre: { lat: number; lon: number }) {
    this.data = data;
    this.originMc = MercatorCoordinate.fromLngLat({ lng: centre.lon, lat: centre.lat }, 0);
    this.metre = this.originMc.meterInMercatorCoordinateUnits();
    const m = this.metre;
    // local (x east, y up, z south) → mercator (x east, y south, z up)
    this.model = new THREE.Matrix4()
      .makeTranslation(this.originMc.x, this.originMc.y, 0)
      .multiply(new THREE.Matrix4().set(m, 0, 0, 0, 0, 0, m, 0, 0, m, 0, 0, 0, 0, 0, 1));
    this.degree.clear();
    for (const w of data.ways.values()) {
      w.nodes.forEach((n, i) => {
        const inc = i === 0 || i === w.nodes.length - 1 ? 1 : 2;
        this.degree.set(n, (this.degree.get(n) ?? 0) + inc);
      });
    }
    this.nodeH = solveHeights(data);
    this.selected = null;
    this.rebuildAll();
    this.rebuildSurroundings();
  }

  private rebuildSurroundings() {
    this.surroundings.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.surroundings.clear();
    if (!this.data) return;
    const project = (lat: number, lon: number) => this.project(lat, lon);
    const b = buildBuildings(this.data.context, project);
    const t = buildTrees(this.data.context, project);
    if (b) this.surroundings.add(b);
    if (t) this.surroundings.add(t);
  }

  setSurroundingsVisible(on: boolean) {
    this.surroundings.visible = on;
    this.repaint();
  }

  clear() {
    this.data = null;
    this.repaint();
  }

  private rebuildAll() {
    for (const b of this.built.values()) this.disposeGroup(b.decor);
    this.built.clear();
    if (!this.data) return;
    for (const w of this.data.ways.values()) this.built.set(w.id, this.buildWay(w));
    this.merge();
  }

  /** Rebuild one way after its tags changed. */
  updateWay(id: number) {
    const w = this.data?.ways.get(id);
    if (!w) return;
    const old = this.built.get(id);
    if (old) this.disposeGroup(old.decor);
    this.built.set(id, this.buildWay(w));
    this.merge();
  }

  private disposeGroup(g: THREE.Object3D) {
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    g.removeFromParent();
  }

  private buildWay(w: OsmWay): Built {
    const d = this.data!;
    const model = parseRoad(w.tags);
    let pts: V2[] = w.nodes.map((id) => {
      const n = d.nodes.get(id)!;
      return { ...this.project(n.lat, n.lon), h: this.nodeH.get(id) ?? 0 };
    });
    const raised = pts.some((p) => (p.h ?? 0) > 0.05);
    if (raised) pts = densifyRamp(pts);
    let endNodes = [w.nodes[0], w.nodes[w.nodes.length - 1]];
    const reversed = model.oneway === '-1';
    if (reversed) {
      pts = pts.slice().reverse();
      endNodes = endNodes.reverse();
      model.oneway = 'yes';
    }
    const slots = layoutLanes(w.tags, model, this.opts.drivingSide);
    const b: Built = {
      way: w, pts, slots, asphalt: [], triColor: [], triSlot: [],
      white: [], centre: [], structure: [], alpha: isTunnel(w.tags) ? 0.45 : 1, decor: new THREE.Group(),
    };
    if (pts.length < 2) return b;

    const surface = surfaceColor(w.tags);
    const paint = (n: number, c: THREE.Color, slot: number) => {
      for (let k = 0; k < n; k++) {
        b.triSlot.push(slot);
        b.triColor.push(c.r, c.g, c.b);
      }
    };
    // Surface, one strip per lane so picks resolve to a lane; reserved lanes are tinted.
    slots.forEach((s, i) => {
      const kind = laneKind(s.lane, w.tags.highway);
      paint(strip(b.asphalt, pts, s.left, s.right, 0), KIND_COLOR[kind] ?? surface, i);
    });

    const L = polyLength(pts);
    // Roadside strips: shoulders, cycle lanes, parking, pavements.
    const sides: { strips: SideStrip[]; dir: -1 | 1 }[] = [];
    if (slots.length) {
      const tagSide = (draw: 'left' | 'right') => (reversed ? (draw === 'left' ? 'right' : 'left') : draw);
      sides.push({ strips: layoutSide(w.tags, tagSide('left'), slots[0].left, -1), dir: -1 });
      sides.push({ strips: layoutSide(w.tags, tagSide('right'), slots[slots.length - 1].right, 1), dir: 1 });
    }
    const n0 = vertexNormals(pts);
    for (const { strips, dir } of sides) {
      for (const st of strips) {
        const inner = dir === 1 ? st.left : st.right;
        const outer = dir === 1 ? st.right : st.left;
        if (st.kind === 'sidewalk') {
          paint(strip(b.asphalt, pts, st.left, st.right, KERB_M), SIDE_COLOR.sidewalk, -1);
          wall(b.structure, pts, n0, inner, (h) => h + KERB_M, (h) => h, true);
          wall(b.structure, pts, n0, outer, (h) => h + KERB_M, (h) => h, true);
        } else {
          paint(strip(b.asphalt, pts, st.left, st.right, 0), st.kind === 'shoulder' ? surface : SIDE_COLOR[st.kind], -1);
          if (st.kind === 'cycle') {
            line(b.white, pts, inner, 0.12, 0.02);
            for (let s = 10; s < L - 4; s += 60) this.decal(b, bikeTexture(), pts, s, (st.left + st.right) / 2, 1.1, 2.6);
          } else if (st.kind === 'parking') {
            line(b.white, pts, inner, 0.1, 0.02, [1, 1]);
            for (let s = 3; s < L - 3; s += 6) strip(b.white, slice(pts, s - 0.05, s + 0.05), st.left, st.right, 0.02);
          } else if (st.kind === 'shoulder') {
            line(b.white, pts, outer - dir * 0.2, 0.12, 0.02);
          }
        }
      }
    }

    const hasLaneTags = Object.keys(w.tags).some((k) => k === 'lanes' || k.includes(':lanes'));
    const unpaved = (w.tags.surface && UNPAVED.has(w.tags.surface)) || (!w.tags.surface && w.tags.highway === 'track');
    const markings = !unpaved && w.tags.lane_markings !== 'no' && (hasLaneTags || !LOW_CLASS.has(w.tags.highway));
    const junctionTrim = (n: number) => ((this.degree.get(n) ?? 0) >= 3 ? 4 : 0);
    const trim: [number, number] = [junctionTrim(endNodes[0]), junctionTrim(endNodes[1])];
    const fast = FAST.has(w.tags.highway);
    const dash: [number, number] = fast ? [6, 12] : [3, 5];

    if (markings && slots.length) {
      const y = 0.02;
      const lw = 0.12;
      // Edge lines
      line(b.white, pts, slots[0].left + 0.25, 0.15, y, undefined, trim);
      line(b.white, pts, slots[slots.length - 1].right - 0.25, 0.15, y, undefined, trim);

      for (let i = 0; i < slots.length - 1; i++) {
        const a = slots[i];
        const c = slots[i + 1];
        const x = a.right;
        if (a.dir === c.dir && a.dir !== 'both_ways') {
          const fwd = a.dir === 'forward';
          const ab = mayChange(a.lane, fwd ? 'right' : 'left');
          const ba = mayChange(c.lane, fwd ? 'left' : 'right');
          if (ab && ba) line(b.white, pts, x, lw, y, dash, trim);
          else if (!ab && !ba) line(b.white, pts, x, lw, y, undefined, trim);
          else {
            // Solid on the side of the lane that may not cross.
            const solidSide = ab ? 1 : -1;
            line(b.white, pts, x + solidSide * 0.11, lw, y, undefined, trim);
            line(b.white, pts, x - solidSide * 0.11, lw, y, dash, trim);
          }
        } else if (a.dir === 'both_ways' || c.dir === 'both_ways') {
          // Centre turn lane: solid outside, dashed toward the turn lane.
          const towards = a.dir === 'both_ways' ? -1 : 1;
          line(b.centre, pts, x - towards * 0.11, lw, y, undefined, trim);
          line(b.centre, pts, x + towards * 0.11, lw, y, dash, trim);
        } else {
          // Opposing directions.
          const ov = w.tags.overtaking;
          const total = slots.length;
          const fwdSlot = a.dir === 'forward' ? a : c;
          const leftIsFwd = fwdSlot === a;
          const ovF = w.tags['overtaking:forward'] ?? ov;
          const ovB = w.tags['overtaking:backward'] ?? ov;
          const def = total >= 4 ? 'no' : 'yes';
          const fOK = (ovF ?? def) !== 'no';
          const bOK = (ovB ?? def) !== 'no';
          if (fOK && bOK) line(b.centre, pts, x, lw, y, dash, trim);
          else if (!fOK && !bOK) {
            line(b.centre, pts, x - 0.11, lw, y, undefined, trim);
            line(b.centre, pts, x + 0.11, lw, y, undefined, trim);
          } else {
            // The line nearest each direction tells that direction whether it may pass.
            const fSide = leftIsFwd ? -1 : 1;
            line(b.centre, pts, x + fSide * 0.11, lw, y, fOK ? dash : undefined, trim);
            line(b.centre, pts, x - fSide * 0.11, lw, y, bOK ? dash : undefined, trim);
          }
        }
      }
    }

    if (raised && slots.length) buildStructure(b.structure, pts, slots[0].left - 0.35, slots[slots.length - 1].right + 0.35, isBridge(w.tags));
    this.buildArrows(b, L, trim);
    this.buildLaneSymbols(b, L, trim);
    this.buildSigns(b, L);
    if (slots.length) this.buildFeatures(b, w, L, reversed, trim);
    return b;
  }

  /** Travel-direction polyline for a slot's direction. */
  private travel(b: Built, dir: LaneSlot['dir']): { pts: V2[]; sign: 1 | -1 } {
    return dir === 'backward' ? { pts: b.pts.slice().reverse(), sign: -1 } : { pts: b.pts, sign: 1 };
  }

  /** A painted symbol lying on the road at arc-length `at` of `pts`, pointing along `pts`. */
  private decal(b: Built, tex: THREE.Texture, pts: V2[], at: number, lateral: number, width: number, length: number) {
    const { p, dir } = pointAt(pts, at);
    const nx = -dir.z, nz = dir.x;
    let mat = this.decalMats.get(tex);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      this.decalMats.set(tex, mat);
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 3;
    const g = new THREE.Group();
    g.add(mesh);
    g.position.set(p.x + nx * lateral, (p.h ?? 0) + 0.03, p.z + nz * lateral);
    g.rotation.y = Math.atan2(-dir.x, -dir.z);
    b.decor.add(g);
  }

  private buildArrows(b: Built, L: number, trim: [number, number]) {
    for (const s of b.slots) {
      const tex = arrowTexture(s.lane.turn);
      if (!tex) continue;
      const { pts, sign } = this.travel(b, s.dir);
      const endTrim = sign === 1 ? trim[1] : trim[0];
      const positions = [] as number[];
      if (L > 14) positions.push(L - endTrim - 10);
      if (L > 80) positions.push(L - endTrim - 40);
      if (!positions.length) positions.push(L / 2);
      const lw = s.right - s.left;
      for (const at of positions) this.decal(b, tex, pts, at, ((s.left + s.right) / 2) * sign, Math.min(lw * 0.55, 1.8), 5);
    }
  }

  /** BUS / TAXI lettering, cycle symbols and per-lane speed limits. */
  private buildLaneSymbols(b: Built, L: number, trim: [number, number]) {
    for (const s of b.slots) {
      const kind = laneKind(s.lane, b.way.tags.highway);
      const label = KIND_LABEL[kind];
      const speed = s.lane.maxspeed && /^\d+/.test(s.lane.maxspeed) ? s.lane.maxspeed.match(/^\d+/)![0] : '';
      if (!label && !speed) continue;
      const { pts, sign } = this.travel(b, s.dir);
      const startTrim = sign === 1 ? trim[0] : trim[1];
      const lateral = ((s.left + s.right) / 2) * sign;
      const w = Math.min((s.right - s.left) * 0.6, 1.9);
      for (let at = startTrim + 8; at < L - 22; at += 90) {
        if (label) this.decal(b, label === 'bike' ? bikeTexture() : roadTextTexture(label), pts, at, lateral, w, label === 'bike' ? 2.8 : 3.6);
        if (speed) this.decal(b, roadTextTexture(speed), pts, at + (label ? 6 : 0), lateral, w, 3.2);
      }
    }
  }

  /** Lateral extent (drawing offsets) of the lanes travelling in a drawing direction. */
  private span(b: Built, dir: 'forward' | 'backward'): [number, number] | null {
    const ls = b.slots.filter((s) => s.dir === dir);
    if (!ls.length) return null;
    return [Math.min(...ls.map((s) => s.left)), Math.max(...ls.map((s) => s.right))];
  }

  /** Crossings, stop and give-way lines, traffic signals and traffic calming along a way. */
  private buildFeatures(b: Built, w: OsmWay, L: number, reversed: boolean, trim: [number, number]) {
    const d = this.data!;
    const pts = b.pts;
    const full: [number, number] = [b.slots[0].left, b.slots[b.slots.length - 1].right];
    const y = 0.021;
    // Arc length of each way node in drawing direction.
    let acc = 0;
    const raw = w.nodes.map((id) => d.nodes.get(id)!);
    const sAt = raw.map((n, i) => {
      if (i > 0) {
        const a = this.project(raw[i - 1].lat, raw[i - 1].lon);
        const c = this.project(n.lat, n.lon);
        acc += Math.hypot(c.x - a.x, c.z - a.z);
      }
      return acc;
    });
    const total = acc || 1;
    const bar = (s: number, span: [number, number], width: number) => {
      const a = Math.max(0, s - width / 2), c = Math.min(L, s + width / 2);
      if (c - a > 0.05) strip(b.white, slice(pts, a, c), span[0], span[1], y);
    };
    /** Stop line (and optional furniture) for traffic travelling `dir` (drawing direction) at arc length s. */
    const stopFor = (dir: 'forward' | 'backward', s: number, kind: 'stop' | 'give_way' | 'signals') => {
      const span = this.span(b, dir);
      if (!span) return;
      if (kind === 'give_way') {
        for (let x = span[0] + 0.15; x < span[1] - 0.4; x += 0.9) bar(s, [x, x + 0.6], 0.5);
      } else bar(s, [span[0] + 0.1, span[1] - 0.1], kind === 'signals' ? 0.4 : 0.5);
      // Furniture stands on the outside of the approach lanes.
      const outerIsRight = span[1] >= full[1] - 0.01 && (dir === 'forward' || span[0] > full[0] + 0.01);
      const lateral = outerIsRight ? span[1] + 0.9 : span[0] - 0.9;
      const { p, dir: t } = pointAt(pts, Math.min(Math.max(s, 0), L));
      const travel = dir === 'forward' ? t : { x: -t.x, z: -t.z };
      const pos = new THREE.Vector3(p.x - t.z * lateral, p.h ?? 0, p.z + t.x * lateral);
      const heading = Math.atan2(-travel.x, -travel.z);
      const g = new THREE.Group();
      g.position.copy(pos);
      g.rotation.y = heading;
      if (kind === 'signals') {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 8), this.matSteel);
        pole.position.y = 1.7;
        const face = new THREE.MeshBasicMaterial({ map: signalTexture() });
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 0.28), [this.matPole, this.matPole, this.matPole, this.matPole, face, this.matPole]);
        head.position.y = 3.0;
        g.add(pole, head);
      } else {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.3, 6), this.matSteel);
        pole.position.y = 1.15;
        const face = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ map: signFaceTexture(kind), transparent: true, side: THREE.DoubleSide }));
        face.position.set(0, 2.3, 0.05);
        g.add(pole, face);
      }
      b.decor.add(g);
    };

    w.nodes.forEach((id, i) => {
      const tags = d.nodes.get(id)?.tags;
      if (!tags) return;
      let s = (reversed ? total - sAt[i] : sAt[i]) * (L / total);
      const atStart = s < 0.01;
      const atEnd = s > L - 0.01;
      const junction = (this.degree.get(id) ?? 0) >= 3;
      const toDraw = (v: string | undefined): 'forward' | 'backward' | 'both' | undefined =>
        v === 'forward' || v === 'backward' ? ((v === 'forward') !== reversed ? 'forward' : 'backward') : v === 'both' ? 'both' : undefined;

      const hasCrossing = tags.highway === 'crossing' || (tags.crossing !== undefined && tags.crossing !== 'no');
      if (hasCrossing) {
        const marks = tags['crossing:markings'] ?? (tags.crossing === 'unmarked' ? 'no' : tags.crossing === 'traffic_signals' || tags['crossing:signals'] === 'yes' ? 'lines' : 'zebra');
        const c = Math.min(Math.max(s, 2), L - 2);
        if (marks !== 'no') {
          if (marks.startsWith('zebra') || marks === 'yes' || marks === 'ladder') {
            for (let x = full[0] + 0.3; x < full[1] - 0.6; x += 1.0) bar(c, [x, x + 0.5], 3);
          }
          if (marks === 'lines' || marks === 'dashes' || marks.includes('lines') || marks === 'ladder') {
            bar(c - 1.6, full, 0.15);
            bar(c + 1.6, full, 0.15);
          }
        }
        if (tags.crossing === 'traffic_signals' || tags['crossing:signals'] === 'yes') {
          stopFor('forward', c - 2.6, 'signals');
          stopFor('backward', c + 2.6, 'signals');
        }
      }
      if (tags.highway === 'traffic_signals') {
        if (junction && (atStart || atEnd)) {
          // Signals mapped on the junction node: stop the lanes heading into it.
          if (atEnd) stopFor('forward', L - trim[1] - 0.6, 'signals');
          else stopFor('backward', trim[0] + 0.6, 'signals');
        } else if (!hasCrossing) {
          const dir = toDraw(tags['traffic_signals:direction'] ?? tags.direction) ?? 'both';
          if (dir !== 'backward') stopFor('forward', s - 1, 'signals');
          if (dir !== 'forward') stopFor('backward', s + 1, 'signals');
        }
      }
      if (tags.highway === 'stop' || tags.highway === 'give_way') {
        // Without a direction tag the sign faces traffic heading for the nearer end of the way.
        const dir = toDraw(tags.direction) ?? (s > L / 2 ? 'forward' : 'backward');
        if (dir === 'both' || dir === 'forward') stopFor('forward', s, tags.highway);
        if (dir === 'both' || dir === 'backward') stopFor('backward', s, tags.highway);
      }
      if (tags.traffic_calming && ['hump', 'bump', 'table', 'cushion', 'yes'].includes(tags.traffic_calming)) {
        const half = tags.traffic_calming === 'table' ? 3 : tags.traffic_calming === 'bump' ? 0.4 : 1.8;
        s = Math.min(Math.max(s, half), L - half);
        const n = strip(b.asphalt, slice(pts, s - half, s + half), full[0] + 0.2, full[1] - 0.2, 0.012);
        for (let k = 0; k < n; k++) {
          b.triSlot.push(-1);
          b.triColor.push(HUMP_COLOR.r, HUMP_COLOR.g, HUMP_COLOR.b);
        }
        for (let x = full[0] + 0.6; x < full[1] - 0.9; x += 1.4) {
          bar(s - half + 0.5, [x, x + 0.5], 0.9);
          bar(s + half - 0.5, [x, x + 0.5], 0.9);
        }
      }
    });
  }

  private buildSigns(b: Built, L: number) {
    const tags = b.way.tags;
    const groups: Record<string, LaneSlot[]> = {};
    for (const s of b.slots) {
      if (s.dir === 'both_ways') continue;
      (groups[s.dir] ??= []).push(s);
    }
    for (const [dir, slots] of Object.entries(groups)) {
      const anyLane = slots.some((s) => s.lane.destination || s.lane['destination:ref']);
      const wayLevel = !anyLane && dir === 'forward' && b.slots.every((s) => s.dir === 'forward') && (tags.destination || tags['destination:ref']);
      if (!anyLane && !wayLevel) continue;
      const { pts, sign } = this.travel(b, dir as LaneSlot['dir']);
      const at = Math.max(Math.min(L - 70, L * 0.5), Math.min(L * 0.5, 8));
      const { p, dir: d } = pointAt(pts, at);
      const nx = -d.z, nz = d.x; // travel-right
      const heading = Math.atan2(-d.x, -d.z);
      // Travel-right offsets of each lane, in travel order.
      const ordered = slots
        .map((s) => ({ s, l: Math.min(s.left * sign, s.right * sign), r: Math.max(s.left * sign, s.right * sign) }))
        .sort((a, c) => a.l - c.l);
      const panels = wayLevel
        ? [{ l: ordered[0].l, r: ordered[ordered.length - 1].r, dest: tags.destination ?? '', ref: tags['destination:ref'] ?? '', turn: '' }]
        : ordered.map((o) => ({ l: o.l, r: o.r, dest: o.s.lane.destination, ref: o.s.lane['destination:ref'], turn: o.s.lane.turn }));
      const span0 = ordered[0].l - 0.6;
      const span1 = ordered[ordered.length - 1].r + 0.6;
      const H = 7.4;
      const at3 = (off: number, y: number) => new THREE.Vector3(p.x + nx * off, (p.h ?? 0) + y, p.z + nz * off);

      const beam = new THREE.Mesh(new THREE.BoxGeometry(span1 - span0, 0.35, 0.35), this.matSteel);
      beam.position.copy(at3((span0 + span1) / 2, H));
      beam.rotation.y = heading;
      b.decor.add(beam);
      for (const off of [span0, span1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, H + 0.3, 10), this.matSteel);
        pole.position.copy(at3(off, (H + 0.3) / 2));
        b.decor.add(pole);
      }
      for (const pn of panels) {
        const w = Math.min(Math.max(pn.r - pn.l - 0.2, 1.5), wayLevel ? 6 : 4);
        const tex = signTexture({
          destinations: pn.dest ? pn.dest.split(';').map((s) => s.trim()).filter(Boolean) : [],
          refs: pn.ref ? pn.ref.split(';').map((s) => s.trim()).filter(Boolean) : [],
          turn: pn.turn,
          style: this.opts.signStyle,
        });
        const front = new THREE.MeshBasicMaterial({ map: tex });
        const mats = [this.matSignBack, this.matSignBack, this.matSignBack, this.matSignBack, front, this.matSignBack];
        const panel = new THREE.Mesh(new THREE.BoxGeometry(w, w * 0.625, 0.12), mats);
        panel.position.copy(at3((pn.l + pn.r) / 2, H - 0.25 - (w * 0.625) / 2));
        panel.position.add(new THREE.Vector3(-d.x * 0.3, 0, -d.z * 0.3));
        panel.rotation.y = heading;
        b.decor.add(panel);
      }
    }
  }

  /** Merge every way's geometry into a few big meshes. */
  private merge() {
    this.roads.clear();
    this.decor.clear();
    let triCount = 0;
    for (const b of this.built.values()) triCount += b.asphalt.length / 9;
    const pos = new Float32Array(triCount * 9);
    const col = new Float32Array(triCount * 12);
    this.triWay = new Int32Array(triCount);
    this.triSlot = new Int32Array(triCount);
    const white: number[] = [];
    const centre: number[] = [];
    const structure: number[] = [];
    let t = 0;
    for (const b of this.built.values()) {
      pos.set(b.asphalt, t * 9);
      const n = b.asphalt.length / 9;
      for (let i = 0; i < n; i++) {
        this.triWay[t + i] = b.way.id;
        this.triSlot[t + i] = b.triSlot[i] ?? -1;
        for (let v = 0; v < 3; v++) {
          const o = (t + i) * 12 + v * 4;
          col[o] = b.triColor[i * 3];
          col[o + 1] = b.triColor[i * 3 + 1];
          col[o + 2] = b.triColor[i * 3 + 2];
          col[o + 3] = b.alpha;
        }
      }
      t += n;
      for (const v of b.white) white.push(v);
      for (const v of b.centre) centre.push(v);
      for (const v of b.structure) structure.push(v);
      this.decor.add(b.decor);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.asphaltMesh?.geometry.dispose();
    this.asphaltMesh = new THREE.Mesh(g, this.matAsphalt);
    this.asphaltMesh.frustumCulled = false;
    this.roads.add(this.asphaltMesh);
    for (const [arr, mat] of [[white, this.matWhite], [centre, this.matCentre]] as const) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const lm = new THREE.Mesh(lg, mat);
      lm.renderOrder = 2;
      lm.frustumCulled = false;
      this.roads.add(lm);
    }
    if (structure.length) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(structure, 3));
      sg.computeVertexNormals();
      const sm = new THREE.Mesh(sg, this.matStructure);
      sm.frustumCulled = false;
      this.roads.add(sm);
    }
    this.drawHighlight();
    this.repaint();
  }

  /** Highlight a way and optionally one of its lanes (by OSM direction + index). */
  select(wayId: number | null, lane: LaneRef | null = null) {
    this.selected = wayId == null ? null : { wayId, lane };
    this.drawHighlight();
  }

  private drawHighlight() {
    this.highlight.children.forEach((c) => (c as THREE.Mesh).geometry.dispose());
    this.highlight.clear();
    this.repaint();
    if (!this.selected) return;
    const b = this.built.get(this.selected.wayId);
    if (!b || !b.slots.length) return;
    const all: number[] = [];
    strip(all, b.pts, b.slots[0].left - 0.4, b.slots[b.slots.length - 1].right + 0.4, 0.01);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    const hm = new THREE.Mesh(g, this.matSel);
    hm.renderOrder = 1;
    this.highlight.add(hm);
    const ref = this.selected.lane;
    const s = ref && b.slots.find((x) => x.dir === ref.dir && x.index === ref.index);
    if (s) {
      const one: number[] = [];
      strip(one, b.pts, s.left, s.right, 0.012);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(one, 3));
      const hl = new THREE.Mesh(lg, this.matSelLane);
      hl.renderOrder = 1;
      this.highlight.add(hl);
    }
  }

  /** Where to point the camera to look along a way in its travel direction. */
  wayFrame(wayId: number): { center: { lng: number; lat: number }; bearing: number; length: number } | null {
    const b = this.built.get(wayId);
    if (!b || b.pts.length < 2) return null;
    const L = polyLength(b.pts);
    const { p, dir } = pointAt(b.pts, L * 0.5);
    return { center: this.unproject(p), bearing: (Math.atan2(dir.x, -dir.z) * 180) / Math.PI, length: L };
  }
}

/** Add points along a raised way so ramps follow the maximum grade instead of one long slope. */
function densifyRamp(p: V2[]): V2[] {
  const out: V2[] = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const ha = a.h ?? 0;
    const hb = b.h ?? 0;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = ha > 0.05 || hb > 0.05 ? Math.floor(len / 8) : 0;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      // Each end's height falls away at the ramp grade; never below the straight line between them.
      const h = Math.max(ha - ROAD_GRADE * len * t, hb - ROAD_GRADE * len * (1 - t), Math.min(ha, hb), 0);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h });
    }
    out.push(b);
  }
  return out;
}

/** Vertical wall along a polyline at a lateral offset, between two height functions. */
function wall(out: number[], p: V2[], n: V2[], off: number, top: (h: number) => number, bottom: (h: number) => number, onGround = false) {
  for (let i = 0; i < p.length - 1; i++) {
    const h0 = p[i].h ?? 0;
    const h1 = p[i + 1].h ?? 0;
    if (!onGround && h0 < 0.05 && h1 < 0.05) continue;
    const x0 = p[i].x + n[i].x * off, z0 = p[i].z + n[i].z * off;
    const x1 = p[i + 1].x + n[i + 1].x * off, z1 = p[i + 1].z + n[i + 1].z * off;
    const t0 = top(h0), t1 = top(h1), b0 = bottom(h0), b1 = bottom(h1);
    out.push(x0, b0, z0, x1, b1, z1, x0, t0, z0, x0, t0, z0, x1, b1, z1, x1, t1, z1);
  }
}

const DECK_M = 1.0;
const PARAPET_M = 0.9;

/** Bridge: deck slab, parapets and piers. Ramp (raised, not a bridge): retaining walls to the ground. */
function buildStructure(out: number[], p: V2[], left: number, right: number, bridge: boolean) {
  const n = vertexNormals(p);
  const under = (h: number) => (bridge ? Math.max(h - DECK_M, 0) : 0);
  for (const off of [left, right]) {
    wall(out, p, n, off, (h) => h + PARAPET_M, under);
    // Inner face of the parapet, so it reads as a wall from the road too.
    wall(out, p, n, off + (off < 0 ? 0.25 : -0.25), (h) => h + PARAPET_M, (h) => h);
  }
  if (!bridge) return;
  // Underside of the deck.
  for (let i = 0; i < p.length - 1; i++) {
    const h0 = p[i].h ?? 0, h1 = p[i + 1].h ?? 0;
    if (h0 < DECK_M && h1 < DECK_M) continue;
    const q = (k: number, off: number, h: number) => [p[k].x + n[k].x * off, under(h), p[k].z + n[k].z * off];
    out.push(...q(i, left, h0), ...q(i + 1, left, h1), ...q(i, right, h0), ...q(i, right, h0), ...q(i + 1, left, h1), ...q(i + 1, right, h1));
  }
  // Piers roughly every 28 m where there is room beneath.
  const L = polyLength(p);
  const count = Math.floor(L / 28);
  for (let k = 1; k <= count; k++) {
    const { p: c, dir } = pointAt(p, (L * k) / (count + 1));
    const top = (c.h ?? 0) - DECK_M;
    if (top < 2) continue;
    const w = Math.min(Math.max((right - left) * 0.35, 1.2), 6) / 2;
    const t = 0.6;
    const rx = -dir.z, rz = dir.x;
    const mid = (left + right) / 2;
    const corner = (a: number, bb: number) => [c.x + rx * (mid + a) + dir.x * bb, c.z + rz * (mid + a) + dir.z * bb];
    const cs = [corner(-w, -t), corner(w, -t), corner(w, t), corner(-w, t)];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = cs[i];
      const [bx, bz] = cs[(i + 1) % 4];
      out.push(ax, 0, az, bx, 0, bz, ax, top, az, ax, top, az, bx, 0, bz, bx, top, bz);
    }
  }
}
