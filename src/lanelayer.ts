// MapLibre custom layer (Three.js): renders every loaded road with lanes, markings,
// turn arrows and destination gantries on the map, and resolves clicks to a way / lane.
//
// The Three-in-MapLibre wiring (shared GL context, local metric frame placed with a
// model matrix folded into the projection) follows the approach used by
// osm-simple3d-editor (ISC, © Aleksandr Petrov): https://github.com/FelisPimeja/osm-simple3d-editor

import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { line, pointAt, polyLength, strip, type V2 } from './geom';
import type { OsmData, OsmWay } from './osm';
import { layoutLanes, mayChange, parseRoad, type DrivingSide, type LaneSlot } from './lanes';
import { arrowTexture, signTexture, type SignStyle } from './textures';

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

interface Built {
  way: OsmWay;
  /** Geometry in drawing direction (already reversed for oneway=-1). */
  pts: V2[];
  slots: LaneSlot[];
  asphalt: number[];
  asphaltColor: THREE.Color;
  /** Slot index for each asphalt triangle. */
  triSlot: number[];
  white: number[];
  centre: number[];
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
  private roads = new THREE.Group();
  private decor = new THREE.Group();
  private highlight = new THREE.Group();
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
  private matSteel = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
  private matSignBack = new THREE.MeshLambertMaterial({ color: 0x6b7075 });

  constructor(opts: SceneOptions) {
    this.opts = opts;
    this.matCentre.color.set(opts.centreLine === 'yellow' ? 0xf2c21b : 0xf2f2ee);
    this.root.add(this.roads, this.decor, this.highlight);
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
    this.selected = null;
    this.rebuildAll();
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
    let pts = w.nodes.map((id) => {
      const n = d.nodes.get(id)!;
      return this.project(n.lat, n.lon);
    });
    let endNodes = [w.nodes[0], w.nodes[w.nodes.length - 1]];
    if (model.oneway === '-1') {
      pts = pts.slice().reverse();
      endNodes = endNodes.reverse();
      model.oneway = 'yes';
    }
    const slots = layoutLanes(w.tags, model, this.opts.drivingSide);
    const b: Built = {
      way: w, pts, slots, asphalt: [], asphaltColor: surfaceColor(w.tags), triSlot: [],
      white: [], centre: [], decor: new THREE.Group(),
    };
    if (pts.length < 2) return b;

    // Asphalt, one strip per lane so picks resolve to a lane.
    slots.forEach((s, i) => {
      const n = strip(b.asphalt, pts, s.left, s.right, 0);
      for (let k = 0; k < n; k++) b.triSlot.push(i);
    });

    const L = polyLength(pts);
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

    this.buildArrows(b, L, trim);
    this.buildSigns(b, L);
    return b;
  }

  /** Travel-direction polyline for a slot's direction. */
  private travel(b: Built, dir: LaneSlot['dir']): { pts: V2[]; sign: 1 | -1 } {
    return dir === 'backward' ? { pts: b.pts.slice().reverse(), sign: -1 } : { pts: b.pts, sign: 1 };
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
      const off = ((s.left + s.right) / 2) * sign;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      for (const at of positions) {
        const { p, dir } = pointAt(pts, at);
        const nx = -dir.z, nz = dir.x;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(lw * 0.55, 1.8), 5), mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 3;
        const g = new THREE.Group();
        g.add(mesh);
        g.position.set(p.x + nx * off, 0.03, p.z + nz * off);
        g.rotation.y = Math.atan2(-dir.x, -dir.z);
        b.decor.add(g);
      }
    }
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
      const at3 = (off: number, y: number) => new THREE.Vector3(p.x + nx * off, y, p.z + nz * off);

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
    const col = new Float32Array(triCount * 9);
    this.triWay = new Int32Array(triCount);
    this.triSlot = new Int32Array(triCount);
    const white: number[] = [];
    const centre: number[] = [];
    let t = 0;
    for (const b of this.built.values()) {
      pos.set(b.asphalt, t * 9);
      const n = b.asphalt.length / 9;
      for (let i = 0; i < n; i++) {
        this.triWay[t + i] = b.way.id;
        this.triSlot[t + i] = b.triSlot[i] ?? -1;
        for (let v = 0; v < 3; v++) {
          col[(t + i) * 9 + v * 3] = b.asphaltColor.r;
          col[(t + i) * 9 + v * 3 + 1] = b.asphaltColor.g;
          col[(t + i) * 9 + v * 3 + 2] = b.asphaltColor.b;
        }
      }
      t += n;
      for (const v of b.white) white.push(v);
      for (const v of b.centre) centre.push(v);
      this.decor.add(b.decor);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
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
