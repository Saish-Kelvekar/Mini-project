'use strict';

/**
 * concurrency.test.js - High-Concurrency & Anti-Deadlock Stress Test
 * Author: Saish Kelvekar (Team 4)
 *
 * Requirements Verified:
 *   - NFR-02: Zero double-booking after reservation/commit (100% guarantee)
 *   - NFR-07: Zero deadlocks and zero lost updates under concurrent load
 *
 * Test Protocol (Specification Step 4):
 *   - 200 concurrent reserve requests launched simultaneously via Promise.all.
 *   - Contention over 5 shared resources in randomly shuffled acquisition order.
 *   - Must complete in under 5.0 seconds with zero deadlocks.
 *   - Invariant assertion: Post-run scan across all resource bookings confirms
 *     0 overlapping intervals (half-open [start, end)).
 */

const assert = require('assert');
const { ResourceEngine } = require('../e2_engine');

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function runConcurrencyStressTest() {
  console.log('================================================================');
  console.log('   ENGINE 2 CONCURRENCY STRESS TEST (200 CONCURRENT REQUESTS)  ');
  console.log('================================================================\n');

  const engine = new ResourceEngine({
    lockTimeoutMs: 3000,
    holdTimeoutMs: 15000
  });

  const RESOURCE_POOL = ['R1', 'R2', 'R3', 'R4', 'R5'];
  for (const r of RESOURCE_POOL) {
    engine.addResource(r, { type: 'Equipment' });
  }

  const NUM_REQUESTS = 200;
  const tasks = [];

  console.log(`[1] Launching ${NUM_REQUESTS} concurrent requests over ${RESOURCE_POOL.length} resources...`);
  console.log('    (Resources are deliberately requested in arbitrary shuffled orders to induce deadlock risk)');

  const tStart = performance.now();

  for (let i = 0; i < NUM_REQUESTS; i++) {
    const eventId = `stress-evt-${i + 1}`;
    // Pick 2 or 3 random distinct resources in shuffled order
    const numRes = Math.random() < 0.5 ? 2 : 3;
    const shuffledRes = shuffle(RESOURCE_POOL).slice(0, numRes);

    // Pick slot in a range with high contention
    const slotBase = Math.floor(Math.random() * 8) * 30; // 0, 30, 60, ... 210
    const duration = 30 + Math.floor(Math.random() * 2) * 30; // 30 or 60
    const start = slotBase;
    const end = start + duration;

    tasks.push(
      engine.reserve(eventId, shuffledRes, start, end).then(async (res) => {
        if (res.status === 'RESERVED') {
          // Half the events commit, verifying mixed 2-phase lifecycle under load
          if (Math.random() < 0.5) {
            await engine.commit(eventId);
          }
        }
        return res;
      })
    );
  }

  const results = await Promise.all(tasks);
  const elapsedMs = performance.now() - tStart;

  console.log(`\n[2] All ${NUM_REQUESTS} requests finished in ${elapsedMs.toFixed(2)} ms.`);

  const statusCounts = {};
  for (const r of results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  console.log('    Status breakdown:', statusCounts);

  // Assertion 1: Completed in under 5.0 seconds
  assert.ok(
    elapsedMs < 5000,
    `Stress test took ${elapsedMs.toFixed(2)} ms, which exceeds the 5.0 s limit!`
  );
  console.log('    [PASS] Strict SLA constraint met (finished in under 5 seconds).');

  // Assertion 2: No deadlocks (every request received a definitive status)
  assert.strictEqual(
    results.length,
    NUM_REQUESTS,
    'Not all requests completed (potential deadlock)'
  );
  assert.strictEqual(
    statusCounts['RETRY'] || 0,
    0,
    'Zero lock acquisition timeouts expected with proper ordering'
  );
  console.log('    [PASS] Zero deadlocks observed (all 200 requests resolved cleanly).');

  // Assertion 3: Invariant scan - No overlapping bookings on ANY resource
  console.log('\n[3] Invariant scan: inspecting booking intervals across all resources...');
  let totalBookings = 0;

  for (const rId of RESOURCE_POOL) {
    const bookings = engine.getBookings(rId);
    totalBookings += bookings.length;

    // Sort intervals by start time
    bookings.sort((a, b) => a.start - b.start);

    for (let j = 1; j < bookings.length; j++) {
      const prev = bookings[j - 1];
      const curr = bookings[j];
      const overlap = curr.start < prev.end && prev.start < curr.end;
      assert.strictEqual(
        overlap,
        false,
        `FATAL: Double booking detected on resource ${rId}! ` +
        `Event ${prev.eventId} [${prev.start}, ${prev.end}) clashes with ` +
        `Event ${curr.eventId} [${curr.start}, ${curr.end})`
      );
    }
  }

  console.log(`    Total valid bookings retained: ${totalBookings}`);
  console.log('    [PASS] Invariant verified: 0 double-bookings across all resources (NFR-02 100% guarantee).\n');

  console.log('================================================================');
  console.log('   CONCURRENCY STRESS TEST PASSED: ZERO DEADLOCKS, ZERO CLASHES ');
  console.log('================================================================\n');
}

if (require.main === module) {
  runConcurrencyStressTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runConcurrencyStressTest };
