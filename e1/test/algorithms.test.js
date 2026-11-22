// Unit tests for the three doc 4.18 algorithms: interval tree + sweep-line, DSATUR, conflict classification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IntervalTree, findOverlaps } = require('../src/sweepLine');
const { buildConflictGraph, dsatur } = require('../src/dsatur');
const { classify, pairFacts, rankConflicts, SEVERITY } = require('../src/classify');

const overlap = (a, b) => a.start < b.end && b.start < a.end;
const rand = (n) => Math.floor(Math.random() * n);
const randomIntervals = (n) => Array.from({ length: n }, (_, i) => {
  const start = rand(1000); return { id: i, start, end: start + 1 + rand(60) };
});

test('interval tree: overlaps / firstOverlap / remove match brute force', () => {
  for (let round = 0; round < 20; round++) {
    const ivs = randomIntervals(200);
    const t = new IntervalTree();
    ivs.forEach((iv) => t.insert(iv));
    const removed = new Set(ivs.filter(() => Math.random() < 0.3));
    removed.forEach((iv) => assert.equal(t.remove(iv), true));
    const live = ivs.filter((iv) => !removed.has(iv));
    assert.equal(t.size, live.length);
    for (let q = 0; q < 50; q++) {
      const s = rand(1100), e = s + 1 + rand(80);
      const expected = live.filter((iv) => overlap(iv, { start: s, end: e })).map((iv) => iv.id).sort((a, b) => a - b);
      const got = t.overlaps(s, e).map((iv) => iv.id).sort((a, b) => a - b);
      assert.deepEqual(got, expected);
      assert.equal(t.firstOverlap(s, e) !== null, expected.length > 0);
    }
  }
});

test('interval tree: touching intervals do not overlap (half-open)', () => {
  const t = new IntervalTree();
  t.insert({ id: 'a', start: 540, end: 600 });     // 09:00-10:00
  assert.equal(t.firstOverlap(600, 660), null);     // 10:00-11:00
  assert.equal(t.firstOverlap(480, 540), null);     // 08:00-09:00
  assert.equal(t.firstOverlap(599, 601).id, 'a');
});

test('sweep-line finds exactly the overlapping pairs', () => {
  for (let round = 0; round < 20; round++) {
    const ivs = randomIntervals(300);
    const key = ([a, b]) => (a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`);
    const expected = [];
    for (let i = 0; i < ivs.length; i++)
      for (let j = i + 1; j < ivs.length; j++) if (overlap(ivs[i], ivs[j])) expected.push(key([ivs[i], ivs[j]]));
    const got = findOverlaps(ivs).map(key);
    assert.deepEqual(got.sort(), expected.sort());
  }
});

test('sweep-line: simple timetable example', () => {
  const pairs = findOverlaps([
    { id: 'A', start: 9 * 60, end: 11 * 60 },
    { id: 'B', start: 10 * 60, end: 12 * 60 },
    { id: 'C', start: 11 * 60, end: 12 * 60 },  // touches A, overlaps B
    { id: 'D', start: 13 * 60, end: 14 * 60 },
  ]).map(([a, b]) => [a.id, b.id].sort().join(''));
  assert.deepEqual(pairs.sort(), ['AB', 'BC']);
});

test('DSATUR gives a proper colouring and starts with the most constrained event', () => {
  // Event 0 shares a key with 1, 2, 3 (most constrained); 1 and 2 share a projector.
  const events = [
    { keys: ['s1', 's2', 's3'] }, { keys: ['s1', 'proj'] }, { keys: ['s2', 'proj'] }, { keys: ['s3'] }, { keys: [] },
  ];
  const adj = buildConflictGraph(events, (e) => e.keys);
  const { colour, order, colourCount } = dsatur(adj);
  assert.equal(order[0], 0);
  for (let v = 0; v < adj.length; v++) for (const u of adj[v]) assert.notEqual(colour[u], colour[v]);
  assert.equal(colourCount, 3); // triangle 0-1-2 needs 3 colours
  assert.equal(colour[4], 0);   // isolated event joins the first compatible group
});

test('DSATUR colours random graphs properly', () => {
  for (let round = 0; round < 10; round++) {
    const events = Array.from({ length: 120 }, () => ({ keys: [`k${rand(40)}`, `k${rand(40)}`] }));
    const adj = buildConflictGraph(events, (e) => e.keys);
    const { colour, order } = dsatur(adj);
    assert.equal(new Set(order).size, events.length);
    for (let v = 0; v < adj.length; v++) for (const u of adj[v]) assert.notEqual(colour[u], colour[v]);
  }
});

test('classification rules', () => {
  assert.equal(classify({ unplaced: true }).category, 'critical');
  assert.equal(classify({ busy: true }).category, 'resource');   // E2 BUSY is not critical
  assert.equal(classify({ busy: true }).status, 'resolved');
  assert.equal(classify({ moved: true }).category, 'resource');
  const a = { venue: 'Lab 1', judgeIds: ['j1'], resources: ['projector'] };
  assert.equal(classify(pairFacts(a, { venue: 'Lab 1', judgeIds: [], resources: [] })).category, 'critical');
  assert.equal(classify(pairFacts(a, { venue: 'Lab 2', judgeIds: ['j1'], resources: [] })).category, 'critical');
  assert.equal(classify(pairFacts(a, { venue: 'Lab 2', judgeIds: [], resources: ['projector'] })).category, 'critical');
  assert.equal(classify(pairFacts(a, { venue: 'Lab 2', judgeIds: [], resources: [] })).category, 'acceptable');
  assert.equal(classify({}), null); // no overlap, nothing to report
});

test('conflict ranking: critical > resource > acceptable, then by time', () => {
  const conflict = (category, start) => ({ category, severity: SEVERITY[category], start });
  const ranked = rankConflicts([
    conflict('acceptable', 1), conflict('resource', 5), conflict('critical', 9),
    conflict('resource', 2), conflict('acceptable', 3),
  ]);
  assert.deepEqual(ranked.map((c) => `${c.category}@${c.start}`),
    ['critical@9', 'resource@2', 'resource@5', 'acceptable@1', 'acceptable@3']);
});
