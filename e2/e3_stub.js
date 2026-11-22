'use strict';

/**
 * e3_stub.js - Engine 3 In-Memory Persistence Stub
 * Author: Saish Kelvekar (Team 4)
 *
 * Implements the persistence contract expected by Engine 2 (E2 -> E3):
 *   - save(record): Persists committed allocation record.
 *   - remove(eventId): Deletes allocation record on release.
 *   - loadAllocations(): Supplies existing committed allocations for E2 startup rebuild.
 *   - getResourceData(): Supplies seed resources (venues, judges, equipment).
 * Includes failure-injection flags to test rollback on save error and allocation retention on remove error.
 */

class E3PersistenceStub {
  constructor() {
    this.records = new Map();
    this.shouldFailSave = false;
    this.shouldFailRemove = false;
    this.saveFailureReason = 'Simulated E3 database transaction error on save';
    this.removeFailureReason = 'Simulated E3 database transaction error on remove';
  }

  setFailSave(val, reason) {
    this.shouldFailSave = Boolean(val);
    if (reason) this.saveFailureReason = reason;
  }

  setFailRemove(val, reason) {
    this.shouldFailRemove = Boolean(val);
    if (reason) this.removeFailureReason = reason;
  }

  async save(record) {
    if (this.shouldFailSave) {
      throw new Error(this.saveFailureReason);
    }
    const key = String(record.eventId);
    this.records.set(key, {
      eventId: key,
      resourceIds: [...record.resourceIds],
      start: record.start,
      end: record.end,
      savedAt: Date.now()
    });
    return true;
  }

  async remove(eventId) {
    if (this.shouldFailRemove) {
      throw new Error(this.removeFailureReason);
    }
    const key = String(eventId);
    if (!this.records.has(key)) {
      return false;
    }
    this.records.delete(key);
    return true;
  }

  async loadAllocations() {
    return Array.from(this.records.values());
  }

  async getResourceData() {
    return [
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
  }

  clear() {
    this.records.clear();
    this.shouldFailSave = false;
    this.shouldFailRemove = false;
  }
}

module.exports = { E3PersistenceStub };
