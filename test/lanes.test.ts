import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutLanes, mayChange, parseRoad, validate, writeRoad } from '../src/lanes.ts';

test('parses a one-way road with turn and destination lanes', () => {
  const m = parseRoad({
    highway: 'primary', oneway: 'yes', lanes: '3',
    'turn:lanes': 'left|through|through;right',
    'destination:lanes': 'Berlin|Hamburg;Kiel|Hamburg;Kiel',
    'change:lanes': 'not_right|yes|not_left',
  });
  assert.equal(m.oneway, 'yes');
  assert.equal(m.forward.length, 3);
  assert.equal(m.backward.length, 0);
  assert.equal(m.forward[2].turn, 'through;right');
  assert.equal(m.forward[1].destination, 'Hamburg;Kiel');
  assert.equal(m.forward[0].change, 'not_right');
});

test('two-way road splits lanes and keeps per-direction tags', () => {
  const m = parseRoad({
    highway: 'secondary', lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1',
    'turn:lanes:forward': 'left|through', 'turn:lanes:backward': 'through;right',
  });
  assert.equal(m.forward.length, 2);
  assert.equal(m.backward.length, 1);
  assert.equal(m.backward[0].turn, 'through;right');
});

test('motorway is implicitly one-way and no lanes tag implies 1 lane', () => {
  const m = parseRoad({ highway: 'motorway' });
  assert.equal(m.oneway, 'yes');
  assert.equal(m.forward.length, 1);
  assert.ok(m.implied);
});

test('lanes count inferred from turn:lanes when lanes is missing', () => {
  const m = parseRoad({ highway: 'primary', oneway: 'yes', 'turn:lanes': 'left|through|right' });
  assert.equal(m.forward.length, 3);
});

test('round-trip write is stable and drops empty per-lane tags', () => {
  const tags = {
    highway: 'primary', oneway: 'yes', lanes: '2', name: 'Main St',
    'turn:lanes': 'left|through', 'width:lanes': '|',
  };
  const out = writeRoad(tags, parseRoad(tags));
  assert.deepEqual(out, { highway: 'primary', oneway: 'yes', lanes: '2', name: 'Main St', 'turn:lanes': 'left|through' });
});

test('adding a lane on a two-way road writes forward/backward counts', () => {
  const tags = { highway: 'tertiary', lanes: '2' };
  const m = parseRoad(tags);
  m.forward.push({ turn: 'right', destination: '', 'destination:ref': '', change: '', width: '' });
  m.forward[0].turn = 'through';
  const out = writeRoad(tags, m);
  assert.equal(out.lanes, '3');
  assert.equal(out['lanes:forward'], '2');
  assert.equal(out['lanes:backward'], '1');
  assert.equal(out['turn:lanes:forward'], 'through|right');
  assert.equal(out['turn:lanes:backward'], undefined);
});

test('converting to one-way rewrites :forward keys to plain :lanes', () => {
  const tags = { highway: 'primary', lanes: '2', 'turn:lanes:forward': 'through', 'turn:lanes:backward': 'through' };
  const m = parseRoad(tags);
  m.oneway = 'yes';
  const out = writeRoad(tags, m);
  assert.equal(out.oneway, 'yes');
  assert.equal(out.lanes, '1');
  assert.equal(out['turn:lanes'], 'through');
  assert.equal(out['turn:lanes:forward'], undefined);
  assert.equal(out['turn:lanes:backward'], undefined);
});

test('does not add redundant oneway=yes on motorways', () => {
  const tags = { highway: 'motorway', lanes: '2' };
  const out = writeRoad(tags, parseRoad(tags));
  assert.equal(out.oneway, undefined);
});

test('centre turn lane', () => {
  const tags = { highway: 'primary', lanes: '3', 'lanes:both_ways': '1', 'turn:lanes:both_ways': 'left' };
  const m = parseRoad(tags);
  assert.equal(m.forward.length, 1);
  assert.equal(m.backward.length, 1);
  assert.equal(m.bothWays?.turn, 'left');
  const slots = layoutLanes(tags, m, 'right');
  assert.deepEqual(slots.map((s) => s.dir), ['backward', 'both_ways', 'forward']);
  assert.deepEqual(writeRoad(tags, m), { ...tags, 'lanes:forward': '1', 'lanes:backward': '1' });
});

test('layout respects driving side and placement', () => {
  const tags = { highway: 'primary', lanes: '2', 'width:lanes:forward': '3', 'width:lanes:backward': '3' };
  const m = parseRoad(tags);
  const rht = layoutLanes(tags, m, 'right');
  assert.equal(rht[1].dir, 'forward');
  assert.equal(rht[0].left, -3);
  const lht = layoutLanes(tags, m, 'left');
  assert.equal(lht[0].dir, 'forward');

  const ow = { highway: 'primary', oneway: 'yes', lanes: '2', placement: 'right_of:1', 'width:lanes': '3|3' };
  const s = layoutLanes(ow, parseRoad(ow), 'right');
  assert.equal(s[0].left, -3);
  assert.equal(s[1].right, 3);
});

test('change semantics', () => {
  const l = { turn: '', destination: '', 'destination:ref': '', change: 'not_left', width: '' };
  assert.equal(mayChange(l, 'left'), false);
  assert.equal(mayChange(l, 'right'), true);
});

test('validation flags count mismatch and bad values', () => {
  const w = validate({ highway: 'primary', oneway: 'yes', lanes: '2', 'turn:lanes': 'left|through|rihgt' });
  assert.ok(w.some((x) => x.text.includes('has 3 values, expected 2')));
  assert.ok(w.some((x) => x.text.includes('rihgt')));
});
