'use strict';

/**
 * adapters.test.js - Test Suite for E1 and E3 Adapters
 * Author: Saish Kelvekar (Team 4)
 *
 * Verifies:
 *   1. E1 Adapter: Handbook single-resource checkAndReserve ({ resource_type, resource_id, start, end, event_id })
 *   2. E1 Adapter: alloc_id deterministic generation
 *   3. E1 Adapter: Live E1 array-based checkAndReserve ({ eventId, resourceIds, start, end })
 *   4. E1 Adapter: BUSY response mapping
 *   5. E1 Adapter: Time value parsing (numbers, numeric strings, ISO strings)
 *   6. E1 Adapter: Commit and release forwarding
 *   7. E3 Adapter: Save, remove, and loadAllocations operations
 *   8. E3 Adapter: Fallback resilience when database pool is offline
 */

const assert = require('assert');
const { ResourceEngine } = require('../e2_engine');
const { E1Adapter, parseTimeValue } = require('../adapters/e1_adapter');
const { E3Adapter } = require('../adapters/e3_adapter');
const { E3PersistenceStub } = require('../e3_stub');

let passedChecks = 0;
let failedChecks = 0;

async function check(title, fn) {
  try {
    await fn();
    passedChecks++;
    console.log(`  [PASS] Adapter Check: ${title}`);
  } catch (err) {
    failedChecks++;
    console.error(`  [FAIL] Adapter Check: ${title}`);
    console.error(`         ${err.message}`);
  }
}

async function runAdapterTests() {
  console.log('================================================================');
  console.log('   ENGINE 2 ADAPTER TEST SUITE (E1 & E3 INTEGRATION)           ');
  console.log('================================================================\n');

  // 1. E1 Adapter: Handbook shape
  await check('E1 Adapter handles handbook checkAndReserve ({ resource_id, event_id })', async () => {
    const engine = new ResourceEngine();
    const adapter = new E1Adapter(engine);
    const reply = await adapter.checkAndReserve({
      resource_type: 'Venue',
      resource_id: 'venue:Main Hall',
      start: 540,
      end: 660,
      event_id: 'evt-hb-1'
    });
    assert.strictEqual(reply.free, true);
    assert.strictEqual(reply.status, 'RESERVED');
    assert.ok(reply.alloc_id.startsWith('alloc_evt-hb-1_venue_Main_Hall_540'));
  });

  // 2. E1 Adapter: alloc_id deterministic generation
  await check('E1 Adapter produces deterministic alloc_id format', async () => {
    const engine = new ResourceEngine();
    const adapter = new E1Adapter(engine);
    const reply = await adapter.checkAndReserve({
      eventId: 'evt-hb-2',
      resourceIds: ['res:mics', 'venue:Lab 1'],
      start: 700,
      end: 800
    });
    assert.strictEqual(reply.free, true);
    assert.strictEqual(reply.alloc_id, 'alloc_evt-hb-2_res_mics+venue_Lab_1_700');
  });

  // 3. E1 Adapter: Live E1 array-based call
  await check('E1 Adapter handles live E1 array-based checkAndReserve', async () => {
    const engine = new ResourceEngine();
    const adapter = new E1Adapter(engine);
    const reply = await adapter.checkAndReserve({
      eventId: 'evt-live-1',
      resourceIds: ['venue:Seminar', 'judge:1', 'res:projector'],
      start: 600,
      end: 720
    });
    assert.strictEqual(reply.free, true);
    assert.strictEqual(reply.status, 'RESERVED');
    assert.strictEqual(reply.eventId, 'evt-live-1');
  });

  // 4. E1 Adapter: Conflict returns BUSY
  await check('E1 Adapter maps overlap to free: false and status: BUSY', async () => {
    const engine = new ResourceEngine();
    const adapter = new E1Adapter(engine);
    await adapter.checkAndReserve({
      eventId: 'evt-1',
      resourceIds: ['venue:Seminar'],
      start: 600,
      end: 720
    });
    const clash = await adapter.checkAndReserve({
      eventId: 'evt-2',
      resourceIds: ['venue:Seminar'],
      start: 650,
      end: 750
    });
    assert.strictEqual(clash.free, false);
    assert.strictEqual(clash.status, 'BUSY');
    assert.strictEqual(clash.resource, 'venue:Seminar');
    assert.strictEqual(clash.busyUntil, 720);
    assert.ok(clash.reason.includes('busy until 720'));
  });

  // 5. E1 Adapter: Time value parsing
  await check('parseTimeValue handles numeric minutes, numeric strings, and ISO dates', () => {
    assert.strictEqual(parseTimeValue(540), 540);
    assert.strictEqual(parseTimeValue('600'), 600);
    const iso = '2026-11-25T09:00:00.000Z';
    assert.strictEqual(parseTimeValue(iso), Date.parse(iso));
    assert.ok(isNaN(parseTimeValue('invalid-date')));
  });

  // 6. E1 Adapter: Commit and release forwarding
  await check('E1 Adapter forwards commit and release to engine', async () => {
    const engine = new ResourceEngine();
    const adapter = new E1Adapter(engine);
    await adapter.checkAndReserve({
      eventId: 'evt-lifecycle',
      resourceIds: ['res:stage'],
      start: 100,
      end: 200
    });
    const c = await adapter.commit('evt-lifecycle');
    assert.strictEqual(c.status, 'COMMITTED');
    const r = await adapter.release('evt-lifecycle');
    assert.strictEqual(r.status, 'RELEASED');
  });

  // 7. E3 Adapter: Save, remove, and loadAllocations with stub
  await check('E3 Adapter performs save, remove, and loadAllocations', async () => {
    const stub = new E3PersistenceStub();
    const adapter = new E3Adapter({ stub, useFallback: true });

    await adapter.save({
      eventId: 'evt-db-1',
      resourceIds: ['venue:Main Hall', 'judge:1'],
      start: 500,
      end: 600
    });
    assert.strictEqual(stub.records.size, 1);

    const loaded = await adapter.loadAllocations();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].eventId, 'evt-db-1');

    const removed = await adapter.remove('evt-db-1');
    assert.strictEqual(removed, true);
    assert.strictEqual(stub.records.size, 0);
  });

  // 8. E3 Adapter: Fallback resilience
  await check('E3 Adapter safely falls back when database pool is unavailable', async () => {
    const adapter = new E3Adapter({ pool: null, useFallback: true });
    const resources = await adapter.loadResources();
    assert.ok(Array.isArray(resources));
    assert.ok(resources.length > 0);
  });

  console.log('\n----------------------------------------------------------------');
  console.log(`Adapter Test Results: ${passedChecks}/8 passed, ${failedChecks} failed.`);
  console.log('----------------------------------------------------------------\n');

  if (failedChecks > 0) process.exit(1);
}

if (require.main === module) {
  runAdapterTests();
}

module.exports = { runAdapterTests };
