'use strict';
const h = require('./helpers'); // must be first
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const repo = h.repo;
const timetable = require('../src/services/timetableService');
const { withTransaction, ConflictError, ValidationError } = require('../src/services/transactionService');
const { T, sleep } = h;

let ids, v1, v2, e60a, e60b, e90;

before(async () => { await h.setupTestDb(); });
after(async () => { await h.closePool(); });
beforeEach(async () => {
  await h.resetData();
  ids = await h.seed();
  v1 = await repo.createVersion(1);
  v2 = await repo.createVersion(2);
  e60a = await h.mkEvent(ids, 'Sixty A', 60);
  e60b = await h.mkEvent(ids, 'Sixty B', 60);
  e90 = await h.mkEvent(ids, 'Ninety', 90);
});

const slot = (event, venueId, start, end, versionId = v1.version_id) => ({
  eventId: event.event_id, versionId, venueId, startTime: start, endTime: end,
});
const isDoubleBooking = (err) => err instanceof ConflictError && err.kind === 'double_booking' && err.code === '23P01';

describe('double-booking prevention (database level)', () => {
  test('overlapping booking in the same venue and version is rejected', async () => {
    await repo.addSlot(slot(e60a, ids.venueA, T(10), T(11)));
    await assert.rejects(() => repo.addSlot(slot(e60b, ids.venueA, T(10, 30), T(11, 30))), isDoubleBooking);
    assert.equal(await repo.countSlots(v1.version_id), 1, 'rejected booking must not be stored');
  });

  test('identical time window in the same venue is rejected', async () => {
    await repo.addSlot(slot(e60a, ids.venueA, T(10), T(11)));
    await assert.rejects(() => repo.addSlot(slot(e60b, ids.venueA, T(10), T(11))), isDoubleBooking);
  });

  test('a booking fully inside another one is rejected', async () => {
    await repo.addSlot(slot(e90, ids.venueA, T(9), T(10, 30)));
    await assert.rejects(() => repo.addSlot(slot(e60a, ids.venueA, T(9, 15), T(10, 15))), isDoubleBooking);
  });

  test('back-to-back bookings (end == next start) are allowed', async () => {
    await repo.addSlot(slot(e60a, ids.venueA, T(10), T(11)));
    await repo.addSlot(slot(e60b, ids.venueA, T(11), T(12)));
    assert.equal(await repo.countSlots(v1.version_id), 2);
  });

  test('same venue and time in a DIFFERENT version is allowed', async () => {
    await repo.addSlot(slot(e60a, ids.venueA, T(10), T(11), v1.version_id));
    await repo.addSlot(slot(e60b, ids.venueA, T(10), T(11), v2.version_id));
    assert.equal(await repo.countSlots(v2.version_id), 1);
  });

  test('same time in a DIFFERENT venue is allowed', async () => {
    await repo.addSlot(slot(e60a, ids.venueA, T(10), T(11)));
    await repo.addSlot(slot(e60b, ids.venueB, T(10), T(11)));
    assert.equal(await repo.countSlots(v1.version_id), 2);
  });

  test('the same event cannot be scheduled twice in one version', async () => {
    await repo.addSlot(slot(e60a, ids.venueA, T(10), T(11)));
    await assert.rejects(
      () => repo.addSlot(slot(e60a, ids.venueB, T(14), T(15))),
      (err) => err instanceof ConflictError && err.kind === 'duplicate'
    );
  });

  test('equipment cannot be booked as a venue', async () => {
    await assert.rejects(() => repo.addSlot(slot(e60a, ids.projector, T(10), T(11))), ValidationError);
  });

  test('slot length must equal the event duration', async () => {
    await assert.rejects(() => repo.addSlot(slot(e60a, ids.venueA, T(10), T(11, 30))), ValidationError);
  });

  test('end_time must be after start_time', async () => {
    await assert.rejects(() => repo.addSlot(slot(e60a, ids.venueA, T(11), T(10))), ValidationError);
  });

  test('equipment allocation: overlapping bookings of the same equipment are rejected', async () => {
    const q = (event, s, e) =>
      h.getPool().query(
        'INSERT INTO allocation (event_id, resource_id, version_id, quantity, start_time, end_time) VALUES ($1,$2,$3,1,$4,$5)',
        [event.event_id, ids.projector, v1.version_id, s, e]
      );
    await q(e60a, T(10), T(11));
    await assert.rejects(() => q(e60b, T(10, 30), T(11, 30)), (err) => err.code === '23P01');
    await q(e60b, T(11), T(12)); // back-to-back is fine
  });
});

describe('save_schedule: atomic replacement', () => {
  const payload = (a, b) => [
    { event_id: a.event_id, venue_id: ids.venueA, start_time: T(10), end_time: T(11) },
    { event_id: b.event_id, venue_id: ids.venueB, start_time: T(10), end_time: T(11) },
  ];

  test('saves slots and replaces the previous ones', async () => {
    await timetable.saveSchedule(v1.version_id, payload(e60a, e60b));
    assert.equal(await repo.countSlots(v1.version_id), 2);

    await timetable.saveSchedule(v1.version_id, [
      { event_id: e90.event_id, venue_id: ids.venueA, start_time: T(9), end_time: T(10, 30) },
    ]);
    const rows = await repo.getSchedule(v1.version_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_name, 'Ninety');
  });

  test('ROLLBACK: if one slot is rejected, the previous schedule is left untouched', async () => {
    await timetable.saveSchedule(v1.version_id, payload(e60a, e60b));
    const before = (await repo.getSchedule(v1.version_id)).map((r) => r.slot_id);

    const bad = [
      { event_id: e60a.event_id, venue_id: ids.venueA, start_time: T(13), end_time: T(14) }, // fine
      { event_id: e60b.event_id, venue_id: ids.venueA, start_time: T(13, 30), end_time: T(14, 30) }, // overlaps the first
    ];
    await assert.rejects(
      () => timetable.saveSchedule(v1.version_id, bad),
      (err) => isDoubleBooking(err) && err.extra.slot_index === 1 && /slots\[1\]/.test(err.message)
    );

    const after = (await repo.getSchedule(v1.version_id)).map((r) => r.slot_id);
    assert.deepEqual(after, before, 'old slots must still be there, unchanged');
  });

  test('an overlap inside the same payload is rejected as a whole', async () => {
    const bad = [
      { event_id: e60a.event_id, venue_id: ids.venueA, start_time: T(10), end_time: T(11) },
      { event_id: e60b.event_id, venue_id: ids.venueA, start_time: T(10), end_time: T(11) },
    ];
    await assert.rejects(() => timetable.saveSchedule(v1.version_id, bad), isDoubleBooking);
    assert.equal(await repo.countSlots(v1.version_id), 0);
  });

  test('only Draft versions can be modified', async () => {
    await timetable.saveSchedule(v1.version_id, payload(e60a, e60b));
    await timetable.publishVersion(v1.version_id, ids.admin);
    await assert.rejects(
      () => timetable.saveSchedule(v1.version_id, []),
      (err) => err instanceof ConflictError && err.kind === 'not_draft'
    );
    assert.equal(await repo.countSlots(v1.version_id), 2);
  });

  test('input validation: bad shapes and time-zone suffixes are rejected before touching the DB', async () => {
    await assert.rejects(() => timetable.saveSchedule(v1.version_id, 'nope'), ValidationError);
    await assert.rejects(() => timetable.saveSchedule(v1.version_id, [{ event_id: 'x' }]), ValidationError);
    await assert.rejects(
      () => timetable.saveSchedule(v1.version_id, [
        { event_id: e60a.event_id, venue_id: ids.venueA, start_time: '2026-12-05T10:00:00Z', end_time: '2026-12-05T11:00:00Z' },
      ]),
      ValidationError
    );
    await assert.rejects(() => timetable.saveSchedule(99999, []), (e) => e.name === 'NotFoundError');
  });

  test('times are stored and returned exactly as sent (no time-zone shift)', async () => {
    await timetable.saveSchedule(v1.version_id, [
      { event_id: e60a.event_id, venue_id: ids.venueA, start_time: '2026-12-05 09:00:00', end_time: '2026-12-05 10:00:00' },
    ]);
    const [row] = await repo.getSchedule(v1.version_id);
    assert.equal(row.start_time, '2026-12-05 09:00:00');
    assert.equal(row.end_time, '2026-12-05 10:00:00');
  });
});

describe('concurrent booking attempts', () => {
  /** Book inside a transaction and keep it open briefly so the attempts really overlap in time. */
  const attempt = (event, venueId, start, end) =>
    withTransaction(async (c) => {
      await repo.addSlot({ eventId: event.event_id, versionId: v1.version_id, venueId, startTime: start, endTime: end }, c);
      await sleep(300);
    }).then(
      () => ({ ok: true }),
      (err) => ({ ok: false, err })
    );

  test('two simultaneous bookings of the same venue/time: exactly one wins, the other is a double-booking error', async () => {
    const results = await Promise.all([
      attempt(e60a, ids.venueA, T(10), T(11)),
      attempt(e60b, ids.venueA, T(10), T(11)),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    const loser = results.find((r) => !r.ok);
    assert.ok(isDoubleBooking(loser.err), `unexpected error: ${loser.err}`);
    assert.equal(await repo.countSlots(v1.version_id), 1);
  });

  test('8 simultaneous, partially overlapping bookings of one venue: exactly one succeeds', async () => {
    const events = [];
    for (let i = 0; i < 8; i += 1) events.push(await h.mkEvent(ids, `Race ${i}`, 60));
    // start times 10:00, 10:05, ... all overlap each other
    const results = await Promise.all(events.map((ev, i) => attempt(ev, ids.venueA, T(10, i * 5), T(11, i * 5))));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => isDoubleBooking(r.err)));
    assert.equal(await repo.countSlots(v1.version_id), 1);
  });

  test('simultaneous bookings that do NOT conflict all succeed (different venues / back-to-back)', async () => {
    const e3x = await h.mkEvent(ids, 'Third', 60);
    const results = await Promise.all([
      attempt(e60a, ids.venueA, T(10), T(11)),
      attempt(e60b, ids.venueB, T(10), T(11)), // other venue
      attempt(e3x, ids.venueA, T(11), T(12)), // back-to-back in venue A
    ]);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => r.err && r.err.message)));
    assert.equal(await repo.countSlots(v1.version_id), 3);
  });

  test('if the first booking ROLLS BACK, a waiting concurrent booking for the same slot then succeeds', async () => {
    const first = withTransaction(async (c) => {
      await repo.addSlot(slot(e60a, ids.venueA, T(10), T(11)), c);
      await sleep(300);
      throw new Error('first booking aborted');
    }).catch(() => 'rolled back');
    await sleep(50); // make sure the first one holds the slot
    const second = repo.addSlot(slot(e60b, ids.venueA, T(10), T(11))); // waits for the first transaction
    assert.equal(await first, 'rolled back');
    const saved = await second;
    assert.equal(saved.event_id, e60b.event_id);
    assert.equal(await repo.countSlots(v1.version_id), 1);
  });
});
