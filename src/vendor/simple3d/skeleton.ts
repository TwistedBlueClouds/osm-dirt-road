// Stub for osm-simple3d-editor's straight-skeleton module (see README.md): no solver is
// bundled, so `skeletonOf` reports "no skeleton" and such roofs are drawn flat.
import type { Pt } from './building-geometry';

export interface Skeleton {
  /** x, y and "time": distance to the nearest side of the outline. */
  vertices: [number, number, number][];
  /** Faces: each rests on one side of the outline; vertices are indices into `vertices`. */
  polygons: number[][];
}

export function skeletonOf(_outer: Pt[], _inners: Pt[][], _stabilize?: boolean): Skeleton | 'pending' | null {
  return null;
}
