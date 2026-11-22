'use strict';

/**
 * run_all.js - Master Test Runner for Engine 2
 * Author: Saish Kelvekar (Team 4)
 *
 * Runs the full test suite in sequence:
 *   1. Unit Tests (36 checks in test_e2.js)
 *   2. Server Tests (6 checks in test_server.js)
 *   3. Adapter Tests (8 checks in test/adapters.test.js)
 *   4. Concurrency Stress Test (200 concurrent requests in test/concurrency.test.js)
 */

const { runAllChecks } = require('../test_e2');
const { runServerTests } = require('../test_server');
const { runAdapterTests } = require('./adapters.test');
const { runConcurrencyStressTest } = require('./concurrency.test');

async function main() {
  const t0 = performance.now();
  console.log('################################################################');
  console.log('           STARTING COMPLETE ENGINE 2 TEST SUITE                ');
  console.log('################################################################\n');

  await runAllChecks();
  await runServerTests();
  await runAdapterTests();
  await runConcurrencyStressTest();

  const totalTime = ((performance.now() - t0) / 1000).toFixed(2);
  console.log('################################################################');
  console.log(`  ALL TEST SUITES PASSED CLEANLY IN ${totalTime}s! (0 FAILURES)`);
  console.log('################################################################');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { main };
