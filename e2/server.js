'use strict';

/**
 * server.js - Engine 2 HTTP REST API Server
 * Author: Saish Kelvekar (Team 4)
 *
 * REST Endpoints:
 *   POST /api/reserve               - Reserve resources with hold TTL
 *   POST /api/commit                - Idempotently commit a reservation (persists via E3)
 *   POST /api/release               - Release a reservation or committed allocation
 *   GET  /api/resources/availability - Read-only availability check (supports E4 single resource_id & comma-separated list)
 *   GET  /health                    - Health check probe
 */

const http = require('http');
const { ResourceEngine } = require('./e2_engine');
const { E3PersistenceStub } = require('./e3_stub');
const { E3Adapter } = require('./adapters/e3_adapter');
const { parseTimeValue } = require('./adapters/e1_adapter');

const SEED_RESOURCES = [
  { id: 'venue:Main Hall', type: 'Venue', name: 'Main Hall', capacity: 500 },
  { id: 'venue:Auditorium', type: 'Venue', name: 'Auditorium', capacity: 300 },
  { id: 'venue:Seminar Hall', type: 'Venue', name: 'Seminar Hall', capacity: 150 },
  { id: 'venue:Lab 1', type: 'Venue', name: 'Lab 1', capacity: 60 },
  { id: 'venue:Lab 2', type: 'Venue', name: 'Lab 2', capacity: 60 },
  { id: 'venue:Lab 3', type: 'Venue', name: 'Lab 3', capacity: 60 },
  { id: 'judge:1', type: 'Judge', name: 'Judge 1' },
  { id: 'judge:2', type: 'Judge', name: 'Judge 2' },
  { id: 'judge:3', type: 'Judge', name: 'Judge 3' },
  { id: 'judge:4', type: 'Judge', name: 'Judge 4' },
  { id: 'judge:5', type: 'Judge', name: 'Judge 5' },
  { id: 'judge:6', type: 'Judge', name: 'Judge 6' },
  { id: 'res:projector', type: 'Equipment', name: 'Projector' },
  { id: 'res:mics', type: 'Equipment', name: 'Mics' },
  { id: 'res:sound system', type: 'Equipment', name: 'Sound System' },
  { id: 'res:stage', type: 'Equipment', name: 'Stage' }
];

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function bootstrapEngine(options = {}) {
  const persistence = options.persistence || new E3Adapter({ fallbackStub: new E3PersistenceStub(), useFallback: true });
  const engine = options.engine || new ResourceEngine({
    e3: persistence,
    holdTimeoutMs: options.holdTimeoutMs || 30000,
    lockTimeoutMs: options.lockTimeoutMs || 5000
  });

  // Step 3: Load resources from persistence if available, else seed list
  let resources = [];
  if (typeof persistence.loadResources === 'function') {
    try {
      resources = await persistence.loadResources();
    } catch {
      resources = SEED_RESOURCES;
    }
  }
  if (!resources || resources.length === 0) {
    resources = SEED_RESOURCES;
  }

  for (const r of resources) {
    engine.addResource(r.id, r);
  }

  // Step 3: Call loadAllocations before server accepts requests
  if (typeof persistence.loadAllocations === 'function') {
    try {
      const existing = await persistence.loadAllocations();
      engine.loadAllocations(existing);
    } catch {}
  }

  return { engine, persistence };
}

function createServer(engine) {
  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      // GET /health
      if (pathname === '/health' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          engine: 'E2 Resource Availability & Allocation',
          resourcesCount: engine.resources.size
        });
      }

      // GET /api/resources/availability
      // Accepts:
      //   - E4 format: ?resource_id=venue:Lab 1&start=...&end=...
      //   - List format: ?resources=venue:Lab 1,judge:1&start=...&end=...
      if (pathname === '/api/resources/availability' && method === 'GET') {
        let rIds = [];
        if (query.resources) {
          rIds = query.resources.split(',').map(s => s.trim()).filter(Boolean);
        } else if (query.resource_id) {
          rIds = [query.resource_id.trim()];
        } else if (query.resourceId) {
          rIds = [query.resourceId.trim()];
        }

        if (rIds.length === 0) {
          return sendJson(res, 400, { free: false, reason: 'Missing resource_id or resources query parameter' });
        }

        const start = parseTimeValue(query.start);
        const end = parseTimeValue(query.end);
        if (isNaN(start) || isNaN(end) || start >= end) {
          return sendJson(res, 400, { free: false, reason: 'Invalid or missing start/end parameters (start < end required)' });
        }

        for (const rid of rIds) {
          const check = engine.isFree(rid, start, end);
          if (!check.free) {
            return sendJson(res, 200, {
              free: false,
              resource: rid,
              reason: check.reason || 'BUSY',
              busyUntil: check.busyUntil
            });
          }
        }

        return sendJson(res, 200, { free: true });
      }

      // POST /api/reserve
      if (pathname === '/api/reserve' && method === 'POST') {
        const body = await parseJsonBody(req);
        const eventId = body.eventId ?? body.event_id;
        let resourceIds = [];

        if (Array.isArray(body.resourceIds)) {
          resourceIds = body.resourceIds;
        } else if (Array.isArray(body.resource_ids)) {
          resourceIds = body.resource_ids;
        } else if (typeof body.resources === 'string') {
          resourceIds = body.resources.split(',').map(s => s.trim()).filter(Boolean);
        } else if (body.resource_id) {
          resourceIds = [body.resource_id];
        } else if (body.resourceId) {
          resourceIds = [body.resourceId];
        }

        const start = parseTimeValue(body.start);
        const end = parseTimeValue(body.end);

        const result = await engine.reserve(eventId, resourceIds, start, end, {
          holdTimeoutMs: body.holdTimeoutMs
        });

        if (result.status === 'RESERVED') {
          return sendJson(res, 200, result);
        }
        if (result.status === 'BUSY') {
          return sendJson(res, 200, result);
        }
        if (result.status === 'NOT_FOUND') {
          return sendJson(res, 404, result);
        }
        if (result.status === 'RETRY') {
          return sendJson(res, 503, result);
        }
        if (result.status === 'REJECTED') {
          return sendJson(res, 400, result);
        }
        return sendJson(res, 500, result);
      }

      // POST /api/commit
      if (pathname === '/api/commit' && method === 'POST') {
        const body = await parseJsonBody(req);
        const eventId = body.eventId ?? body.event_id;
        const result = await engine.commit(eventId);

        if (result.status === 'COMMITTED') {
          return sendJson(res, 200, result);
        }
        if (result.status === 'NOT_FOUND') {
          return sendJson(res, 404, result);
        }
        if (result.status === 'REJECTED') {
          return sendJson(res, 400, result);
        }
        if (result.status === 'RETRY') {
          return sendJson(res, 503, result);
        }
        return sendJson(res, 500, result);
      }

      // POST /api/release
      if (pathname === '/api/release' && method === 'POST') {
        const body = await parseJsonBody(req);
        const eventId = body.eventId ?? body.event_id;
        const result = await engine.release(eventId);

        if (result.status === 'RELEASED') {
          return sendJson(res, 200, result);
        }
        if (result.status === 'NOT_FOUND') {
          return sendJson(res, 404, result);
        }
        if (result.status === 'REJECTED') {
          return sendJson(res, 400, result);
        }
        if (result.status === 'RETRY') {
          return sendJson(res, 503, result);
        }
        return sendJson(res, 500, result);
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || 'Internal server error' });
    }
  });
}

async function startServer(port = process.env.PORT || 4002) {
  const { engine, persistence } = await bootstrapEngine();
  const server = createServer(engine);
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[E2] Resource Engine server listening on port ${port}`);
      resolve({ server, engine, persistence });
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { createServer, bootstrapEngine, startServer, SEED_RESOURCES };
