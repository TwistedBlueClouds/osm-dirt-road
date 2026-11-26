import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutLanes, parseRoad } from '../src/lanes.ts';
import { connectionsFrom, solveJunctions, type WayGeo } from '../src/junctions.ts';
import { TrafficSim } from '../src/traffic.ts';

type P = [number, number];
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

/** A one-way street heading north in two pieces, 30 then 50 km/h. */
function street(signals = false) {
  const geos = new Map<number, WayGeo>([
    [10, geo(10, [2, 1], [[0, 200], [0, 0]], { highway: 'residential', oneway: 'yes', lanes: '1', maxspeed: '30' })],
    [11, geo(11, [1, 3], [[0, 0], [0, -200]], { highway: 'primary', oneway: 'yes', lanes: '1', maxspeed: '50' })],
  ]);
  const { armsAt } = solveJunctions(geos, new Map());
  const sim = new TrafficSim();
  sim.build(geos, (id) => connectionsFrom(geos.get(id)!, armsAt, [], 'right'), (g, end) => signals && g.way.id === 10 && end === 'end', [{ length: 4.5, weight: 1 }]);
  return sim;
}

const run = (sim: TrafficSim, seconds: number) => {
  for (let t = 0; t < seconds; t += 0.05) sim.step(0.05);
};

test('lanes become segments joined by a link, with speeds from maxspeed', () => {
  const sim = street();
  const lanes = sim.segs.filter((s) => s.kind === 'lane');
  assert.equal(lanes.length, 2);
  assert.equal(sim.segs.filter((s) => s.kind === 'link').length, 1);
  assert.deepEqual(lanes.map((l) => Math.round(l.speed * 3.6)).sort(), [30, 50]);
});

test('a car keeps to the limit and carries on into the next road', () => {
  const sim = street();
  sim.populate(1000); // fill, then keep one car
  const car = sim.cars[0];
  for (const c of sim.cars.slice(1)) sim.segs[c.seg].cars.splice(sim.segs[c.seg].cars.indexOf(c), 1);
  sim.cars.length = 1;
  const first = sim.segs.find((s) => s.kind === 'lane' && Math.round(s.speed * 3.6) === 30)!;
  sim.segs[car.seg].cars.length = 0;
  Object.assign(car, { seg: first.id, s: 5, v: 0, next: -1 });
  first.cars.push(car);
  run(sim, 12);
  assert.ok(car.v <= (30 / 3.6) * 1.07 && car.v > 6, `speed ${car.v}`);
  assert.equal(car.seg, first.id);
  run(sim, 30);
  const second = sim.segs.find((s) => s.kind === 'lane' && Math.round(s.speed * 3.6) === 50)!;
  assert.equal(car.seg, second.id);
  assert.ok(car.v > 30 / 3.6, 'speeds up to the higher limit');
  assert.ok(car.z < 0 && Math.abs(car.x) < 0.01, 'travelling north on the lane centre');
});

test('cars queue instead of overlapping, and wait at a red signal', () => {
  const sim = street(true);
  sim.populate(60);
  const first = sim.segs.find((s) => s.kind === 'lane' && s.signal)!;
  // With one road feeding it this is a pedestrian-crossing signal: a short red each cycle.
  assert.ok(first.crossingOnly);
  const green = () => sim.green(first.phase, first.group, first.crossingOnly);
  run(sim, 60);
  while (green()) sim.step(0.05);
  // Step to just before the red ends.
  while (!green()) sim.step(0.05);
  sim.time -= 0.05;
  for (const seg of sim.segs) {
    const cs = seg.cars.slice().sort((a, b) => b.s - a.s);
    for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].s - cs[i].s >= cs[i].len - 0.01, 'no overlap');
  }
  const front = first.cars.slice().sort((a, b) => b.s - a.s)[0];
  assert.ok(front && front.v < 0.5 && front.s > first.length - 6, 'front car is stopped at the line');
});

test('cars can turn off and join where a side road meets the middle of a road', () => {
  const geos = new Map<number, WayGeo>([
    [20, geo(20, [1, 2, 3], [[-100, 0], [0, 0], [100, 0]], { highway: 'primary', lanes: '2' })],
    [21, geo(21, [2, 4], [[0, 0], [0, 80]], { highway: 'residential', lanes: '2' })],
  ]);
  const { armsAt } = solveJunctions(geos, new Map());
  const sim = new TrafficSim();
  sim.build(geos, (id) => connectionsFrom(geos.get(id)!, armsAt, [], 'right'), () => false, [{ length: 4.5, weight: 1 }], armsAt);
  // Main road: 2 lanes, each cut in two at the side road. Side road: 2 lanes.
  assert.equal(sim.segs.filter((s) => s.kind === 'lane').length, 6);
  const links = sim.segs.filter((s) => s.kind === 'link');
  // Off the main road into the side road from each direction, and out of the side road both ways.
  assert.equal(links.length, 4);
  assert.equal(links.filter((l) => l.merge).length, 2, 'joining links land part-way along the main road');
  // Each main-road stretch before the junction can carry on or turn off; the side road can go either way.
  assert.equal(sim.segs.filter((s) => s.kind === 'lane' && s.next.length === 2).length, 3);
  sim.populate(15);
  for (let t = 0; t < 600; t += 0.1) sim.step(0.1);
  const moving = sim.cars.filter((c) => c.v > 1).length;
  assert.ok(moving >= sim.cars.length * 0.5, `still flowing after 10 minutes (${moving}/${sim.cars.length})`);
});
