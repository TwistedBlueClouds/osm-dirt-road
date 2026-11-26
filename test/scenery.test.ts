import { test } from 'node:test';
import assert from 'node:assert/strict';
import { housePlacements } from '../src/scenery.ts';

// 1 degree ≈ 100 km here; the projection just scales lon/lat to metres.
const project = (lat: number, lon: number) => ({ x: lon * 1e5, z: -lat * 1e5 });
const rect = (w: number, d: number, tags: Record<string, string>) => ({
  tags, inners: [],
  outer: [[0, 0], [w / 1e5, 0], [w / 1e5, d / 1e5], [0, d / 1e5], [0, 0]] as [number, number][],
});
const native = new Map([['house-a', { x: 1.3, y: 0.8, z: 1 }], ['house-k', { x: 0.9, y: 1.1, z: 1 }]]) as never;
const road = [{ x: 5, z: 30 }];

test('a plain rectangular house becomes a model stretched to its outline', () => {
  const b = rect(12, 8, { building: 'house' });
  const { placements, replaced } = housePlacements([b], project, native, road);
  assert.equal(placements.length, 1);
  assert.ok(replaced.has(b));
  const box = placements[0].box!;
  assert.deepEqual([box[0], box[2]].map((v) => Math.round(v)).sort((a, c) => a - c), [8, 12]);
  assert.ok(Math.abs(placements[0].x - 6) < 0.01 && Math.abs(placements[0].z + 4) < 0.01);
});

test('houses described in 3D, odd shapes and other building types keep their real outline', () => {
  const lShape = { tags: { building: 'house' }, inners: [], outer: [[0, 0], [12e-5, 0], [12e-5, 4e-5], [4e-5, 4e-5], [4e-5, 12e-5], [0, 12e-5], [0, 0]] as [number, number][] };
  const list = [
    rect(12, 8, { building: 'house', 'roof:shape': 'gabled' }),
    rect(12, 8, { building: 'house', height: '7' }),
    rect(12, 8, { building: 'apartments' }),
    rect(40, 30, { building: 'house' }),
    lShape,
  ];
  assert.equal(housePlacements(list, project, native, road).placements.length, 0);
});
