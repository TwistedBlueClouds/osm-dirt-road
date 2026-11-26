// Read-only surroundings: buildings (Simple 3D Buildings tags) and trees.
// Building walls and roofs come from the vendored osm-simple3d-editor geometry.

import * as THREE from 'three';
import type { Context, Tags } from './osm';
import { buildTriangles, type LocalPolygon, type Pt } from './vendor/simple3d/building-geometry';
import { computeHeights, parseLength } from './vendor/simple3d/heights';

type Project = (lat: number, lon: number) => { x: number; z: number };

const WALL = new THREE.Color(0xd8d2c8);
const ROOF = new THREE.Color(0x8d8a86);

const NAMED: Record<string, number> = {
  white: 0xf2f2f2, black: 0x2b2b2b, grey: 0x8c8c8c, gray: 0x8c8c8c, red: 0xa8463c, brown: 0x7a5a44,
  yellow: 0xe0c060, green: 0x5f8a5a, blue: 0x5f7fa8, beige: 0xd9cbb0, orange: 0xd08840, silver: 0xb8bcc0,
};

function colour(v: string | undefined, def: THREE.Color): THREE.Color {
  if (!v) return def;
  const k = v.trim().toLowerCase();
  if (k in NAMED) return new THREE.Color(NAMED[k]);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(k)) return new THREE.Color(k);
  return def;
}

/** Vendored geometry is (x east, y north, z up); the scene is (x east, y up, z south). */
function pushTris(src: number[], pos: number[], col: number[], c: THREE.Color) {
  for (let i = 0; i < src.length; i += 3) {
    pos.push(src[i], src[i + 2], -src[i + 1]);
    col.push(c.r, c.g, c.b);
  }
}

export function buildBuildings(ctx: Context, project: Project): THREE.Mesh | null {
  const pos: number[] = [];
  const col: number[] = [];
  for (const b of ctx.buildings) {
    const local = (ring: [number, number][]): Pt[] => {
      const pts = ring.map(([lon, lat]) => {
        const p = project(lat, lon);
        return [p.x, -p.z] as Pt;
      });
      // Closed OSM rings repeat the first node; the geometry code wants it once.
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      return pts;
    };
    const poly: LocalPolygon = { outer: local(b.outer), inners: b.inners.map(local) };
    if (poly.outer.length < 3) continue;
    try {
      const tris = buildTriangles([poly], computeHeights(b.tags), b.tags);
      pushTris(tris.walls, pos, col, colour(b.tags['building:colour'] ?? b.tags['building:color'], WALL));
      pushTris(tris.roof, pos, col, colour(b.tags['roof:colour'] ?? b.tags['roof:color'], ROOF));
    } catch {
      // A degenerate outline shouldn't take the whole scene down.
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  return mesh;
}

function hash(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function treeHeight(tags: Tags, r: number): number {
  const h = parseLength(tags.height);
  return h !== undefined && h > 1 && h < 60 ? h : 7 + r * 5;
}

export function buildTrees(ctx: Context, project: Project): THREE.Group | null {
  if (!ctx.trees.length) return null;
  const broad = ctx.trees.filter((t) => t.tags.leaf_type !== 'needleleaved');
  const needle = ctx.trees.filter((t) => t.tags.leaf_type === 'needleleaved');
  const group = new THREE.Group();
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4f3a });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const add = (list: typeof ctx.trees, crown: THREE.BufferGeometry, crownColor: number, crownAt: number, crownH: number) => {
    if (!list.length) return;
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.18, 1, 6), trunkMat, list.length);
    const crowns = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ color: 0xffffff }), list.length);
    const tint = new THREE.Color();
    list.forEach((t, i) => {
      const p = project(t.lat, t.lon);
      const r = hash(t.lon * 1e4, t.lat * 1e4);
      const h = treeHeight(t.tags, r);
      const trunkH = h * crownAt;
      m.compose(new THREE.Vector3(p.x, trunkH / 2, p.z), q, new THREE.Vector3(1 + h / 12, trunkH, 1 + h / 12));
      trunks.setMatrixAt(i, m);
      const ch = h * crownH;
      const cw = h * 0.33 * (0.85 + r * 0.3);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 6.28);
      m.compose(new THREE.Vector3(p.x, h - ch / 2, p.z), q, new THREE.Vector3(cw, ch / 2, cw));
      q.identity();
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, tint.set(crownColor).offsetHSL(0, 0, (r - 0.5) * 0.12));
    });
    trunks.frustumCulled = crowns.frustumCulled = false;
    group.add(trunks, crowns);
  };
  add(broad, new THREE.IcosahedronGeometry(1, 1), 0x5f8f4e, 0.45, 0.7);
  add(needle, new THREE.ConeGeometry(0.8, 2, 7), 0x3f6f4a, 0.25, 0.85);
  return group;
}
