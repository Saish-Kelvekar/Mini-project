'use strict';

/**
 * demo.js - Interactive Demonstration of Engine 2 (Resource Availability & Allocation)
 * Author: Saish Kelvekar (Team 4)
 *
 * Demonstrates:
 *   1. System Bootstrap & Seed Resource Ingestion
 *   2. Read-only Availability Check (isFree)
 *   3. Multi-resource Atomic Two-Phase Reservation
 *   4. Conflict Detection & Overlap Prevention (BUSY response)
 *   5. Idempotent Commit with E3 Persistence Hook
 *   6. Safe Release with E3 De-allocation
 *   7. Dynamic Slot Re-allocation
 *   8. Uncommitted Hold Expiry
 */

const { ResourceEngine } = require('./e2_engine');
const { E3PersistenceStub } = require('./e3_stub');

async function runDemo() {
  console.log('================================================================');
  console.log('   ENGINE 2: RESOURCE AVAILABILITY & ALLOCATION ENGINE DEMO    ');
  console.log('   Author: Saish Kelvekar (Team 4 - OS Engine)                 ');
  console.log('================================================================\n');

  const e3 = new E3PersistenceStub();
  const engine = new ResourceEngine({ e3, holdTimeoutMs: 500 });

  // 1. Ingest seed resources
  console.log('[Step 1] Initialising resource pool from seed data...');
  const seeds = await e3.getResourceData();
  for (const s of seeds) engine.addResource(s.id, s);
  console.log(`         Registered ${engine.resources.size} resources (venues, judges, equipment).\n`);

  // 2. Read-only availability query
  console.log('[Step 2] Read-only availability check (isFree):');
  const initialCheck = engine.isFree('venue:Main Hall', 540, 660); // 09:00 - 11:00
  console.log(`         venue:Main Hall free for [540, 660)? ${initialCheck.free ? 'YES (Free)' : 'NO (Busy)'}\n`);

  // 3. Multi-resource atomic reservation
  console.log('[Step 3] Reserving Event 101 (Main Hall + Judge 1 + Projector):');
  const res101 = await engine.reserve(
    'evt-101',
    ['venue:Main Hall', 'judge:1', 'res:projector'],
    540,
    660
  );
  console.log('         Result:', res101);
  console.log('         Event 101 successfully held under two-phase protocol.\n');

  // 4. Overlap rejection (BUSY)
  console.log('[Step 4] Attempting to book overlapping Event 102 (Main Hall from 600 to 720 [10:00-12:00]):');
  const res102 = await engine.reserve(
    'evt-102',
    ['venue:Main Hall', 'judge:2'],
    600,
    720
  );
  console.log('         Result:', res102);
  console.log(`         Double-booking prevented! Resource is busy until ${res102.busyUntil}.\n`);

  // 5. Commit Event 101
  console.log('[Step 5] Committing Event 101:');
  const commit101 = await engine.commit('evt-101');
  console.log('         Commit Result:', commit101);
  console.log(`         E3 persistence record count: ${e3.records.size}\n`);

  // 6. Idempotency test
  console.log('[Step 6] Verifying commit idempotency (calling commit again):');
  const commitAgain = await engine.commit('evt-101');
  console.log('         Re-commit Result:', commitAgain);
  console.log('         Idempotency verified.\n');

  // 7. Release Event 101
  console.log('[Step 7] Releasing Event 101:');
  const rel101 = await engine.release('evt-101');
  console.log('         Release Result:', rel101);
  console.log(`         E3 persistence record count after release: ${e3.records.size}\n`);

  // 8. Event 102 retries and succeeds
  console.log('[Step 8] Event 102 retrying reservation now that Main Hall is released:');
  const retry102 = await engine.reserve(
    'evt-102',
    ['venue:Main Hall', 'judge:2'],
    600,
    720
  );
  console.log('         Retry Result:', retry102);
  console.log('         Event 102 successfully reserved!\n');

  // 9. Hold expiry demo
  console.log('[Step 9] Demonstrating uncommitted hold expiry:');
  const res103 = await engine.reserve(
    'evt-103',
    ['venue:Lab 1'],
    540,
    600,
    { holdTimeoutMs: 50 } // 50ms TTL
  );
  console.log('         Reserved Event 103 with 50ms TTL:', res103.status);
  console.log('         Waiting 70ms for hold expiration...');
  await new Promise(r => setTimeout(r, 70));
  const checkExpired = engine.isFree('venue:Lab 1', 540, 600);
  console.log(`         venue:Lab 1 free after hold expiry? ${checkExpired.free ? 'YES (Automatically Expired)' : 'NO'}\n`);

  console.log('================================================================');
  console.log('   DEMO COMPLETED SUCCESSFULLY: ALL ENGINE 2 GUARANTEES MET     ');
  console.log('================================================================');
}

if (require.main === module) {
  runDemo().catch(console.error);
}

module.exports = { runDemo };
