'use strict';
/**
 * services/timetableService.js - multi-step timetable operations.
 *
 * Engine 3 only PERSISTS schedules produced by the scheduler (Engine 1/2). It does not
 * generate them. This service makes the multi-step writes atomic:
 *
 *   createDraftVersion  - new Draft version
 *   saveSchedule        - atomically REPLACE all slots of a Draft version
 *   detectConflicts     - refresh the `conflict` table from the clash views
 *   publishVersion      - validate, archive the old Published version, publish this one
 *   getSchedule         - read a version's schedule with details
 */

const repo = require('../repositories/repositories');
const { withTransaction, ConflictError, ValidationError, NotFoundError } = require('./transactionService');

/**
 * How detected clashes are classified in the `conflict` table.
 * Change here if the team decides differently.
 *   - A judge assigned to two overlapping slots cannot be in two places -> Critical (blocks publishing)
 *   - A student registered for two overlapping events can choose one   -> Acceptable (does not block)
 */
const CONFLICT_RULES = {
  judge: { type: 'Resource', severity: 'Critical' },
  participant: { type: 'Participant', severity: 'Acceptable' },
};

/** Constant key for the advisory lock that serialises publishing. */
const PUBLISH_LOCK_KEY = 3_000_001;

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

function requireInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive integer`, { kind: 'invalid_value' });
  }
  return value;
}

/** Validate the JSON the scheduler sends (see README interface contract). */
function validateSlots(slots) {
  if (!Array.isArray(slots)) {
    throw new ValidationError('slots must be an array', { kind: 'invalid_value' });
  }
  slots.forEach((s, i) => {
    const where = `slots[${i}]`;
    if (!s || typeof s !== 'object') throw new ValidationError(`${where} must be an object`, { kind: 'invalid_value' });
    requireInt(s.event_id, `${where}.event_id`);
    requireInt(s.venue_id, `${where}.venue_id`);
    for (const f of ['start_time', 'end_time']) {
      // Timestamps are TIMESTAMP WITHOUT TIME ZONE. A "Z" or "+05:30" suffix would be silently
      // ignored by PostgreSQL, so offsets are rejected instead of being misread.
      if (typeof s[f] !== 'string' || !TIMESTAMP_RE.test(s[f])) {
        throw new ValidationError(
          `${where}.${f} must be a string like "2026-12-05 09:00:00" (no time-zone suffix)`,
          { kind: 'invalid_value' }
        );
      }
    }
  });
}

async function createDraftVersion(versionNo) {
  requireInt(versionNo, 'version_no');
  return repo.createVersion(versionNo, 'Draft');
}

/**
 * Atomically replace the slots of a Draft version.
 * If ANY slot is rejected (overlap, wrong venue type, wrong duration, ...) the whole
 * call is rolled back and the previous slots remain untouched.
 */
async function saveSchedule(versionId, slots) {
  requireInt(versionId, 'version_id');
  validateSlots(slots);

  return withTransaction(async (client) => {
    const version = await repo.getVersionById(versionId, { forUpdate: true }, client);
    if (!version) throw new NotFoundError(`Timetable version ${versionId} not found`);
    if (version.status !== 'Draft') {
      throw new ConflictError(
        `Version ${versionId} is ${version.status}; only Draft versions can be modified. Create a new version instead.`,
        { kind: 'not_draft' }
      );
    }

    await repo.deleteSlotsForVersion(versionId, client);

    const saved = [];
    for (let i = 0; i < slots.length; i += 1) {
      const s = slots[i];
      try {
        saved.push(
          await repo.addSlot(
            { eventId: s.event_id, versionId, venueId: s.venue_id, startTime: s.start_time, endTime: s.end_time },
            client
          )
        );
      } catch (err) {
        // Add context: which slot of the payload failed.
        err.message = `slots[${i}] (event_id=${s.event_id}, venue_id=${s.venue_id}): ${err.message}`;
        err.extra = { slot_index: i, event_id: s.event_id, venue_id: s.venue_id };
        throw err;
      }
    }
    return saved;
  });
}

/**
 * Run conflict detection inside an existing transaction.
 * New clashes are inserted, clashes that no longer exist are removed, and clashes that are still
 * present keep their conflict_id and status (so Resolved / Ignored decisions are never re-opened).
 */
async function detectConflictsIn(client, versionId) {
  const { judge, participant } = CONFLICT_RULES;
  await repo.insertJudgeConflicts(versionId, judge.type, judge.severity, client);
  await repo.insertParticipantConflicts(versionId, participant.type, participant.severity, client);
  await repo.deleteStaleDetectedConflicts(versionId, judge.type, participant.type, client);
  return repo.listConflicts(versionId, {}, client);
}

/** Scan the clash views and store the result in `conflict`. Safe to call repeatedly. */
async function detectConflicts(versionId) {
  requireInt(versionId, 'version_id');
  return withTransaction(async (client) => {
    const version = await repo.getVersionById(versionId, { forUpdate: true }, client);
    if (!version) throw new NotFoundError(`Timetable version ${versionId} not found`);
    const conflicts = await detectConflictsIn(client, versionId);
    return {
      version_id: versionId,
      total: conflicts.length,
      open_critical: conflicts.filter((c) => c.status === 'Open' && c.severity === 'Critical').length,
      conflicts,
    };
  });
}

/**
 * Publish a version.
 *
 * Step A (own transaction, COMMITTED): detect conflicts and store them. This is done first so that
 *   when publishing is blocked, the conflict rows named in the error really exist and can be
 *   reviewed, resolved or ignored.
 * Step B (ONE transaction):
 *   1. serialise with other publishers (advisory lock) and lock the version row
 *   2. refuse if it has no slots
 *   3. re-run detection (the schedule could have changed since step A); refuse if any Critical
 *      conflict is still Open
 *   4. archive the currently Published version
 *   5. mark this version Published
 * Any failure in step B rolls back everything in B, so the old Published version is never lost.
 */
async function publishVersion(versionId, publishedBy = null) {
  requireInt(versionId, 'version_id');
  if (publishedBy !== null && publishedBy !== undefined) requireInt(publishedBy, 'published_by');

  await detectConflicts(versionId); // step A (throws NotFoundError for an unknown version)

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [PUBLISH_LOCK_KEY]);

    const version = await repo.getVersionById(versionId, { forUpdate: true }, client);
    if (!version) throw new NotFoundError(`Timetable version ${versionId} not found`);
    if (version.status === 'Published') {
      throw new ConflictError(`Version ${versionId} is already published`, { kind: 'already_published' });
    }

    if ((await repo.countSlots(versionId, client)) === 0) {
      throw new ValidationError(`Version ${versionId} has no schedule slots and cannot be published`, {
        kind: 'empty_timetable',
      });
    }

    const conflicts = await detectConflictsIn(client, versionId);
    const blocking = conflicts.filter((c) => c.status === 'Open' && c.severity === 'Critical');
    if (blocking.length > 0) {
      throw new ConflictError(
        `Publishing blocked: ${blocking.length} unresolved Critical conflict(s) in version ${versionId}`,
        {
          kind: 'critical_conflicts',
          extra: { conflict_ids: blocking.map((c) => c.conflict_id), conflicts: blocking },
        }
      );
    }

    await repo.archivePublishedVersionsExcept(versionId, client);
    return repo.markVersionPublished(versionId, publishedBy, client);
  });
}

async function getSchedule(versionId) {
  requireInt(versionId, 'version_id');
  const version = await repo.getVersionById(versionId);
  if (!version) throw new NotFoundError(`Timetable version ${versionId} not found`);
  const slots = await repo.getSchedule(versionId);
  return { version, slots };
}

module.exports = {
  createDraftVersion,
  saveSchedule,
  detectConflicts,
  publishVersion,
  getSchedule,
  CONFLICT_RULES,
  validateSlots,
};
