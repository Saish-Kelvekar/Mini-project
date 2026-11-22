'use strict';

/**
 * e1_adapter.js - Adapter for Engine 1 (Scheduler -> E2)
 * Author: Saish Kelvekar (Team 4)
 *
 * Bridges the interface differences between:
 *   1. Handbook 4.12 / 4.19 specification:
 *      checkAndReserve({ resource_type, resource_id, start, end, event_id })
 *      Returns { free: true, alloc_id } or { free: false, reason }.
 *   2. E1 actual implementation (e1/src/index.js E2Client):
 *      checkAndReserve({ eventId, resourceIds, start, end })
 *      Returns { status: 'RESERVED', eventId } or { status: 'BUSY', resource, busyUntil }.
 *
 * How alloc_id is produced:
 *   Deterministic unique identifier combining eventId, sanitized resource keys, and start timestamp:
 *   `alloc_${eventId}_${resourceKeys}_${start}`
 */

function parseTimeValue(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    // If numeric string
    if (!isNaN(Number(val))) return Number(val);
    // If ISO date string
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return parsed;
  }
  return NaN;
}

class E1Adapter {
  constructor(engine) {
    if (!engine) throw new Error('ResourceEngine instance required');
    this.engine = engine;
  }

  /**
   * Universal checkAndReserve supporting both handbook specification
   * and live E1 client calls.
   */
  async checkAndReserve(params = {}) {
    const eventId = params.eventId ?? params.event_id;
    let resourceIds = [];

    if (Array.isArray(params.resourceIds)) {
      resourceIds = params.resourceIds;
    } else if (Array.isArray(params.resource_ids)) {
      resourceIds = params.resource_ids;
    } else if (params.resource_id !== undefined && params.resource_id !== null) {
      resourceIds = [params.resource_id];
    } else if (params.resourceId !== undefined && params.resourceId !== null) {
      resourceIds = [params.resourceId];
    }

    const start = parseTimeValue(params.start);
    const end = parseTimeValue(params.end);

    // Auto-register resources if not present (aligns with E1 expectations)
    for (const rid of resourceIds) {
      const norm = String(rid).trim();
      if (!this.engine.hasResource(norm)) {
        this.engine.addResource(norm, {
          type: params.resource_type || (norm.startsWith('venue:') ? 'Venue' : norm.startsWith('judge:') ? 'Judge' : 'resource')
        });
      }
    }

    const result = await this.engine.reserve(eventId, resourceIds, start, end);

    if (result.status === 'RESERVED') {
      const sanitized = resourceIds.map(r => String(r).replace(/[^a-zA-Z0-9_-]/g, '_')).join('+');
      const alloc_id = `alloc_${eventId}_${sanitized}_${start}`;
      return {
        free: true,
        alloc_id,
        status: 'RESERVED',
        eventId: result.eventId,
        resourceIds: result.resourceIds,
        start: result.start,
        end: result.end
      };
    }

    if (result.status === 'BUSY') {
      return {
        free: false,
        status: 'BUSY',
        resource: result.resource,
        busyUntil: result.busyUntil,
        reason: `Resource ${result.resource} is busy until ${result.busyUntil}`
      };
    }

    return {
      free: false,
      status: result.status,
      reason: result.reason || `Reservation returned status ${result.status}`
    };
  }

  async reserve(eventId, resourceIds, start, end, options) {
    return this.checkAndReserve({ eventId, resourceIds, start, end, ...options });
  }

  async commit(eventId) {
    return this.engine.commit(eventId);
  }

  async release(eventId) {
    return this.engine.release(eventId);
  }

  isFree(resourceId, start, end) {
    const s = parseTimeValue(start);
    const e = parseTimeValue(end);
    return this.engine.isFree(resourceId, s, e);
  }
}

module.exports = { E1Adapter, parseTimeValue };
