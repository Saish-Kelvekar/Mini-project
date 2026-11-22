'use strict';

/**
 * e3_adapter.js - Adapter for Engine 3 (E2 -> E3 Database & Persistence)
 * Author: Saish Kelvekar (Team 4)
 *
 * Implements the persistence bridge on top of Engine 3:
 *   - save(record): Inserts allocation rows for committed events.
 *   - remove(eventId): Deletes allocation rows when an event is released.
 *   - loadAllocations(): Queries existing allocations on startup to rebuild in-memory state.
 *   - loadResources(): Queries the resource table for venues and equipment.
 *
 * Provides hybrid operation:
 *   If PostgreSQL pool/client is reachable, executes parameterized SQL against E3 tables
 *   (allocation and resource). Otherwise, delegates to the in-memory E3 stub.
 */

const path = require('path');
const { E3PersistenceStub } = require('../e3_stub');

function formatTimestamp(numericVal) {
  if (typeof numericVal === 'string') return numericVal;
  const d = new Date(numericVal);
  if (isNaN(d.getTime())) return new Date().toISOString().replace('T', ' ').slice(0, 19);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

class E3Adapter {
  constructor(options = {}) {
    this.pool = options.pool || null;
    this.fallbackStub = options.stub || new E3PersistenceStub();
    this.useFallback = options.useFallback ?? false;

    // Attempt to lazily acquire E3 pool if not provided and not explicitly using fallback
    if (!this.pool && !this.useFallback) {
      try {
        const dbPath = path.join(__dirname, '..', '..', 'e3', 'src', 'config', 'db.js');
        const db = require(dbPath);
        if (typeof db.getPool === 'function') {
          this.pool = db.getPool();
        }
      } catch {
        this.useFallback = true;
      }
    }
  }

  async save(record) {
    if (this.useFallback || !this.pool) {
      return this.fallbackStub.save(record);
    }

    const eventId = Number(record.eventId);
    const versionId = record.versionId || 1;
    const startTime = formatTimestamp(record.start);
    const endTime = formatTimestamp(record.end);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const resId of record.resourceIds) {
        // If resourceId has prefix like 'res:1', strip it for numeric FK if applicable
        const cleanId = Number(String(resId).replace(/^[a-z]+:/i, '')) || 1;
        await client.query(
          `INSERT INTO allocation (event_id, resource_id, version_id, quantity, start_time, end_time)
           VALUES ($1, $2, $3, 1, $4::timestamp, $5::timestamp)`,
          [eventId, cleanId, versionId, startTime, endTime]
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async remove(eventId) {
    if (this.useFallback || !this.pool) {
      return this.fallbackStub.remove(eventId);
    }

    const cleanEventId = Number(eventId);
    const { rowCount } = await this.pool.query(
      'DELETE FROM allocation WHERE event_id = $1',
      [cleanEventId]
    );
    return rowCount > 0;
  }

  async loadAllocations() {
    if (this.useFallback || !this.pool) {
      return this.fallbackStub.loadAllocations();
    }

    try {
      const { rows } = await this.pool.query(
        'SELECT alloc_id, event_id, resource_id, version_id, quantity, start_time, end_time FROM allocation'
      );
      return rows.map(r => ({
        eventId: String(r.event_id),
        resourceIds: [`res:${r.resource_id}`],
        start: Date.parse(r.start_time),
        end: Date.parse(r.end_time),
        allocId: r.alloc_id
      }));
    } catch (err) {
      return this.fallbackStub.loadAllocations();
    }
  }

  async loadResources() {
    if (this.useFallback || !this.pool) {
      return this.fallbackStub.getResourceData();
    }

    try {
      const { rows } = await this.pool.query(
        'SELECT resource_id, type, name, capacity FROM resource ORDER BY resource_id'
      );
      return rows.map(r => ({
        id: `${r.type === 'Venue' ? 'venue:' : 'res:'}${r.resource_id}`,
        name: r.name,
        type: r.type,
        capacity: r.capacity
      }));
    } catch (err) {
      return this.fallbackStub.getResourceData();
    }
  }
}

module.exports = { E3Adapter, formatTimestamp };
