// Low-poly models (Kenney kits, CC0; see public/models/kenney/README.md): cars, trees and
// street lamps, drawn as instanced meshes.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface Def {
  file: string;
  /**
   * Normalise so this dimension is 1: placements then scale in metres. 'box' squashes the
   * model into a unit cube so a placement can give width, height and depth separately.
   */
  unit: 'length' | 'height' | 'width' | 'box';
  /** Default size in metres along `unit`. */
  size: number;
  /** Recolour materials whose name starts with "leafs" (the kit's leaves are teal). */
  leaf?: number;
  bark?: number;
}

const rail = (file: string): Def => ({ file: `trains/${file}.glb`, unit: 'width', size: 2.65 });
const boat = (file: string, size: number): Def => ({ file: `boats/${file}.glb`, unit: 'length', size });
const house = (letter: string): Def => ({ file: `houses/building-type-${letter}.glb`, unit: 'box', size: 1 });
const car = (file: string, size: number): Def => ({ file: `cars/${file}.glb`, unit: 'length', size });
const tree = (file: string, leaf: number): Def => ({ file: `trees/${file}.glb`, unit: 'height', size: 9, leaf, bark: 0x6b4a36 });

export const MODELS = {
  sedan: car('sedan', 4.5),
  'sedan-sports': car('sedan-sports', 4.5),
  hatchback: car('hatchback-sports', 4.1),
  suv: car('suv', 4.7),
  'suv-luxury': car('suv-luxury', 4.9),
  van: car('van', 5.2),
  taxi: car('taxi', 4.5),
  delivery: car('delivery', 6.2),
  truck: car('truck', 6.6),
  'tree-default': tree('tree_default', 0x5c9a4c),
  'tree-oak': tree('tree_oak', 0x4f8a43),
  'tree-detailed': tree('tree_detailed', 0x619f52),
  'tree-fat': tree('tree_fat', 0x579447),
  'tree-tall': tree('tree_tall', 0x4a8544),
  'tree-thin': tree('tree_thin', 0x66a355),
  'tree-cone': tree('tree_cone', 0x3f7a48),
  'tree-pine-round': tree('tree_pineRoundA', 0x35694a),
  'tree-pine-tall': tree('tree_pineTallA', 0x2f6245),
  'tree-palm': tree('tree_palmTall', 0x5c9a4c),
  lamp: { file: 'street/light-curved.glb', unit: 'height', size: 8 } as Def,
  bench: { file: 'props/bench.glb', unit: 'length', size: 1.8 } as Def,
  'tram-modern': rail('train-tram-modern'),
  'tram-classic': rail('train-tram-classic'),
  'tram-round': rail('train-tram-round'),
  'train-city-a': rail('train-electric-city-a'),
  'train-city-b': rail('train-electric-city-b'),
  'train-city-c': rail('train-electric-city-c'),
  'train-subway-a': rail('train-electric-subway-a'),
  'train-subway-b': rail('train-electric-subway-b'),
  'train-subway-c': rail('train-electric-subway-c'),
  'boat-row': boat('boat-row-small', 4),
  'boat-sail': boat('boat-sail-a', 9),
  'boat-speed-a': boat('boat-speed-a', 7),
  'boat-speed-d': boat('boat-speed-d', 7),
  'boat-tug': boat('boat-tug-a', 14),
  'boat-house': boat('boat-house-a', 12),
  'house-a': house('a'), 'house-b': house('b'), 'house-c': house('c'), 'house-d': house('d'),
  'house-e': house('e'), 'house-f': house('f'), 'house-g': house('g'), 'house-h': house('h'),
  'house-i': house('i'), 'house-j': house('j'), 'house-k': house('k'), 'house-l': house('l'),
} satisfies Record<string, Def>;

export type ModelName = keyof typeof MODELS;

export const CARS: ModelName[] = ['sedan', 'sedan-sports', 'hatchback', 'suv', 'suv-luxury', 'sedan', 'hatchback', 'van'];
export const LARGE_VEHICLES: ModelName[] = ['van', 'delivery', 'truck'];
export const BROADLEAF: ModelName[] = ['tree-default', 'tree-oak', 'tree-detailed', 'tree-fat', 'tree-tall', 'tree-thin'];
export const TRAMS: ModelName[] = ['tram-modern', 'tram-classic', 'tram-round'];
export const TRAINS: ModelName[][] = [['train-city-a', 'train-city-b', 'train-city-c'], ['train-subway-a', 'train-subway-b', 'train-subway-c']];
export const BOATS: ModelName[] = ['boat-row', 'boat-sail', 'boat-speed-a', 'boat-speed-d', 'boat-tug', 'boat-house', 'boat-row', 'boat-speed-a'];
export const HOUSES: ModelName[] = ['house-a', 'house-b', 'house-c', 'house-d', 'house-e', 'house-f', 'house-g', 'house-h', 'house-i', 'house-j', 'house-k', 'house-l'];
export const CONIFERS: ModelName[] = ['tree-cone', 'tree-pine-round', 'tree-pine-tall'];

export interface Placement {
  model: ModelName;
  x: number;
  y: number;
  z: number;
  /** Rotation about the vertical axis; 0 points the model's front along +z. */
  heading: number;
  /** Size in metres along the model's unit dimension (default: the model's own). */
  size?: number;
  /** Width (x), height (y) and depth (z) in metres, for 'box' models. */
  box?: [number, number, number];
  /** Lightness tweak, −1…1, for variety between instances. */
  shade?: number;
}

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** Deterministic 0…1 value from two numbers. */
export function hash2(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class ModelLibrary {
  private parts = new Map<ModelName, Part[]>();
  /** Each model's own width, height and depth before normalising (proportions only). */
  readonly native = new Map<ModelName, THREE.Vector3>();
  private loading: Promise<void> | null = null;
  ready = false;

  /** Load every model once. Resolves even if some fail (those are simply not drawn). */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    const loader = new GLTFLoader();
    const base = new URL('models/kenney/', document.baseURI).href;
    const jobs = (Object.keys(MODELS) as ModelName[]).map(async (name) => {
      const def: Def = MODELS[name];
      try {
        const gltf = await loader.loadAsync(base + def.file);
        const n = normalise(gltf.scene, def);
        this.parts.set(name, n.parts);
        this.native.set(name, n.size);
      } catch (e) {
        console.warn(`Model ${def.file} could not be loaded`, e);
      }
    });
    this.loading = Promise.all(jobs).then(() => {
      this.ready = true;
    });
    return this.loading;
  }

  /** Size in metres of a model along its unit dimension. */
  sizeOf(name: ModelName): number {
    return (MODELS[name] as Def).size;
  }

  /** Empty instanced meshes for one model, to be filled and moved every frame. */
  createInstanced(name: ModelName, capacity: number): THREE.InstancedMesh[] {
    return (this.parts.get(name) ?? []).map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      return mesh;
    });
  }

  /** Instanced meshes for a set of placements. */
  build(placements: Placement[]): THREE.Group {
    const group = new THREE.Group();
    const by = new Map<ModelName, Placement[]>();
    for (const p of placements) (by.get(p.model) ?? by.set(p.model, []).get(p.model)!).push(p);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    for (const [name, list] of by) {
      const parts = this.parts.get(name);
      if (!parts) continue;
      const def: Def = MODELS[name];
      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((p, i) => {
          const s = p.size ?? def.size;
          q.setFromAxisAngle(up, p.heading);
          m.compose(new THREE.Vector3(p.x, p.y, p.z), q, p.box ? new THREE.Vector3(...p.box) : new THREE.Vector3(s, s, s));
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, tint.setScalar(1 + (p.shade ?? 0) * 0.18));
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        group.add(mesh);
      }
    }
    return group;
  }
}

/**
 * Flatten a loaded model into parts with baked transforms: centred on the ground,
 * scaled so its unit dimension is 1, materials swapped for cheap Lambert ones.
 */
function normalise(scene: THREE.Object3D, def: Def): { parts: Part[]; size: THREE.Vector3 } {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const k = 1 / ((def.unit === 'length' ? Math.max(size.x, size.z) : def.unit === 'width' ? Math.min(size.x, size.z) : size.y) || 1);
  const scale = def.unit === 'box' ? new THREE.Matrix4().makeScale(1 / (size.x || 1), 1 / (size.y || 1), 1 / (size.z || 1)) : new THREE.Matrix4().makeScale(k, k, k);
  const fix = scale.multiply(new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));
  const mats = new Map<THREE.Material, THREE.Material>();
  const parts: Part[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(fix, mesh.matrixWorld));
    const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    let material = mats.get(src);
    if (!material) {
      const leaf = /^leaf/i.test(src.name);
      const bark = /^wood/i.test(src.name);
      material = new THREE.MeshLambertMaterial({
        map: src.map ?? null,
        color: leaf && def.leaf !== undefined ? def.leaf : bark && def.bark !== undefined ? def.bark : src.color,
      });
      mats.set(src, material);
    }
    parts.push({ geometry, material });
  });
  return { parts, size };
}
