'use strict';

/**
 * e2_engine.js - Engine 2: Resource Availability & Allocation
 * Author: Saish Kelvekar (Team 4, Operating Systems engine)
 *
 * Purpose:
 *   Authoritative gatekeeper of venues, judges, coordinators, and equipment.
 *   Guarantees that one resource is never given to two overlapping events.
 *
 * Requirements Covered:
 *   - FR-03: Assign judges, venues, coordinators, equipment
 *   - NFR-02: Zero double-booking after commit (100% guarantee)
 *   - NFR-07: Zero deadlocks and zero lost updates under concurrent requests
 *
 * Architecture & Internal Components:
 *   1. Request Handler: Validates input, normalises IDs to strings, deduplicates, and sorts.
 *   2. Lock Manager: One FIFO mutex per resource with configurable timeout and deadlock prevention.
 *   3. Availability Checker: Overlap test [start, end) evaluated strictly while holding mutexes.
 *   4. Reservation Manager: Two-Phase protocol (Reserve -> Hold -> Commit/Release) with TTL expiry.
 *
 * Rules:
 *   1. Lock BEFORE check. Lock unique resource IDs in sorted order. Release in finally block in reverse order.
 *   2. All-or-nothing across several resources in one request.
 *   3. Resource IDs are normalised to strings and de-duplicated (e.g. 1 and "1" are identical).
 *   4. Statuses: RESERVED, BUSY { resource, busyUntil }, COMMITTED, FAILED { reason },
 *      RETRY { reason }, REJECTED { reason }, RELEASED, NOT_FOUND.
 *   5. commit is idempotent. commit or release while another operation is in progress returns REJECTED.
 *      A failed save rolls reservation back and returns FAILED.
 *   6. Releasing a RESERVED booking drops it. Releasing a COMMITTED booking calls remove(eventId) hook.
 *      If removal fails, return FAILED and keep allocation.
 *   7. Uncommitted reservations expire after hold time.
 *   8. isFree() is read-only: never locks and never reserves.
 *   9. Time values: plain numeric comparison inside the engine.
 */

class Mutex {
  constructor({ lockTimeoutMs = 5000 } = {}) {
    this.locked = false;
    this.queue = [];
    this.lockTimeoutMs = lockTimeoutMs;
  }

  acquire(timeoutMs = this.lockTimeoutMs) {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = { resolve, reject, timedOut: false };

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          entry.timedOut = true;
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(new Error('Lock acquisition timeout'));
        }, timeoutMs);
      }

      entry.timer = timer;
      this.queue.push(entry);
    });
  }

  release() {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next.timer) clearTimeout(next.timer);
      if (!next.timedOut) {
        next.resolve();
        return;
      }
    }
    this.locked = false;
  }
}

class ResourceEngine {
  constructor(options = {}) {
    this.resources = new Map();
    this.inFlight = new Set();
    this.holdTimers = new Map();
    this.holdTimeoutMs = options.holdTimeoutMs || 30000;
    this.lockTimeoutMs = options.lockTimeoutMs || 5000;
    this.e3 = options.e3 || null;
  }

  addResource(id, metadata = {}) {
    const normId = String(id).trim();
    if (this.resources.has(normId)) {
      const existing = this.resources.get(normId);
      if (metadata.name) existing.name = metadata.name;
      if (metadata.type) existing.type = metadata.type;
      if (metadata.capacity !== undefined) existing.capacity = metadata.capacity;
      return existing;
    }
    const res = {
      id: normId,
      name: metadata.name || normId,
      type: metadata.type || 'resource',
      capacity: metadata.capacity !== undefined ? metadata.capacity : null,
      mutex: new Mutex({ lockTimeoutMs: this.lockTimeoutMs }),
      bookings: []
    };
    this.resources.set(normId, res);
    return res;
  }

  hasResource(id) {
    if (id === undefined || id === null) return false;
    return this.resources.has(String(id).trim());
  }

  getResource(id) {
    if (id === undefined || id === null) return null;
    return this.resources.get(String(id).trim()) || null;
  }

  listResources() {
    return Array.from(this.resources.values()).map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      capacity: r.capacity
    }));
  }

  _normalizeIds(resourceIds) {
    if (!Array.isArray(resourceIds)) return [];
    return [...new Set(resourceIds.map(id => String(id).trim()))].sort();
  }

  async _acquireLocks(orderedIds) {
    const held = [];
    try {
      for (const id of orderedIds) {
        const res = this.resources.get(id);
        if (!res) throw new Error(`Resource ${id} not found`);
        await res.mutex.acquire(this.lockTimeoutMs);
        held.push(id);
      }
      return held;
    } catch (err) {
      this._releaseLocks(held);
      throw err;
    }
  }

  _releaseLocks(heldIds) {
    if (!Array.isArray(heldIds)) return;
    for (let i = heldIds.length - 1; i >= 0; i--) {
      const res = this.resources.get(heldIds[i]);
      if (res && res.mutex) {
        res.mutex.release();
      }
    }
  }

  overlaps(bookings, start, end, excludeEventId = null) {
    const now = Date.now();
    for (const b of bookings) {
      if (excludeEventId && b.eventId === excludeEventId) continue;
      if (b.state === 'RESERVED' && b.expiresAt && b.expiresAt <= now) continue;
      if (b.start < end && start < b.end) {
        return b;
      }
    }
    return null;
  }

  _dropBookings(eventId) {
    const normEventId = String(eventId).trim();
    for (const res of this.resources.values()) {
      res.bookings = res.bookings.filter(b => b.eventId !== normEventId);
    }
  }

  _expireHold(eventId) {
    const normEventId = String(eventId).trim();
    for (const res of this.resources.values()) {
      res.bookings = res.bookings.filter(b => !(b.eventId === normEventId && b.state === 'RESERVED'));
    }
    if (this.holdTimers.has(normEventId)) {
      clearTimeout(this.holdTimers.get(normEventId));
      this.holdTimers.delete(normEventId);
    }
  }

  _cleanExpired() {
    const now = Date.now();
    for (const res of this.resources.values()) {
      res.bookings = res.bookings.filter(b => {
        if (b.state === 'RESERVED' && b.expiresAt && b.expiresAt <= now) {
          return false;
        }
        return true;
      });
    }
  }

  async reserve(eventId, resourceIds, start, end, options = {}) {
    if (eventId === undefined || eventId === null || String(eventId).trim() === '') {
      return { status: 'REJECTED', reason: 'Missing or empty eventId' };
    }
    if (!Array.isArray(resourceIds) || resourceIds.length === 0) {
      return { status: 'REJECTED', reason: 'resourceIds must be a non-empty array' };
    }
    if (typeof start !== 'number' || typeof end !== 'number' || isNaN(start) || isNaN(end) || start >= end) {
      return { status: 'REJECTED', reason: 'start and end must be numbers with start < end' };
    }

    const normEventId = String(eventId).trim();
    const orderedIds = this._normalizeIds(resourceIds);

    for (const id of orderedIds) {
      if (!this.resources.has(id)) {
        if (options.autoAdd) {
          this.addResource(id);
        } else {
          return { status: 'NOT_FOUND', resource: id, reason: `Resource ${id} not found in pool` };
        }
      }
    }

    if (this.inFlight.has(normEventId)) {
      return { status: 'REJECTED', reason: `Operation already in progress for event ${normEventId}` };
    }
    this.inFlight.add(normEventId);

    let held = [];
    try {
      try {
        held = await this._acquireLocks(orderedIds);
      } catch (err) {
        return { status: 'RETRY', reason: err.message || 'Lock acquisition timeout' };
      }

      this._cleanExpired();

      for (const id of orderedIds) {
        const res = this.resources.get(id);
        const clash = this.overlaps(res.bookings, start, end, normEventId);
        if (clash) {
          return {
            status: 'BUSY',
            resource: id,
            busyUntil: clash.end
          };
        }
      }

      const holdMs = options.holdTimeoutMs || this.holdTimeoutMs;
      const now = Date.now();
      const booking = {
        eventId: normEventId,
        start,
        end,
        state: 'RESERVED',
        createdAt: now,
        expiresAt: now + holdMs
      };

      for (const id of orderedIds) {
        const res = this.resources.get(id);
        res.bookings = res.bookings.filter(b => b.eventId !== normEventId);
        res.bookings.push({ ...booking });
      }

      if (this.holdTimers.has(normEventId)) {
        clearTimeout(this.holdTimers.get(normEventId));
      }
      const timer = setTimeout(() => {
        this._expireHold(normEventId);
      }, holdMs);
      if (timer.unref) timer.unref();
      this.holdTimers.set(normEventId, timer);

      return {
        status: 'RESERVED',
        eventId: normEventId,
        resourceIds: orderedIds,
        start,
        end
      };
    } finally {
      this._releaseLocks(held);
      this.inFlight.delete(normEventId);
    }
  }

  async commit(eventId) {
    if (eventId === undefined || eventId === null || String(eventId).trim() === '') {
      return { status: 'REJECTED', reason: 'Missing or empty eventId' };
    }
    const normEventId = String(eventId).trim();

    if (this.inFlight.has(normEventId)) {
      return { status: 'REJECTED', reason: `Operation already in progress for event ${normEventId}` };
    }
    this.inFlight.add(normEventId);

    let held = [];
    try {
      const foundResources = [];
      let sampleBooking = null;
      let isAlreadyCommitted = true;
      let hasAnyBooking = false;
      const now = Date.now();

      for (const [id, res] of this.resources.entries()) {
        const b = res.bookings.find(bk => bk.eventId === normEventId);
        if (b) {
          hasAnyBooking = true;
          if (!sampleBooking) sampleBooking = b;
          if (b.state === 'RESERVED') {
            if (b.expiresAt && b.expiresAt <= now) {
              this._expireHold(normEventId);
              return { status: 'NOT_FOUND', reason: `Reservation for event ${normEventId} has expired` };
            }
            isAlreadyCommitted = false;
          }
          foundResources.push(id);
        }
      }

      if (!hasAnyBooking) {
        return { status: 'NOT_FOUND', reason: `No reservation found for event ${normEventId}` };
      }

      if (isAlreadyCommitted) {
        return { status: 'COMMITTED', eventId: normEventId };
      }

      const orderedIds = this._normalizeIds(foundResources);
      try {
        held = await this._acquireLocks(orderedIds);
      } catch (err) {
        return { status: 'RETRY', reason: err.message || 'Lock acquisition timeout' };
      }

      if (this.e3 && typeof this.e3.save === 'function') {
        try {
          await this.e3.save({
            eventId: normEventId,
            resourceIds: orderedIds,
            start: sampleBooking.start,
            end: sampleBooking.end
          });
        } catch (saveErr) {
          this._dropBookings(normEventId);
          if (this.holdTimers.has(normEventId)) {
            clearTimeout(this.holdTimers.get(normEventId));
            this.holdTimers.delete(normEventId);
          }
          return { status: 'FAILED', reason: saveErr.message || 'Persistence save failed' };
        }
      }

      for (const id of orderedIds) {
        const res = this.resources.get(id);
        for (const b of res.bookings) {
          if (b.eventId === normEventId) {
            b.state = 'COMMITTED';
            delete b.expiresAt;
          }
        }
      }

      if (this.holdTimers.has(normEventId)) {
        clearTimeout(this.holdTimers.get(normEventId));
        this.holdTimers.delete(normEventId);
      }

      return { status: 'COMMITTED', eventId: normEventId };
    } finally {
      this._releaseLocks(held);
      this.inFlight.delete(normEventId);
    }
  }

  async release(eventId) {
    if (eventId === undefined || eventId === null || String(eventId).trim() === '') {
      return { status: 'REJECTED', reason: 'Missing or empty eventId' };
    }
    const normEventId = String(eventId).trim();

    if (this.inFlight.has(normEventId)) {
      return { status: 'REJECTED', reason: `Operation already in progress for event ${normEventId}` };
    }
    this.inFlight.add(normEventId);

    let held = [];
    try {
      const foundResources = [];
      let isCommitted = false;
      let hasAnyBooking = false;

      for (const [id, res] of this.resources.entries()) {
        const b = res.bookings.find(bk => bk.eventId === normEventId);
        if (b) {
          hasAnyBooking = true;
          if (b.state === 'COMMITTED') isCommitted = true;
          foundResources.push(id);
        }
      }

      if (!hasAnyBooking) {
        return { status: 'NOT_FOUND', reason: `No allocation found for event ${normEventId}` };
      }

      const orderedIds = this._normalizeIds(foundResources);
      try {
        held = await this._acquireLocks(orderedIds);
      } catch (err) {
        return { status: 'RETRY', reason: err.message || 'Lock acquisition timeout' };
      }

      if (isCommitted && this.e3 && typeof this.e3.remove === 'function') {
        try {
          await this.e3.remove(normEventId);
        } catch (remErr) {
          return { status: 'FAILED', reason: remErr.message || 'Persistence remove failed' };
        }
      }

      this._dropBookings(normEventId);
      if (this.holdTimers.has(normEventId)) {
        clearTimeout(this.holdTimers.get(normEventId));
        this.holdTimers.delete(normEventId);
      }

      return { status: 'RELEASED', eventId: normEventId };
    } finally {
      this._releaseLocks(held);
      this.inFlight.delete(normEventId);
    }
  }

  isFree(resourceId, start, end) {
    if (resourceId === undefined || resourceId === null) {
      return { free: false, reason: 'Missing resourceId' };
    }
    const normId = String(resourceId).trim();
    const res = this.resources.get(normId);
    if (!res) {
      return { free: false, notFound: true, reason: `Resource ${normId} not found` };
    }
    if (typeof start !== 'number' || typeof end !== 'number' || isNaN(start) || isNaN(end) || start >= end) {
      return { free: false, reason: 'Invalid start/end time: start must be < end' };
    }

    const clash = this.overlaps(res.bookings, start, end);
    if (clash) {
      return { free: false, reason: 'BUSY', busyUntil: clash.end };
    }
    return { free: true };
  }

  loadAllocations(allocations) {
    if (!Array.isArray(allocations)) return 0;
    let count = 0;
    for (const item of allocations) {
      const eventId = String(item.eventId || item.event_id).trim();
      const start = Number(item.start ?? item.start_time ?? item.startTime);
      const end = Number(item.end ?? item.end_time ?? item.endTime);
      const rIds = item.resourceIds || item.resource_ids ||
        (item.resourceId ? [item.resourceId] : (item.resource_id ? [item.resource_id] : []));
      for (const rid of rIds) {
        const normId = String(rid).trim();
        if (!this.resources.has(normId)) {
          this.addResource(normId);
        }
        const res = this.resources.get(normId);
        res.bookings = res.bookings.filter(b => b.eventId !== eventId);
        res.bookings.push({
          eventId,
          start,
          end,
          state: 'COMMITTED',
          createdAt: Date.now()
        });
        count++;
      }
    }
    return count;
  }

  getBookings(resourceId) {
    const normId = String(resourceId).trim();
    const res = this.resources.get(normId);
    if (!res) return [];
    this._cleanExpired();
    return [...res.bookings];
  }
}

module.exports = { Mutex, ResourceEngine };
