'use strict';

/**
 * test_e2.js - Unit Test Suite for Engine 2 (Resource Availability & Allocation)
 * Author: Saish Kelvekar (Team 4)
 *
 * Verifies the 36 foundational rules and invariants of the E2 specification:
 *   1-4.   Mutex & Lock Manager (FIFO queue, timeout, release)
 *   5-7.   Resource Pool & Registry (addResource, hasResource, listResources)
 *   8-11.  Input Validation & Guards (eventId, resourceIds, start/end)
 *   12-13. Normalization & Deduplication (strings, sets)
 *   14.    Resource Pool Membership (NOT_FOUND)
 *   15-16. Two-Phase Reservation Protocol (Single & Multi-resource RESERVED)
 *   17-18. Overlap & Conflict Detection (start < otherEnd && otherStart < end -> BUSY)
 *   19.    All-or-Nothing Atomicity Guarantee
 *   20-21. Deadlock Prevention: Sorted locking & reverse unwinding
 *   22.    Half-Open Interval Semantics [start, end)
 *   23.    Per-Event Concurrency Guard (REJECTED on concurrent in-flight operation)
 *   24-28. Commit Lifecycle & Idempotency (COMMITTED, E3 save hook, rollback on failure)
 *   29-32. Release Lifecycle (RESERVED drop, COMMITTED E3 remove hook, retain on failure)
 *   33-34. Hold Expiry & Automatic TTL Sweeping
 *   35-36. Read-Only Availability Checking (isFree: never locks, never reserves)
 */

const assert = require('assert');
const { Mutex, ResourceEngine } = require('./e2_engine');
const { E3PersistenceStub } = require('./e3_stub');

let passedChecks = 0;
let failedChecks = 0;

function runCheck(num, title, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res
        .then(() => {
          passedChecks++;
          console.log(`  [PASS] Check ${String(num).padStart(2, '0')}: ${title}`);
        })
        .catch(err => {
          failedChecks++;
          console.error(`  [FAIL] Check ${String(num).padStart(2, '0')}: ${title}`);
          console.error(`         ${err.message}`);
        });
    } else {
      passedChecks++;
      console.log(`  [PASS] Check ${String(num).padStart(2, '0')}: ${title}`);
    }
  } catch (err) {
    failedChecks++;
    console.error(`  [FAIL] Check ${String(num).padStart(2, '0')}: ${title}`);
    console.error(`         ${err.message}`);
  }
}

async function runAllChecks() {
  console.log('================================================================');
  console.log('   ENGINE 2 UNIT TEST SUITE (36 SPECIFICATION CHECKS)          ');
  console.log('================================================================\n');

  // Check 1: Mutex basic acquire and release
  await runCheck(1, 'Mutex acquires and releases single lock correctly', async () => {
    const m = new Mutex();
    assert.strictEqual(m.locked, false);
    await m.acquire();
    assert.strictEqual(m.locked, true);
    m.release();
    assert.strictEqual(m.locked, false);
  });

  // Check 2: Mutex FIFO ordering
  await runCheck(2, 'Mutex grants locks in strict FIFO queue order', async () => {
    const m = new Mutex();
    await m.acquire();
    const order = [];
    const p1 = m.acquire().then(() => { order.push(1); m.release(); });
    const p2 = m.acquire().then(() => { order.push(2); m.release(); });
    const p3 = m.acquire().then(() => { order.push(3); m.release(); });
    m.release();
    await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  // Check 3: Mutex lock acquisition timeout
  await runCheck(3, 'Mutex times out when lock cannot be acquired within timeoutMs', async () => {
    const m = new Mutex();
    await m.acquire();
    let timedOut = false;
    try {
      await m.acquire(30);
    } catch (err) {
      timedOut = true;
      assert.strictEqual(err.message, 'Lock acquisition timeout');
    }
    assert.strictEqual(timedOut, true);
    m.release();
  });

  // Check 4: Mutex release after timeout grants lock to next active waiter
  await runCheck(4, 'Mutex skips timed-out waiters and grants to next active waiter', async () => {
    const m = new Mutex();
    await m.acquire();
    const pTimed = m.acquire(20).catch(() => 'timeout');
    let secondAcquired = false;
    const pSecond = m.acquire(200).then(() => { secondAcquired = true; m.release(); });
    await pTimed;
    m.release();
    await pSecond;
    assert.strictEqual(secondAcquired, true);
  });

  // Check 5: addResource registers resource in pool
  await runCheck(5, 'addResource creates resource with mutex and bookings list', () => {
    const engine = new ResourceEngine();
    const r = engine.addResource('venue:Lab 1', { type: 'Venue', capacity: 60 });
    assert.strictEqual(r.id, 'venue:Lab 1');
    assert.strictEqual(r.type, 'Venue');
    assert.strictEqual(r.capacity, 60);
    assert.ok(r.mutex instanceof Mutex);
    assert.deepStrictEqual(r.bookings, []);
  });

  // Check 6: hasResource checks pool membership
  await runCheck(6, 'hasResource returns true for existing, false for missing', () => {
    const engine = new ResourceEngine();
    engine.addResource('judge:1');
    assert.strictEqual(engine.hasResource('judge:1'), true);
    assert.strictEqual(engine.hasResource('judge:999'), false);
    assert.strictEqual(engine.hasResource(null), false);
  });

  // Check 7: listResources returns metadata list
  await runCheck(7, 'listResources returns array of all registered resources', () => {
    const engine = new ResourceEngine();
    engine.addResource('venue:Auditorium', { type: 'Venue', capacity: 300 });
    engine.addResource('res:mic', { type: 'Equipment' });
    const list = engine.listResources();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some(r => r.id === 'venue:Auditorium' && r.capacity === 300));
  });

  // Check 8: Input validation - missing eventId
  await runCheck(8, 'reserve returns REJECTED when eventId is missing or empty', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    const res1 = await engine.reserve('', ['r1'], 100, 200);
    const res2 = await engine.reserve(null, ['r1'], 100, 200);
    assert.strictEqual(res1.status, 'REJECTED');
    assert.strictEqual(res2.status, 'REJECTED');
  });

  // Check 9: Input validation - missing or non-array resourceIds
  await runCheck(9, 'reserve returns REJECTED when resourceIds is empty or not an array', async () => {
    const engine = new ResourceEngine();
    const res1 = await engine.reserve('ev1', [], 100, 200);
    const res2 = await engine.reserve('ev1', 'not-an-array', 100, 200);
    assert.strictEqual(res1.status, 'REJECTED');
    assert.strictEqual(res2.status, 'REJECTED');
  });

  // Check 10: Input validation - start >= end
  await runCheck(10, 'reserve returns REJECTED when start >= end', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    const res1 = await engine.reserve('ev1', ['r1'], 200, 100);
    const res2 = await engine.reserve('ev1', ['r1'], 100, 100);
    assert.strictEqual(res1.status, 'REJECTED');
    assert.strictEqual(res2.status, 'REJECTED');
  });

  // Check 11: Input validation - non-numeric start or end
  await runCheck(11, 'reserve returns REJECTED when start or end is not a number', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    const res1 = await engine.reserve('ev1', ['r1'], '100', 200);
    const res2 = await engine.reserve('ev1', ['r1'], 100, NaN);
    assert.strictEqual(res1.status, 'REJECTED');
    assert.strictEqual(res2.status, 'REJECTED');
  });

  // Check 12: Normalization - numeric IDs converted to strings
  await runCheck(12, 'Numeric resource IDs are normalised to strings (1 and "1" are identical)', async () => {
    const engine = new ResourceEngine();
    engine.addResource('1');
    const res = await engine.reserve('ev1', [1], 100, 200);
    assert.strictEqual(res.status, 'RESERVED');
    assert.deepStrictEqual(res.resourceIds, ['1']);
  });

  // Check 13: Normalization - duplicate IDs deduplicated
  await runCheck(13, 'Duplicate resource IDs in a request are deduplicated', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    const res = await engine.reserve('ev1', ['r1', 'r1', 'r1'], 100, 200);
    assert.strictEqual(res.status, 'RESERVED');
    assert.deepStrictEqual(res.resourceIds, ['r1']);
  });

  // Check 14: Resource Pool Membership - missing resource returns NOT_FOUND
  await runCheck(14, 'reserve returns NOT_FOUND when resource is not in pool', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    const res = await engine.reserve('ev1', ['r1', 'unknown-res'], 100, 200);
    assert.strictEqual(res.status, 'NOT_FOUND');
    assert.strictEqual(res.resource, 'unknown-res');
  });

  // Check 15: Two-Phase Reservation - single resource RESERVED
  await runCheck(15, 'reserve successfully books single free resource with RESERVED status', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    const res = await engine.reserve('ev1', ['r1'], 100, 200);
    assert.strictEqual(res.status, 'RESERVED');
    assert.strictEqual(res.eventId, 'ev1');
    const b = engine.getBookings('r1');
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b[0].state, 'RESERVED');
  });

  // Check 16: Two-Phase Reservation - multi-resource RESERVED
  await runCheck(16, 'reserve successfully books multiple free resources', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    engine.addResource('r2');
    engine.addResource('r3');
    const res = await engine.reserve('ev1', ['r1', 'r2', 'r3'], 100, 200);
    assert.strictEqual(res.status, 'RESERVED');
    assert.strictEqual(engine.getBookings('r1').length, 1);
    assert.strictEqual(engine.getBookings('r2').length, 1);
    assert.strictEqual(engine.getBookings('r3').length, 1);
  });

  // Check 17: Overlap detection formula (start < otherEnd && otherStart < end)
  await runCheck(17, 'Availability checker detects overlap correctly', () => {
    const engine = new ResourceEngine();
    const bookings = [{ start: 100, end: 200, state: 'COMMITTED' }];
    assert.ok(engine.overlaps(bookings, 150, 250)); // partial right overlap
    assert.ok(engine.overlaps(bookings, 50, 150));  // partial left overlap
    assert.ok(engine.overlaps(bookings, 120, 180)); // contained inside
    assert.ok(engine.overlaps(bookings, 50, 250));  // completely encompassing
    assert.strictEqual(engine.overlaps(bookings, 200, 300), null); // touching right
    assert.strictEqual(engine.overlaps(bookings, 0, 100), null);   // touching left
  });

  // Check 18: Clash returns BUSY with resource and busyUntil
  await runCheck(18, 'reserve returns BUSY { resource, busyUntil } when resource is booked', async () => {
    const engine = new ResourceEngine();
    engine.addResource('venue:Main Hall');
    await engine.reserve('ev1', ['venue:Main Hall'], 100, 200);
    const clash = await engine.reserve('ev2', ['venue:Main Hall'], 150, 250);
    assert.strictEqual(clash.status, 'BUSY');
    assert.strictEqual(clash.resource, 'venue:Main Hall');
    assert.strictEqual(clash.busyUntil, 200);
  });

  // Check 19: All-or-nothing guarantee
  await runCheck(19, 'All-or-nothing: if 1 of 3 resources is busy, none are booked', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    engine.addResource('r2');
    engine.addResource('r3');
    await engine.reserve('ev1', ['r2'], 100, 200);
    const attempt = await engine.reserve('ev2', ['r1', 'r2', 'r3'], 100, 200);
    assert.strictEqual(attempt.status, 'BUSY');
    assert.strictEqual(attempt.resource, 'r2');
    assert.strictEqual(engine.getBookings('r1').length, 0);
    assert.strictEqual(engine.getBookings('r3').length, 0);
  });

  // Check 20: Deadlock prevention - Sorted lock acquisition
  await runCheck(20, 'Resources are locked in sorted order regardless of request order', async () => {
    const engine = new ResourceEngine();
    engine.addResource('B');
    engine.addResource('A');
    engine.addResource('C');
    const norm = engine._normalizeIds(['C', 'A', 'B']);
    assert.deepStrictEqual(norm, ['A', 'B', 'C']);
  });

  // Check 21: Deadlock prevention - Locks released in reverse order in finally
  await runCheck(21, 'Locks are released in reverse order (LIFO unwinding)', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    engine.addResource('r2');
    const order = [];
    const origReleaseR1 = engine.resources.get('r1').mutex.release.bind(engine.resources.get('r1').mutex);
    const origReleaseR2 = engine.resources.get('r2').mutex.release.bind(engine.resources.get('r2').mutex);
    engine.resources.get('r1').mutex.release = () => { order.push('r1'); origReleaseR1(); };
    engine.resources.get('r2').mutex.release = () => { order.push('r2'); origReleaseR2(); };

    await engine.reserve('ev1', ['r1', 'r2'], 100, 200);
    assert.deepStrictEqual(order, ['r2', 'r1']);
  });

  // Check 22: Touching intervals do not clash (half-open [start, end))
  await runCheck(22, 'Touching intervals [100, 200) and [200, 300) do not clash', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    const res1 = await engine.reserve('ev1', ['r1'], 100, 200);
    const res2 = await engine.reserve('ev2', ['r1'], 200, 300);
    assert.strictEqual(res1.status, 'RESERVED');
    assert.strictEqual(res2.status, 'RESERVED');
  });

  // Check 23: Per-event concurrency guard (REJECTED)
  await runCheck(23, 'Concurrent operation on the same event returns REJECTED', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    engine.inFlight.add('ev1');
    const attempt = await engine.reserve('ev1', ['r1'], 100, 200);
    assert.strictEqual(attempt.status, 'REJECTED');
    engine.inFlight.delete('ev1');
  });

  // Check 24: Commit transitions RESERVED to COMMITTED
  await runCheck(24, 'commit updates reservation state to COMMITTED', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    const res = await engine.commit('ev1');
    assert.strictEqual(res.status, 'COMMITTED');
    assert.strictEqual(engine.getBookings('r1')[0].state, 'COMMITTED');
  });

  // Check 25: Commit idempotency
  await runCheck(25, 'commit is idempotent (subsequent commits succeed with COMMITTED)', async () => {
    const engine = new ResourceEngine();
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    await engine.commit('ev1');
    const second = await engine.commit('ev1');
    assert.strictEqual(second.status, 'COMMITTED');
  });

  // Check 26: Commit on unknown or non-existent event returns NOT_FOUND
  await runCheck(26, 'commit returns NOT_FOUND when event has no active bookings', async () => {
    const engine = new ResourceEngine();
    const res = await engine.commit('non-existent');
    assert.strictEqual(res.status, 'NOT_FOUND');
  });

  // Check 27: Commit calls injected E3.save hook
  await runCheck(27, 'commit invokes injected E3.save hook with booking details', async () => {
    const e3 = new E3PersistenceStub();
    const engine = new ResourceEngine({ e3 });
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    await engine.commit('ev1');
    assert.strictEqual(e3.records.size, 1);
    assert.strictEqual(e3.records.get('ev1').start, 100);
  });

  // Check 28: Failed E3.save rolls reservation back and returns FAILED
  await runCheck(28, 'Failed E3.save rolls reservation back and returns FAILED', async () => {
    const e3 = new E3PersistenceStub();
    e3.setFailSave(true, 'DB disk full');
    const engine = new ResourceEngine({ e3 });
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    const res = await engine.commit('ev1');
    assert.strictEqual(res.status, 'FAILED');
    assert.ok(res.reason.includes('DB disk full'));
    assert.strictEqual(engine.getBookings('r1').length, 0); // Rolled back!
  });

  // Check 29: Release on RESERVED drops booking without calling E3.remove
  await runCheck(29, 'Releasing a RESERVED booking drops it without calling E3.remove', async () => {
    const e3 = new E3PersistenceStub();
    let removeCalled = false;
    e3.remove = async () => { removeCalled = true; };
    const engine = new ResourceEngine({ e3 });
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    const res = await engine.release('ev1');
    assert.strictEqual(res.status, 'RELEASED');
    assert.strictEqual(removeCalled, false);
    assert.strictEqual(engine.getBookings('r1').length, 0);
  });

  // Check 30: Release on COMMITTED calls E3.remove hook
  await runCheck(30, 'Releasing a COMMITTED booking calls E3.remove and returns RELEASED', async () => {
    const e3 = new E3PersistenceStub();
    const engine = new ResourceEngine({ e3 });
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    await engine.commit('ev1');
    assert.strictEqual(e3.records.size, 1);
    const res = await engine.release('ev1');
    assert.strictEqual(res.status, 'RELEASED');
    assert.strictEqual(e3.records.size, 0);
    assert.strictEqual(engine.getBookings('r1').length, 0);
  });

  // Check 31: Failed E3.remove keeps the allocation and returns FAILED
  await runCheck(31, 'Failed E3.remove keeps the allocation and returns FAILED', async () => {
    const e3 = new E3PersistenceStub();
    e3.setFailRemove(true, 'DB connection lost');
    const engine = new ResourceEngine({ e3 });
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    await engine.commit('ev1');
    const res = await engine.release('ev1');
    assert.strictEqual(res.status, 'FAILED');
    assert.ok(res.reason.includes('DB connection lost'));
    assert.strictEqual(engine.getBookings('r1').length, 1); // Allocation kept!
  });

  // Check 32: Release on non-existent event returns NOT_FOUND
  await runCheck(32, 'release returns NOT_FOUND when event has no bookings', async () => {
    const engine = new ResourceEngine();
    const res = await engine.release('unknown-ev');
    assert.strictEqual(res.status, 'NOT_FOUND');
  });

  // Check 33: Hold expiry - uncommitted reservation expires after holdTimeout
  await runCheck(33, 'Uncommitted reservation expires automatically after holdTimeout', async () => {
    const engine = new ResourceEngine({ holdTimeoutMs: 40 });
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(engine.getBookings('r1').length, 0);
  });

  // Check 34: Hold expiry frees resources for subsequent bookings
  await runCheck(34, 'Resource freed after hold expiry can be booked by another event', async () => {
    const engine = new ResourceEngine({ holdTimeoutMs: 40 });
    engine.addResource('r1');
    await engine.reserve('ev1', ['r1'], 100, 200);
    await new Promise(r => setTimeout(r, 60));
    const next = await engine.reserve('ev2', ['r1'], 100, 200);
    assert.strictEqual(next.status, 'RESERVED');
  });

  // Check 35: isFree is read-only and returns true for unbooked resource
  await runCheck(35, 'isFree returns true for free resource without locking or reserving', () => {
    const engine = new ResourceEngine();
    engine.addResource('venue:Seminar');
    const check = engine.isFree('venue:Seminar', 100, 200);
    assert.strictEqual(check.free, true);
    assert.strictEqual(engine.getBookings('venue:Seminar').length, 0);
    assert.strictEqual(engine.resources.get('venue:Seminar').mutex.locked, false);
  });

  // Check 36: isFree returns false and busyUntil for booked resource
  await runCheck(36, 'isFree returns false with busyUntil for booked resource', async () => {
    const engine = new ResourceEngine();
    engine.addResource('venue:Seminar');
    await engine.reserve('ev1', ['venue:Seminar'], 100, 200);
    const check = engine.isFree('venue:Seminar', 150, 250);
    assert.strictEqual(check.free, false);
    assert.strictEqual(check.busyUntil, 200);
  });

  console.log('\n----------------------------------------------------------------');
  console.log(`Unit Test Results: ${passedChecks}/36 passed, ${failedChecks} failed.`);
  console.log('----------------------------------------------------------------\n');

  if (failedChecks > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAllChecks();
}

module.exports = { runAllChecks };
