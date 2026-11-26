import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutLanes, parseRoad } from '../src/lanes.ts';
import { connectionsFrom, formatConnectivity, solveJunctions, type WayGeo } from '../src/junctions.ts';

type P = [number, number];

/** Minimal WayGeo from node ids, local coordinates (x east, z south) and tags. */
function geo(id: number, nodes: number[], coords: P[], tags: Record<string, string>): WayGeo {
  const pts = coords.map(([x, z]) => ({ x, z, h: 0 }));
  let acc = 0;
  const nodeS = pts.map((p, i) => (i === 0 ? 0 : (acc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z))));
  const slots = layoutLanes(tags, parseRoad(tags), 'right');
  return {
    way: { id, version: 1, nodes, tags, origTags: tags }, pts, L: acc, slots, reversed: false, nodeS,
    startNode: nodes[0], endNode: nodes[nodes.length - 1], left: slots[0].left, right: slots[slots.length - 1].right,
    trim: [0, 0], body: pts,
  };
}

// A crossroads at node 1 (origin). Way 10 arrives from the south heading north (z decreasing).
function crossroads(turn: string) {
  const w = { 'width:lanes': '3|3|3' };
  const geos = new Map<number, WayGeo>([
    [10, geo(10, [2, 1], [[0, 100], [0, 0]], { highway: 'primary', oneway: 'yes', lanes: '3', 'turn:lanes': turn, ...w })],
    [11, geo(11, [1, 3], [[0, 0], [0, -100]], { highway: 'primary', oneway: 'yes', lanes: '2', 'width:lanes': '3|3' })], // north
    [12, geo(12, [1, 4], [[0, 0], [-100, 0]], { highway: 'primary', oneway: 'yes', lanes: '1', 'width:lanes': '3' })], // west
    [13, geo(13, [1, 5], [[0, 0], [100, 0]], { highway: 'primary', oneway: 'yes', lanes: '1', 'width:lanes': '3' })], // east
  ]);
  return geos;
}

test('roads are cut back to where their edges meet at a junction', () => {
  const geos = crossroads('left|through|through;right');
  const { junctions } = solveJunctions(geos, new Map());
  assert.equal(junctions.length, 1);
  assert.equal(junctions[0].arms.length, 4);
  // The 9 m wide approach meets 3 m wide side roads: cut back by their half width.
  assert.ok(Math.abs(geos.get(10)!.trim[1] - 1.5) < 0.01, `trim ${geos.get(10)!.trim[1]}`);
  // Side roads are cut back by the wider of the two roads they sit between.
  assert.ok(Math.abs(geos.get(12)!.trim[0] - 4.5) < 0.01, `trim ${geos.get(12)!.trim[0]}`);
  assert.ok(junctions[0].surface.length > 0);
});

test('lane connections follow turn:lanes', () => {
  const geos = crossroads('left|through|through;right');
  const { armsAt } = solveJunctions(geos, new Map());
  const cs = connectionsFrom(geos.get(10)!, armsAt, [], 'right').map((c) => `${c.from.index + 1}>${c.to.wayId}:${c.to.index + 1}:${c.move}`).sort();
  assert.deepEqual(cs, ['1>12:1:left', '2>11:1:through', '3>11:2:through', '3>13:1:right']);
});

test('without arrows every lane goes straight and the outer lanes may turn', () => {
  const geos = crossroads('');
  const { armsAt } = solveJunctions(geos, new Map());
  const cs = connectionsFrom(geos.get(10)!, armsAt, [], 'right');
  assert.ok(cs.every((c) => c.source === 'default'));
  assert.deepEqual(cs.filter((c) => c.move === 'left').map((c) => c.from.index), [0]);
  assert.deepEqual(cs.filter((c) => c.move === 'right').map((c) => c.from.index), [2]);
  assert.equal(cs.filter((c) => c.move === 'through').length, 3);
});

test('a connectivity relation overrides the worked-out connections', () => {
  const geos = crossroads('left|through|through;right');
  const { armsAt } = solveJunctions(geos, new Map());
  const rel = {
    id: 5, version: 1, orig: null, tags: { type: 'connectivity', connectivity: '2:1,2|3:(2)' },
    members: [{ type: 'way' as const, ref: 10, role: 'from' }, { type: 'node' as const, ref: 1, role: 'via' }, { type: 'way' as const, ref: 11, role: 'to' }],
  };
  const cs = connectionsFrom(geos.get(10)!, armsAt, [rel], 'right').filter((c) => c.to.wayId === 11);
  assert.deepEqual(cs.map((c) => `${c.from.index + 1}>${c.to.index + 1}`).sort(), ['2>1', '2>2', '3>2']);
  assert.ok(cs.every((c) => c.source === 'relation' && c.relationId === 5));
});

test('a side road joining mid-way is cut back without splitting the main road', () => {
  const geos = new Map<number, WayGeo>([
    [20, geo(20, [1, 2, 3], [[-50, 0], [0, 0], [50, 0]], { highway: 'primary', lanes: '2', 'width:lanes:forward': '3.5', 'width:lanes:backward': '3.5' })],
    [21, geo(21, [2, 4], [[0, 0], [0, 60]], { highway: 'residential', lanes: '2' })],
  ]);
  solveJunctions(geos, new Map());
  assert.deepEqual(geos.get(20)!.trim, [0, 0]);
  assert.ok(Math.abs(geos.get(21)!.trim[0] - 3.5) < 0.01);
});

test('connectivity value formatting', () => {
  assert.equal(formatConnectivity(new Map([[2, [2, 1, 2]], [1, [1]], [3, []]])), '1:1|2:1,2');
});
