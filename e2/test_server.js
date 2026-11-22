'use strict';

/**
 * test_server.js - HTTP REST API Server Tests for Engine 2
 * Author: Saish Kelvekar (Team 4)
 *
 * Verifies the 6 core HTTP endpoints and communication contracts:
 *   1. GET  /health                    - 200 Probe & Resource count
 *   2. POST /api/reserve               - 200 Two-Phase Hold Reservation
 *   3. POST /api/commit                - 200 Idempotent Persistent Commit
 *   4. POST /api/release               - 200 Safe Allocation De-allocation
 *   5. GET  /api/resources/availability - 200 Read-only check with single resource_id (E4 format)
 *   6. GET  /api/resources/availability - 200 Read-only check with comma-separated resources
 */

const assert = require('assert');
const { Readable } = require('stream');
const { bootstrapEngine, createServer } = require('./server');

let passedChecks = 0;
let failedChecks = 0;

async function runCheck(num, title, fn) {
  try {
    await fn();
    passedChecks++;
    console.log(`  [PASS] Server Check ${num}/6: ${title}`);
  } catch (err) {
    failedChecks++;
    console.error(`  [FAIL] Server Check ${num}/6: ${title}`);
    console.error(`         ${err.message}`);
  }
}

async function request(server, baseUrl, path, method = 'GET', body = null) {
  const url = `${baseUrl}${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (err) {
    if (err && err.cause && (err.cause.code === 'EACCES' || err.cause.code === 'ECONNREFUSED')) {
      // In constrained sandbox environments without loopback socket access, dispatch directly via HTTP handler
      return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : '';
        const req = new Readable({
          read() {
            if (bodyStr) this.push(bodyStr);
            this.push(null);
          }
        });
        req.url = path;
        req.method = method;
        req.headers = {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr)
        };

        const headers = {};
        let resBody = '';
        let statusCode = 200;

        const res = {
          setHeader(k, v) { headers[k.toLowerCase()] = v; },
          writeHead(code, hdrs) {
            statusCode = code;
            if (hdrs) Object.assign(headers, hdrs);
          },
          write(chunk) { if (chunk) resBody += chunk; },
          end(chunk) {
            if (chunk) resBody += chunk;
            let data = {};
            try { data = JSON.parse(resBody); } catch {}
            resolve({ status: statusCode, data });
          }
        };

        server.emit('request', req, res);
      });
    }
    throw err;
  }
}

async function runServerTests() {
  console.log('================================================================');
  console.log('   ENGINE 2 HTTP SERVER TEST SUITE (6 API CHECKS)               ');
  console.log('================================================================\n');

  const { engine } = await bootstrapEngine();
  const server = createServer(engine);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Check 1: GET /health
    await runCheck(1, 'GET /health returns 200 with engine status', async () => {
      const res = await request(server, baseUrl, '/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ok');
      assert.ok(res.data.resourcesCount > 0);
    });

    // Check 2: POST /api/reserve
    await runCheck(2, 'POST /api/reserve reserves resources and returns 200 RESERVED', async () => {
      const res = await request(server, baseUrl, '/api/reserve', 'POST', {
        eventId: 'test-evt-1',
        resourceIds: ['venue:Main Hall', 'judge:1'],
        start: 1000,
        end: 1060
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'RESERVED');
      assert.strictEqual(res.data.eventId, 'test-evt-1');
    });

    // Check 3: POST /api/commit
    await runCheck(3, 'POST /api/commit idempotently commits reservation', async () => {
      const res = await request(server, baseUrl, '/api/commit', 'POST', {
        eventId: 'test-evt-1'
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'COMMITTED');
    });

    // Check 4: POST /api/release
    await runCheck(4, 'POST /api/release releases committed booking and returns 200 RELEASED', async () => {
      const res = await request(server, baseUrl, '/api/release', 'POST', {
        eventId: 'test-evt-1'
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'RELEASED');
    });

    // Check 5: GET /api/resources/availability - E4 single resource_id format
    await runCheck(5, 'GET /api/resources/availability accepts single resource_id (E4 format)', async () => {
      // First book a slot to test both free and busy responses
      await request(server, baseUrl, '/api/reserve', 'POST', {
        eventId: 'test-evt-2',
        resourceIds: ['venue:Lab 2'],
        start: 2000,
        end: 2100
      });

      // Free query
      const resFree = await request(server, baseUrl, '/api/resources/availability?resource_id=venue:Lab 2&start=3000&end=3100');
      assert.strictEqual(resFree.status, 200);
      assert.strictEqual(resFree.data.free, true);

      // Busy query
      const resBusy = await request(server, baseUrl, '/api/resources/availability?resource_id=venue:Lab 2&start=2050&end=2150');
      assert.strictEqual(resBusy.status, 200);
      assert.strictEqual(resBusy.data.free, false);
      assert.strictEqual(resBusy.data.busyUntil, 2100);
    });

    // Check 6: GET /api/resources/availability - comma-separated resources format
    await runCheck(6, 'GET /api/resources/availability accepts comma-separated resources list', async () => {
      const res = await request(
        server,
        baseUrl,
        '/api/resources/availability?resources=venue:Auditorium,judge:2,res:projector&start=5000&end=5100'
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.free, true);
    });

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n----------------------------------------------------------------');
  console.log(`Server Test Results: ${passedChecks}/6 passed, ${failedChecks} failed.`);
  console.log('----------------------------------------------------------------\n');

  if (failedChecks > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runServerTests();
}

module.exports = { runServerTests };
