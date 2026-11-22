'use strict';
const h = require('./helpers'); // must be first
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const repo = h.repo;
const timetable = require('../src/services/timetableService');
const { ConflictError, ValidationError, NotFoundError } = require('../src/services/transactionService');
const { T } = h;

let ids, hack, dance, quiz;

before(async () => { await h.setupTestDb(); });
after(async () => { await h.closePool(); });

beforeEach(async () => {
  await h.resetData();
  ids = await h.seed();
  hack = await h.mkEvent(ids, 'Hackathon', 120);
  dance = await h.mkEvent(ids, 'Dance Night', 150);
  quiz = await h.mkEvent(ids, 'Quiz Bowl', 90);
  // judge1 judges Hackathon AND Dance Night; judge2 judges Quiz
  await repo.assignJudge(hack.event_id, ids.judge1);
  await repo.assignJudge(dance.event_id, ids.judge1);
  await repo.assignJudge(quiz.event_id, ids.judge2);
  // stud1 is in Hackathon AND Quiz
  await repo.registerStudent(ids.stud1, hack.event_id);
  await repo.registerStudent(ids.stud1, quiz.event_id);
  await repo.registerStudent(ids.stud2, dance.event_id);
});

const S = (ev, venue, s, e) => ({ event_id: ev.event_id, venue_id: venue, start_time: s, end_time: e });
const versionStatus = async (id) => (await repo.getVersionById(id)).status;
const publishedCount = async () =>
  (await h.getPool().query(`SELECT COUNT(*) AS n FROM timetable_version WHERE status = 'Published'`)).rows[0].n;

/**
 * A clean schedule: nobody overlaps. judge1 (Hackathon, Dance) and stud1 (Hackathon, Quiz) only
 * have back-to-back events, which are allowed.
 */
const cleanSlots = () => [
  S(hack, ids.venueA, T(9), T(11)),
  S(dance, ids.venueA, T(11), T(13, 30)),
  S(quiz, ids.venueB, T(11), T(12, 30)),
];
/** judge1 is needed in Hackathon (9-11) and Dance Night (10-12:30) at the same time -> Critical. */
const judgeClashSlots = () => [
  S(hack, ids.venueA, T(9), T(11)),
  S(dance, ids.venueB, T(10), T(12, 30)),
];
/** stud1 is registered for Hackathon (9-11) and Quiz (10-11:30) at the same time -> Acceptable only. */
const studentClashSlots = () => [
  S(hack, ids.venueA, T(9), T(11)),
  S(quiz, ids.venueB, T(10), T(11, 30)),
];

describe('timetable version creation', () => {
  test('a new version starts as Draft with no publish info', async () => {
    const v = await timetable.createDraftVersion(7);
    assert.equal(v.version_no, 7);
    assert.equal(v.status, 'Draft');
    assert.equal(v.published_at, null);
  });

  test('version numbers are unique', async () => {
    await timetable.createDraftVersion(1);
    await assert.rejects(() => timetable.createDraftVersion(1), (e) => e instanceof ConflictError && e.kind === 'duplicate');
  });

  test('invalid version numbers are rejected', async () => {
    await assert.rejects(() => timetable.createDraftVersion(0), ValidationError);
    await assert.rejects(() => timetable.createDraftVersion('abc'), ValidationError);
  });

  test('several Draft versions can exist side by side', async () => {
    await timetable.createDraftVersion(1);
    await timetable.createDraftVersion(2);
    await timetable.createDraftVersion(3);
    assert.equal((await repo.listVersions()).length, 3);
  });
});

describe('conflict detection', () => {
  test('judge double-booked across venues is a Critical, Open conflict', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    const r = await timetable.detectConflicts(v.version_id);
    assert.equal(r.total, 1);
    assert.equal(r.open_critical, 1);
    const c = r.conflicts[0];
    assert.equal(c.severity, 'Critical');
    assert.equal(c.type, 'Resource');
    assert.equal(c.status, 'Open');
    assert.ok(c.event_a < c.event_b);
  });

  test('student registered for two overlapping events is an Acceptable conflict', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, studentClashSlots());
    const r = await timetable.detectConflicts(v.version_id);
    assert.equal(r.total, 1);
    assert.equal(r.open_critical, 0);
    assert.equal(r.conflicts[0].severity, 'Acceptable');
    assert.equal(r.conflicts[0].type, 'Participant');
  });

  test('a clean schedule has no conflicts', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, cleanSlots());
    assert.equal((await timetable.detectConflicts(v.version_id)).total, 0);
  });

  test('detection is idempotent: running twice neither duplicates rows nor changes conflict ids', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    const first = await timetable.detectConflicts(v.version_id);
    const again = await timetable.detectConflicts(v.version_id);
    assert.equal(again.total, 1);
    assert.deepEqual(again.conflicts.map((c) => c.conflict_id), first.conflicts.map((c) => c.conflict_id));
  });

  test('stale Open conflicts disappear once the schedule is fixed', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    assert.equal((await timetable.detectConflicts(v.version_id)).total, 1);
    await timetable.saveSchedule(v.version_id, cleanSlots());
    assert.equal((await timetable.detectConflicts(v.version_id)).total, 0);
  });

  test('conflicts of one version do not leak into another', async () => {
    const bad = await timetable.createDraftVersion(1);
    const good = await timetable.createDraftVersion(2);
    await timetable.saveSchedule(bad.version_id, judgeClashSlots());
    await timetable.saveSchedule(good.version_id, cleanSlots());
    assert.equal((await timetable.detectConflicts(bad.version_id)).total, 1);
    assert.equal((await timetable.detectConflicts(good.version_id)).total, 0);
  });

  test('unknown version -> NotFoundError', async () => {
    await assert.rejects(() => timetable.detectConflicts(99999), NotFoundError);
  });
});

describe('publishing', () => {
  test('a clean Draft is published and stamped', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, cleanSlots());
    const p = await timetable.publishVersion(v.version_id, ids.admin);
    assert.equal(p.status, 'Published');
    assert.equal(p.published_by, ids.admin);
    assert.ok(p.published_at);
  });

  test('publishing a new version archives the previously Published one (exactly one Published)', async () => {
    const v1 = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v1.version_id, cleanSlots());
    await timetable.publishVersion(v1.version_id, ids.admin);

    const v2 = await timetable.createDraftVersion(2);
    await timetable.saveSchedule(v2.version_id, cleanSlots());
    await timetable.publishVersion(v2.version_id, ids.admin);

    assert.equal(await versionStatus(v1.version_id), 'Archived');
    assert.equal(await versionStatus(v2.version_id), 'Published');
    assert.equal(await publishedCount(), 1);
  });

  test('BLOCKED: unresolved Critical conflict prevents publishing', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    await assert.rejects(
      () => timetable.publishVersion(v.version_id, ids.admin),
      (err) =>
        err instanceof ConflictError &&
        err.kind === 'critical_conflicts' &&
        err.extra.conflict_ids.length === 1 &&
        /Publishing blocked/.test(err.message)
    );
    assert.equal(await versionStatus(v.version_id), 'Draft', 'version must stay Draft');
    assert.equal(await publishedCount(), 0);
  });

  test('BLOCKED publish leaves the detected conflicts stored, and the ids in the error are real rows', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    let reported;
    await assert.rejects(() => timetable.publishVersion(v.version_id, ids.admin), (err) => { reported = err.extra.conflict_ids; return true; });
    const stored = await repo.listConflicts(v.version_id, { status: 'Open', severity: 'Critical' });
    assert.deepEqual(stored.map((c) => c.conflict_id), reported);
  });

  test('BLOCKED publish is rolled back completely: the currently Published version is NOT archived', async () => {
    const good = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(good.version_id, cleanSlots());
    await timetable.publishVersion(good.version_id, ids.admin);

    const bad = await timetable.createDraftVersion(2);
    await timetable.saveSchedule(bad.version_id, judgeClashSlots());
    await assert.rejects(() => timetable.publishVersion(bad.version_id, ids.admin), ConflictError);

    assert.equal(await versionStatus(good.version_id), 'Published', 'old timetable must stay live');
    assert.equal(await versionStatus(bad.version_id), 'Draft');
  });

  test('publishing works once the Critical conflict is fixed', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    await assert.rejects(() => timetable.publishVersion(v.version_id, ids.admin), ConflictError);
    await timetable.saveSchedule(v.version_id, cleanSlots());
    const p = await timetable.publishVersion(v.version_id, ids.admin);
    assert.equal(p.status, 'Published');
  });

  test('publish does not rely on a prior detect call: it detects by itself', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    // detectConflicts() was never called, so the conflict table starts empty:
    assert.equal((await repo.listConflicts(v.version_id)).length, 0);
    await assert.rejects(() => timetable.publishVersion(v.version_id, ids.admin), ConflictError);
    assert.equal((await repo.listConflicts(v.version_id)).length, 1);
  });

  test('Acceptable conflicts do not block publishing (and stay recorded)', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, studentClashSlots());
    const p = await timetable.publishVersion(v.version_id, ids.admin);
    assert.equal(p.status, 'Published');
    const stored = await repo.listConflicts(v.version_id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].severity, 'Acceptable');
  });

  test('a Critical conflict marked Ignored/Resolved no longer blocks and is not re-opened', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, judgeClashSlots());
    await assert.rejects(() => timetable.publishVersion(v.version_id, ids.admin), ConflictError);

    await h.getPool().query(`UPDATE conflict SET status = 'Ignored', raised_by = $2 WHERE version_id = $1`, [v.version_id, ids.admin]);
    const p = await timetable.publishVersion(v.version_id, ids.admin);
    assert.equal(p.status, 'Published');
    const stored = await repo.listConflicts(v.version_id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'Ignored');
  });

  test('an empty timetable cannot be published', async () => {
    const v = await timetable.createDraftVersion(1);
    await assert.rejects(
      () => timetable.publishVersion(v.version_id, ids.admin),
      (e) => e instanceof ValidationError && e.kind === 'empty_timetable'
    );
  });

  test('publishing an already Published version -> ConflictError; unknown version -> NotFoundError', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, cleanSlots());
    await timetable.publishVersion(v.version_id, ids.admin);
    await assert.rejects(() => timetable.publishVersion(v.version_id, ids.admin), (e) => e.kind === 'already_published');
    await assert.rejects(() => timetable.publishVersion(99999, ids.admin), NotFoundError);
  });

  test('an unknown published_by user is rejected and nothing changes', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, cleanSlots());
    await assert.rejects(() => timetable.publishVersion(v.version_id, 99999), ValidationError);
    assert.equal(await versionStatus(v.version_id), 'Draft');
  });

  test('an Archived version can be re-published (roll back to an older timetable)', async () => {
    const v1 = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v1.version_id, cleanSlots());
    await timetable.publishVersion(v1.version_id, ids.admin);
    const v2 = await timetable.createDraftVersion(2);
    await timetable.saveSchedule(v2.version_id, cleanSlots());
    await timetable.publishVersion(v2.version_id, ids.admin);

    await timetable.publishVersion(v1.version_id, ids.admin);
    assert.equal(await versionStatus(v1.version_id), 'Published');
    assert.equal(await versionStatus(v2.version_id), 'Archived');
    assert.equal(await publishedCount(), 1);
  });

  test('CONCURRENT: two drafts published at the same moment -> exactly one Published, no errors leak', async () => {
    const a = await timetable.createDraftVersion(1);
    const b = await timetable.createDraftVersion(2);
    await timetable.saveSchedule(a.version_id, cleanSlots());
    await timetable.saveSchedule(b.version_id, cleanSlots());

    const results = await Promise.allSettled([
      timetable.publishVersion(a.version_id, ids.admin),
      timetable.publishVersion(b.version_id, ids.admin),
    ]);
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => r.reason && r.reason.message)));
    assert.equal(await publishedCount(), 1);
    const statuses = [await versionStatus(a.version_id), await versionStatus(b.version_id)].sort();
    assert.deepEqual(statuses, ['Archived', 'Published']);
  });

  test('the database itself refuses a second Published version (unique index)', async () => {
    const a = await timetable.createDraftVersion(1);
    const b = await timetable.createDraftVersion(2);
    await h.getPool().query(`UPDATE timetable_version SET status = 'Published' WHERE version_id = $1`, [a.version_id]);
    await assert.rejects(
      () => h.getPool().query(`UPDATE timetable_version SET status = 'Published' WHERE version_id = $1`, [b.version_id]),
      (err) => err.code === '23505' && err.constraint === 'one_published_version'
    );
  });
});

describe('reading a schedule', () => {
  test('get_schedule returns venue, event and coordinator details ordered by start time', async () => {
    const v = await timetable.createDraftVersion(1);
    await timetable.saveSchedule(v.version_id, cleanSlots());
    const { version, slots } = await timetable.getSchedule(v.version_id);
    assert.equal(version.status, 'Draft');
    assert.equal(slots.length, 3);
    assert.deepEqual(slots.map((s) => s.start_time), [...slots.map((s) => s.start_time)].sort());
    const d = slots.find((s) => s.event_name === 'Dance Night');
    assert.equal(d.venue_name, 'Hall A');
    assert.equal(d.venue_capacity, 100);
    assert.equal(d.coordinator_email, 'coord1@t.edu');
    assert.equal(d.start_time, '2026-12-05 11:00:00');
  });

  test('unknown version -> NotFoundError', async () => {
    await assert.rejects(() => timetable.getSchedule(99999), NotFoundError);
  });
});
