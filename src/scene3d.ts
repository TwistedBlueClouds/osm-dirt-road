// Three.js scene: renders every loaded road with lanes, markings, turn arrows
// and destination gantries, and lets the user pick a way / lane.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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

type V2 = { x: number; z: number };

// ---------------------------------------------------------------------------
// Polyline helpers (x/z plane, metres)

function segLen(a: V2, b: V2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function polyLength(p: V2[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += segLen(p[i - 1], p[i]);
  return s;
}

/** Right-hand normal at each vertex, miter-scaled (clamped) so offsets stay parallel. */
function vertexNormals(p: V2[]): V2[] {
  const n = p.length;
  const segN: V2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i + 1].x - p[i].x;
    const dz = p[i + 1].z - p[i].z;
    const l = Math.hypot(dx, dz) || 1;
    segN.push({ x: -dz / l, z: dx / l });
  }
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = segN[Math.max(0, i - 1)];
    const b = segN[Math.min(n - 2, i)];
    let x = a.x + b.x;
    let z = a.z + b.z;
    const l = Math.hypot(x, z);
    if (l < 1e-6) {
      out.push(b);
      continue;
    }
    x /= l;
    z /= l;
    const cos = x * b.x + z * b.z;
    const scale = Math.min(1 / Math.max(cos, 1e-3), 3);
    out.push({ x: x * scale, z: z * scale });
  }
  return out;
}

/** Sub-polyline between arc-lengths s0..s1. */
function slice(p: V2[], s0: number, s1: number): V2[] {
  const out: V2[] = [];
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const l = segLen(a, b);
    const e = acc + l;
    if (e >= s0 && acc <= s1 && l > 0) {
      const t0 = Math.max(0, (s0 - acc) / l);
      const t1 = Math.min(1, (s1 - acc) / l);
      const pa = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const pb = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      if (!out.length) out.push(pa);
      out.push(pb);
    }
    acc = e;
    if (acc > s1) break;
  }
  return out;
}

function pointAt(p: V2[], s: number): { p: V2; dir: V2 } {
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const l = segLen(a, b);
    if (acc + l >= s || i === p.length - 1) {
      const t = l > 0 ? Math.min(1, Math.max(0, (s - acc) / l)) : 0;
      return {
        p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t },
        dir: { x: (b.x - a.x) / (l || 1), z: (b.z - a.z) / (l || 1) },
      };
    }
    acc += l;
  }
  return { p: p[0], dir: { x: 0, z: -1 } };
}

/** Push a flat ribbon between lateral offsets a..b (triangles, xyz). */
function strip(out: number[], p: V2[], a: number, b: number, y: number): number {
  if (p.length < 2) return 0;
  const n = vertexNormals(p);
  let tris = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const a0x = p[i].x + n[i].x * a, a0z = p[i].z + n[i].z * a;
    const b0x = p[i].x + n[i].x * b, b0z = p[i].z + n[i].z * b;
    const a1x = p[i + 1].x + n[i + 1].x * a, a1z = p[i + 1].z + n[i + 1].z * a;
    const b1x = p[i + 1].x + n[i + 1].x * b, b1z = p[i + 1].z + n[i + 1].z * b;
    out.push(a0x, y, a0z, a1x, y, a1z, b0x, y, b0z);
    out.push(b0x, y, b0z, a1x, y, a1z, b1x, y, b1z);
    tris += 2;
  }
  return tris;
}

function line(out: number[], p: V2[], offset: number, width: number, y: number, dash?: [number, number], trim = [0, 0]) {
  const L = polyLength(p);
  const s0 = trim[0];
  const s1 = L - trim[1];
  if (s1 - s0 < 0.5) return;
  if (!dash) {
    strip(out, slice(p, s0, s1), offset - width / 2, offset + width / 2, y);
    return;
  }
  const [on, off] = dash;
  for (let s = s0; s < s1; s += on + off) {
    const sub = slice(p, s, Math.min(s + on, s1));
    strip(out, sub, offset - width / 2, offset + width / 2, y);
  }
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

export class LaneScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private data: OsmData | null = null;
  private origin = { lat: 0, lon: 0 };
  private built = new Map<number, Built>();
  private degree = new Map<number, number>();
  private roads = new THREE.Group();
  private decor = new THREE.Group();
  private highlight = new THREE.Group();
  private asphaltMesh: THREE.Mesh | null = null;
  private triWay: Int32Array = new Int32Array(0);
  private triSlot: Int32Array = new Int32Array(0);
  private selected: { wayId: number; lane: LaneRef | null } | null = null;
  private anim: { t0: number; from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3] } | null = null;
  private needsRender = true;
  opts: SceneOptions;

  private matAsphalt = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private matWhite = new THREE.MeshBasicMaterial({ color: 0xf2f2ee, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private matCentre = new THREE.MeshBasicMaterial({ color: 0xf2c21b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private matSel = new THREE.MeshBasicMaterial({ color: 0x29b6f6, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private matSelLane = new THREE.MeshBasicMaterial({ color: 0xff9800, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private matSteel = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
  private matSignBack = new THREE.MeshLambertMaterial({ color: 0x6b7075 });

  constructor(private container: HTMLElement, opts: SceneOptions, private onPick: (r: PickResult | null) => void) {
    this.opts = opts;
    this.matCentre.color.set(opts.centreLine === 'yellow' ? 0xf2c21b : 0xf2f2ee);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xbcd4e6);
    this.scene.fog = new THREE.Fog(0xbcd4e6, 600, 2200);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 5000);
    this.camera.position.set(0, 300, 300);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556655, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(200, 400, 120);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      // Drawn first and never written to depth, so roads can't z-fight with it.
      new THREE.MeshLambertMaterial({ color: 0x9fb08a, depthWrite: false }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.renderOrder = -1;
    this.scene.add(ground);
    this.scene.add(this.roads, this.decor, this.highlight);

    this.installPicking();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  private tick() {
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / 700);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.camera.position.lerpVectors(this.anim.from[0], this.anim.to[0], e);
      this.controls.target.lerpVectors(this.anim.from[1], this.anim.to[1], e);
      if (t >= 1) this.anim = null;
      this.needsRender = true;
    }
    if (this.controls.update()) this.needsRender = true;
    if (this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }

  private installPicking() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      down = null;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      if (!this.asphaltMesh) return;
      const hit = ray.intersectObject(this.asphaltMesh, false)[0];
      if (!hit || hit.faceIndex == null) {
        this.onPick(null);
        return;
      }
      const wayId = this.triWay[hit.faceIndex];
      const b = this.built.get(wayId);
      const si = this.triSlot[hit.faceIndex];
      this.onPick({ wayId, slot: b && si >= 0 ? b.slots[si] : null });
    });
  }

  setOptions(o: Partial<SceneOptions>) {
    this.opts = { ...this.opts, ...o };
    this.matCentre.color.set(this.opts.centreLine === 'yellow' ? 0xf2c21b : 0xf2f2ee);
    if (this.data) this.rebuildAll();
  }

  project(lat: number, lon: number): V2 {
    const R = 6378137;
    const k = Math.cos((this.origin.lat * Math.PI) / 180);
    return {
      x: ((lon - this.origin.lon) * Math.PI / 180) * R * k,
      z: -((lat - this.origin.lat) * Math.PI / 180) * R,
    };
  }

  setData(data: OsmData, centre: { lat: number; lon: number }) {
    this.data = data;
    this.origin = centre;
    this.degree.clear();
    for (const w of data.ways.values()) {
      w.nodes.forEach((n, i) => {
        const inc = i === 0 || i === w.nodes.length - 1 ? 1 : 2;
        this.degree.set(n, (this.degree.get(n) ?? 0) + inc);
      });
    }
    this.selected = null;
    this.rebuildAll();
    this.overview();
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
    g.computeVertexNormals();
    this.asphaltMesh?.geometry.dispose();
    this.asphaltMesh = new THREE.Mesh(g, this.matAsphalt);
    this.roads.add(this.asphaltMesh);
    for (const [arr, mat] of [[white, this.matWhite], [centre, this.matCentre]] as const) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      this.roads.add(new THREE.Mesh(lg, mat));
    }
    this.drawHighlight();
    this.needsRender = true;
  }

  /** Highlight a way and optionally one of its lanes (by OSM direction + index). */
  select(wayId: number | null, lane: LaneRef | null = null) {
    this.selected = wayId == null ? null : { wayId, lane };
    this.drawHighlight();
  }

  private drawHighlight() {
    this.highlight.children.forEach((c) => (c as THREE.Mesh).geometry.dispose());
    this.highlight.clear();
    this.needsRender = true;
    if (!this.selected) return;
    const b = this.built.get(this.selected.wayId);
    if (!b || !b.slots.length) return;
    const all: number[] = [];
    strip(all, b.pts, b.slots[0].left - 0.4, b.slots[b.slots.length - 1].right + 0.4, 0.01);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
    this.highlight.add(new THREE.Mesh(g, this.matSel));
    const ref = this.selected.lane;
    const s = ref && b.slots.find((x) => x.dir === ref.dir && x.index === ref.index);
    if (s) {
      const one: number[] = [];
      strip(one, b.pts, s.left, s.right, 0.012);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(one, 3));
      this.highlight.add(new THREE.Mesh(lg, this.matSelLane));
    }
  }

  /** Fly the camera to a way, looking along its travel direction. */
  focus(wayId: number) {
    const b = this.built.get(wayId);
    if (!b || b.pts.length < 2) return;
    const L = polyLength(b.pts);
    const { p, dir } = pointAt(b.pts, L * 0.5);
    const back = Math.min(Math.max(L * 0.45, 30), 120);
    const target = new THREE.Vector3(p.x + dir.x * back * 0.3, 0, p.z + dir.z * back * 0.3);
    const cam = new THREE.Vector3(p.x - dir.x * back, back * 0.45 + 8, p.z - dir.z * back);
    this.anim = {
      t0: performance.now(),
      from: [this.camera.position.clone(), this.controls.target.clone()],
      to: [cam, target],
    };
  }

  overview() {
    let r = 200;
    for (const b of this.built.values()) for (const p of b.pts) r = Math.max(r, Math.hypot(p.x, p.z));
    r = Math.min(r, 1500);
    this.anim = {
      t0: performance.now(),
      from: [this.camera.position.clone(), this.controls.target.clone()],
      to: [new THREE.Vector3(0, r * 0.8, r * 0.7), new THREE.Vector3(0, 0, 0)],
    };
  }
}
