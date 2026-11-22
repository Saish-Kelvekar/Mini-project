'use strict';
const h = require('./helpers'); // must be first
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { T } = h;

let server, base, ids;

before(async () => {
  await h.setupTestDb();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await h.closePool();
});
beforeEach(async () => {
  await h.resetData();
  ids = await h.seed();
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /health -> 200', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok', database: true });
});

test('unknown route -> 404 JSON', async () => {
  const r = await call('GET', '/nope');
  assert.equal(r.status, 404);
});

test('POST /events -> 201, GET /events/:id -> 200, missing id -> 404, bad id -> 400', async () => {
  const created = await call('POST', '/events', { name: 'Chess', duration_min: 60, judges_required: 1, coordinator_id: ids.coord });
  assert.equal(created.status, 201);
  assert.equal(created.body.event.status, 'Pending');

  assert.equal((await call('GET', `/events/${created.body.event.event_id}`)).status, 200);
  assert.equal((await call('GET', '/events/99999')).status, 404);
  assert.equal((await call('GET', '/events/abc')).status, 400);
});

test('POST /events with invalid data -> 400 (duration 0), unknown coordinator -> 400', async () => {
  assert.equal((await call('POST', '/events', { name: 'Zero', duration_min: 0, coordinator_id: ids.coord })).status, 400);
  assert.equal((await call('POST', '/events', { name: 'Ghost', duration_min: 60, coordinator_id: 99999 })).status, 400);
  assert.equal((await call('POST', '/events', { duration_min: 60, coordinator_id: ids.coord })).status, 400); // no name
});

test('malformed JSON body -> 400', async () => {
  assert.equal((await call('POST', '/events', '{not json')).status, 400);
});

test('approval flow: PATCH /events/:id/status then GET /events/approved', async () => {
  const e = (await call('POST', '/events', { name: 'Chess', duration_min: 60, coordinator_id: ids.coord })).body.event;
  const r = await call('PATCH', `/events/${e.event_id}/status`, { status: 'Approved', approved_by: ids.admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.event.approved_by, ids.admin);

  const approved = await call('GET', '/events/approved');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.events.length, 1);
  assert.equal(approved.body.venues.length, 3);

  // a non-admin approver is rejected by the DB trigger
  const bad = await call('PATCH', `/events/${e.event_id}/status`, { status: 'Approved', approved_by: ids.stud1 });
  assert.equal(bad.status, 400);
});

test('registration: 201, duplicate -> 409', async () => {
  const e = (await call('POST', '/events', { name: 'Chess', duration_min: 60, coordinator_id: ids.coord })).body.event;
  assert.equal((await call('POST', `/events/${e.event_id}/register`, { student_id: ids.stud1 })).status, 201);
  assert.equal((await call('POST', `/events/${e.event_id}/register`, { student_id: ids.stud1 })).status, 409);
});

test('timetable flow over HTTP: version -> schedule -> double-booking 409 -> publish', async () => {
  const mk = async (name, dur) =>
    (await call('POST', '/events', { name, duration_min: dur, coordinator_id: ids.coord })).body.event.event_id;
  const a = await mk('A', 60);
  const b = await mk('B', 60);

  const v = await call('POST', '/versions', { version_no: 1 });
  assert.equal(v.status, 201);
  const vid = v.body.version.version_id;
  assert.equal((await call('POST', '/versions', { version_no: 1 })).status, 409); // duplicate version_no

  const clash = [
    { event_id: a, venue_id: ids.venueA, start_time: T(10), end_time: T(11) },
    { event_id: b, venue_id: ids.venueA, start_time: T(10, 30), end_time: T(11, 30) },
  ];
  const rejected = await call('PUT', `/versions/${vid}/schedule`, { slots: clash });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.kind, 'double_booking');
  assert.equal((await call('GET', `/versions/${vid}/schedule`)).body.slots.length, 0, 'nothing saved');

  const tzSuffix = await call('PUT', `/versions/${vid}/schedule`, {
    slots: [{ event_id: a, venue_id: ids.venueA, start_time: '2026-12-05T10:00:00Z', end_time: '2026-12-05T11:00:00Z' }],
  });
  assert.equal(tzSuffix.status, 400);

  const ok = [
    { event_id: a, venue_id: ids.venueA, start_time: T(10), end_time: T(11) },
    { event_id: b, venue_id: ids.venueA, start_time: T(11), end_time: T(12) },
  ];
  const saved = await call('PUT', `/versions/${vid}/schedule`, { slots: ok });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, 2);

  const sched = await call('GET', `/versions/${vid}/schedule`);
  assert.equal(sched.body.slots[0].start_time, '2026-12-05 10:00:00');

  assert.equal((await call('POST', `/versions/${vid}/conflicts/detect`)).body.total, 0);
  const pub = await call('POST', `/versions/${vid}/publish`, { published_by: ids.admin });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.version.status, 'Published');

  // published versions are frozen
  assert.equal((await call('PUT', `/versions/${vid}/schedule`, { slots: [] })).status, 409);
  assert.equal((await call('GET', '/versions/99999/schedule')).status, 404);
});

test('publish blocked by a Critical conflict -> 409 with the blocking conflict ids', async () => {
  const mk = async (name, dur) =>
    (await call('POST', '/events', { name, duration_min: dur, coordinator_id: ids.coord })).body.event.event_id;
  const a = await mk('A', 60);
  const b = await mk('B', 60);
  await h.repo.assignJudge(a, ids.judge1);
  await h.repo.assignJudge(b, ids.judge1); // same judge in both

  const vid = (await call('POST', '/versions', { version_no: 1 })).body.version.version_id;
  await call('PUT', `/versions/${vid}/schedule`, {
    slots: [
      { event_id: a, venue_id: ids.venueA, start_time: T(10), end_time: T(11) },
      { event_id: b, venue_id: ids.venueB, start_time: T(10), end_time: T(11) },
    ],
  });
  const r = await call('POST', `/versions/${vid}/publish`, { published_by: ids.admin });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.kind, 'critical_conflicts');
  assert.equal(r.body.error.details.conflict_ids.length, 1);
});

test('scores: 201, then judge not assigned -> 400', async () => {
  const e = (await call('POST', '/events', { name: 'Chess', duration_min: 60, coordinator_id: ids.coord })).body.event;
  await h.repo.assignJudge(e.event_id, ids.judge1);
  await call('POST', `/events/${e.event_id}/register`, { student_id: ids.stud1 });
  assert.equal((await call('POST', `/events/${e.event_id}/scores`, { judge_id: ids.judge1, participant_id: ids.stud1, points: 90 })).status, 201);
  assert.equal((await call('POST', `/events/${e.event_id}/scores`, { judge_id: ids.judge2, participant_id: ids.stud1, points: 90 })).status, 400);
});
