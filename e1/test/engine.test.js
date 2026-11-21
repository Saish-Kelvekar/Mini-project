// End-to-end tests of generateTimetable: placement, E2 BUSY retries, critical conflicts, participants.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { generateTimetable, parseResources, E2Client, E2StandIn } = require('../src');

const DATE = '2026-11-25';
const DAY = 24 * 60;
const abs = (hh, mm = 0) => hh * 60 + mm; // day 0 = DATE
const opts = (extra = {}) => ({ startDate: DATE, horizonDays: 3, ...extra });
const ev = (id, f = {}) => ({ id, name: `E${id}`, durationMinutes: 60, judgesRequired: 1, preferredDate: DATE, ...f });
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const clash = (a, b) => a.date === b.date && toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

function assertNoDoubleBooking(entries) {
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (!clash(a, b)) continue;
    assert.notEqual(a.venue, b.venue, `venue double-booked: ${a.name} / ${b.name}`);
    assert.deepEqual(a.judgeIds.filter((x) => b.judgeIds.includes(x)), [], `judge double-booked: ${a.name} / ${b.name}`);
    assert.deepEqual(a.resources.filter((x) => b.resources.includes(x)), [], `resource double-booked: ${a.name} / ${b.name}`);
  }
}

test('parses free-text resources from the E4 form', () => {
  assert.deepEqual(parseResources('Projector, 2 mics; Sound system and stage'), ['projector', 'mics', 'sound system', 'stage']);
  assert.deepEqual(parseResources(''), []);
});

test('places events at their preferred venue and date with output fields for E4', async () => {
  const r = await generateTimetable([ev(1, { preferredVenue: 'Lab 2', judgesRequired: 2 })], opts());
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.deepEqual({ venue: e.venue, date: e.date, start: e.start, end: e.end }, { venue: 'Lab 2', date: DATE, start: '09:00', end: '10:00' });
  assert.equal(e.judgeIds.length, 2);
  assert.equal(r.summary.critical, 0);
});

test('never double-books a venue, judge or resource', async () => {
  const events = Array.from({ length: 40 }, (_, i) => ev(i + 1, {
    durationMinutes: 30 + (i % 4) * 30, judgesRequired: i % 3, preferredVenue: i % 2 ? 'Lab 1' : '',
    resourcesRequired: i % 5 === 0 ? 'Projector' : '',
  }));
  const r = await generateTimetable(events, opts());
  assert.equal(r.summary.unplaced, 0);
  assertNoDoubleBooking(r.entries);
  assert.equal(r.conflicts.filter((c) => c.category === 'critical').length, 0);
});

test('E2 BUSY on a judge: retries with another judge, logs a resolved resource conflict', async () => {
  const engine = new E2StandIn();
  const e2 = new E2Client(engine, 'test');
  await e2.checkAndReserve({ eventId: 'outside', resourceIds: ['judge:judge-1'], start: abs(0), end: abs(23) }); // booked elsewhere, unknown to E1
  const r = await generateTimetable([ev(1)], opts({ e2 }));
  assert.equal(r.entries[0].start, '09:00');
  assert.notDeepEqual(r.entries[0].judgeIds, ['judge-1']);
  const busy = r.conflicts.find((c) => c.type === 'E2_BUSY');
  assert.equal(busy.category, 'resource');
  assert.equal(busy.status, 'resolved');
});

test('E2 BUSY on the venue: marks the slot unavailable and re-slots', async () => {
  const engine = new E2StandIn();
  const e2 = new E2Client(engine, 'test');
  await e2.checkAndReserve({ eventId: 'outside', resourceIds: ['venue:Lab 2'], start: abs(9), end: abs(11) });
  const r = await generateTimetable([ev(1, { preferredVenue: 'Lab 2' })], opts({ e2 }));
  assert.deepEqual([r.entries[0].venue, r.entries[0].start], ['Lab 2', '11:00']);
  assert.ok(r.conflicts.some((c) => c.type === 'E2_BUSY' && c.category === 'resource'));
  assert.equal(r.summary.critical, 0);
});

test('critical only when no feasible allocation remains', async () => {
  const judges = [{ id: 'j1', name: 'J1' }];
  // One judge, a 9-hour day and a 1-day horizon: only one 6-hour event fits.
  const r = await generateTimetable([ev(1, { durationMinutes: 360 }), ev(2, { durationMinutes: 360 })],
    opts({ judges, horizonDays: 1 }));
  assert.equal(r.entries.length, 1);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.conflicts[0].category, 'critical'); // ranked first
  assert.equal(r.conflicts[0].type, 'UNPLACED');
});

test('keeps registered students out of overlapping events when possible', async () => {
  const reg = (ids) => ids.map((studentId) => ({ studentId }));
  const r = await generateTimetable([
    ev(1, { registrations: reg(['s1', 's2']), judgesRequired: 0 }),
    ev(2, { registrations: reg(['s1']), judgesRequired: 0 }),
    ev(3, { registrations: reg(['s3']), judgesRequired: 0 }),
  ], opts());
  const by = Object.fromEntries(r.entries.map((e) => [e.eventId, e]));
  assert.equal(clash(by[1], by[2]), false);
  assert.equal(r.summary.participant, 0);
  assert.equal(by[1].start, by[3].start); // compatible group runs in parallel
});

test('participant overlap is a warning when it cannot be avoided', async () => {
  const reg = [{ studentId: 's1' }];
  const r = await generateTimetable([
    ev(1, { registrations: reg, durationMinutes: 540, judgesRequired: 0 }),
    ev(2, { registrations: reg, durationMinutes: 540, judgesRequired: 0 }),
  ], opts({ horizonDays: 1 }));
  assert.equal(r.entries.length, 2);
  const p = r.conflicts.find((c) => c.category === 'participant');
  assert.equal(p.status, 'warning');
  assert.equal(r.summary.critical, 0);
});

test('respects existing schedules from E3', async () => {
  const existing = [{ eventId: 'old', name: 'Old', venue: 'Lab 2', date: DATE, start: '09:00', end: '12:00', judgeIds: [] }];
  const r = await generateTimetable([ev(1, { preferredVenue: 'Lab 2' })], opts({ existing }));
  const e = r.entries.find((x) => x.eventId === 1);
  assert.equal(e.start, '12:00');
  assert.equal(r.summary.placed, 1);
});

test("works with E2's ResourceEngine once its export line is fixed", async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'e2', 'e2.js'), 'utf8')
    .replace('GPUShaderModule.exports', 'module.exports');
  const mod = { exports: {} };
  new Function('module', 'exports', src)(mod, mod.exports);
  const e2 = new E2Client(new mod.exports.ResourceEngine(), 'e2');
  const events = Array.from({ length: 30 }, (_, i) => ev(i + 1, { judgesRequired: 2, resourcesRequired: i % 3 ? '' : 'projector' }));
  const r = await generateTimetable(events, opts({ e2 }));
  assert.equal(r.summary.unplaced, 0);
  assertNoDoubleBooking(r.entries);
});

test('says which E2 was used (stand-in while e2.js cannot load)', async () => {
  const r = await generateTimetable([ev(1)], opts());
  assert.ok(['e2', 'local-stub'].includes(r.summary.e2));
});

// Load test from doc 4.20 / NFR-01: a 500-event dataset must be scheduled in <= 2 s.
// Deterministic pseudo-random data so the run is repeatable.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

test('500 events scheduled in <= 2 s with no double booking', async () => {
  const venues = ['Main Hall', 'Auditorium', 'Seminar Hall', 'Lab 1', 'Lab 2', 'Lab 3', 'Lab 4', 'Room 101', 'Room 102', 'Room 103'];
  const judges = Array.from({ length: 25 }, (_, i) => ({ id: `j${i + 1}`, name: `Judge ${i + 1}` }));
  const items = ['projector', 'mics', 'sound system', 'stage lights', 'smart board', 'robot kit'];
  const dates = Array.from({ length: 10 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  const events = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1, name: `Event ${i + 1}`,
    durationMinutes: pick([30, 45, 60, 90, 120, 180]),
    judgesRequired: pick([0, 1, 2, 3]),
    preferredVenue: rnd() < 0.6 ? pick(venues) : '',
    preferredDate: rnd() < 0.7 ? pick(dates) : '',
    resourcesRequired: rnd() < 0.3 ? pick(items) : '',
    registrations: Array.from({ length: Math.floor(rnd() * 20) }, () => ({ studentId: `s${Math.floor(rnd() * 800)}` })),
  }));

  const t0 = performance.now();
  const r = await generateTimetable(events, { venues, judges, startDate: '2026-12-01', horizonDays: 30 });
  const ms = performance.now() - t0;
  console.log(`  500 events: ${ms.toFixed(0)} ms, placed ${r.summary.placed}, unplaced ${r.summary.unplaced}, ` +
              `groups ${r.summary.groups}, conflicts c/r/p/a = ${r.summary.critical}/${r.summary.resource}/${r.summary.participant}/${r.summary.acceptable}`);

  assert.ok(ms <= 2000, `took ${ms.toFixed(0)} ms`);
  assert.equal(r.summary.placed + r.summary.unplaced, 500);
  assert.equal(r.unplaced.length, 0);

  // Independent check: no venue/judge/resource is booked twice at the same time.
  const toMin = (e) => { const d = Date.parse(e.date) / 60000; const m = (s) => { const [h, mm] = s.split(':').map(Number); return h * 60 + mm; };
    return [d + m(e.start), d + m(e.end)]; };
  const byKey = new Map();
  for (const e of r.entries) {
    const [s, en] = toMin(e);
    for (const k of [`v:${e.venue}`, ...e.judgeIds.map((j) => `j:${j}`), ...e.resources.map((x) => `r:${x}`)]) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push([s, en]);
    }
  }
  for (const [k, list] of byKey) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i++) assert.ok(list[i][0] >= list[i - 1][1], `${k} double-booked`);
  }
});
