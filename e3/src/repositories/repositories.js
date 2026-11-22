'use strict';
/**
 * repositories/repositories.js - Data Access Layer (all SQL lives here).
 *
 * Rules:
 *  - Every query is parameterized ($1, $2, ...). No string-built SQL with user data.
 *  - Every function takes an optional last argument `client`. Pass the client given
 *    by withTransaction() to run the call inside that transaction; omit it to run
 *    on the shared pool as a single auto-committed statement.
 *  - PostgreSQL errors are mapped to ConflictError / ValidationError / NotFoundError.
 */

const { query, NotFoundError, ConflictError, ValidationError } = require('../services/transactionService');

/* ------------------------------------------------------------------ users */

async function createUser({ name, email, passwordHash, role }, client) {
  const { rows } = await query(
    `INSERT INTO app_user (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING user_id, name, email, role`,
    [name, email, passwordHash, role],
    client
  );
  return rows[0];
}

async function getUserById(userId, client) {
  const { rows } = await query(
    'SELECT user_id, name, email, role FROM app_user WHERE user_id = $1',
    [userId],
    client
  );
  if (!rows[0]) throw new NotFoundError(`User ${userId} not found`);
  return rows[0];
}

/* ----------------------------------------------------------------- events */

async function createEvent(
  { name, theme = null, description = null, durationMin, judgesRequired = 0, status = 'Pending', remarks = null, coordinatorId },
  client
) {
  const { rows } = await query(
    `INSERT INTO event (name, theme, description, duration_min, judges_required, status, remarks, coordinator_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [name, theme, description, durationMin, judgesRequired, status, remarks, coordinatorId],
    client
  );
  return rows[0];
}

async function getEventById(eventId, client) {
  const { rows } = await query('SELECT * FROM event WHERE event_id = $1', [eventId], client);
  if (!rows[0]) throw new NotFoundError(`Event ${eventId} not found`);
  return rows[0];
}

async function listEvents({ status = null } = {}, client) {
  const { rows } = await query(
    'SELECT * FROM event WHERE ($1::text IS NULL OR status = $1) ORDER BY event_id',
    [status],
    client
  );
  return rows;
}

/** Change an event's status (proposal approval flow). approvedBy also stamps approved_at. */
async function setEventStatus(eventId, status, { approvedBy = null, remarks = null } = {}, client) {
  const { rows } = await query(
    `UPDATE event
        SET status      = $2,
            remarks     = COALESCE($3, remarks),
            approved_by = COALESCE($4::int, approved_by),
            approved_at = CASE WHEN $4::int IS NOT NULL THEN now() ELSE approved_at END
      WHERE event_id = $1
      RETURNING *`,
    [eventId, status, remarks, approvedBy],
    client
  );
  if (!rows[0]) throw new NotFoundError(`Event ${eventId} not found`);
  return rows[0];
}

async function deleteEvent(eventId, client) {
  const { rows } = await query('DELETE FROM event WHERE event_id = $1 RETURNING event_id', [eventId], client);
  if (!rows[0]) throw new NotFoundError(`Event ${eventId} not found`);
  return rows[0];
}

async function assignJudge(eventId, judgeId, client) {
  const { rows } = await query(
    'INSERT INTO event_judge (event_id, judge_id) VALUES ($1, $2) RETURNING event_id, judge_id',
    [eventId, judgeId],
    client
  );
  return rows[0];
}

async function addEventRequirement(
  { eventId, resourceId = null, requiredVenueType = null, minCapacity = null, equipmentNeeded = null, quantity = 1 },
  client
) {
  const { rows } = await query(
    `INSERT INTO event_requirement (event_id, resource_id, required_venue_type, min_capacity, equipment_needed, quantity)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [eventId, resourceId, requiredVenueType, minCapacity, equipmentNeeded, quantity],
    client
  );
  return rows[0];
}

/** Events with status 'Approved' (ready for the scheduler) incl. judges, requirements, registration count. */
async function getApprovedEvents(client) {
  const { rows } = await query(
    `SELECT e.event_id, e.name, e.theme, e.duration_min, e.judges_required, e.status,
            e.coordinator_id, c.name AS coordinator_name, c.email AS coordinator_email,
            COALESCE((SELECT json_agg(json_build_object('judge_id', u.user_id, 'name', u.name, 'email', u.email)
                                      ORDER BY u.user_id)
                        FROM event_judge ej JOIN app_user u ON u.user_id = ej.judge_id
                       WHERE ej.event_id = e.event_id), '[]'::json) AS assigned_judges,
            COALESCE((SELECT json_agg(json_build_object('req_id', r.req_id,
                                                        'resource_id', r.resource_id,
                                                        'required_venue_type', r.required_venue_type,
                                                        'min_capacity', r.min_capacity,
                                                        'equipment_needed', r.equipment_needed,
                                                        'quantity', r.quantity)
                                      ORDER BY r.req_id)
                        FROM event_requirement r
                       WHERE r.event_id = e.event_id), '[]'::json) AS requirements,
            (SELECT COUNT(*) FROM registration g
              WHERE g.event_id = e.event_id AND g.status <> 'Cancelled')::int AS registered_count
       FROM event e
       JOIN app_user c ON c.user_id = e.coordinator_id
      WHERE e.status = 'Approved'
      ORDER BY e.event_id`,
    [],
    client
  );
  return rows;
}

/* -------------------------------------------------------------- resources */

async function getVenues(client) {
  const { rows } = await query(
    `SELECT resource_id, name, capacity, type FROM resource WHERE type = 'Venue' ORDER BY resource_id`,
    [],
    client
  );
  return rows;
}

/* ---------------------------------------------- registrations and scores */

/**
 * Enrol a student. A previously Cancelled registration is re-activated.
 * An already active (Registered / Attended) registration is a ConflictError.
 */
async function registerStudent(studentId, eventId, client) {
  const { rows } = await query(
    `INSERT INTO registration (student_id, event_id) VALUES ($1, $2)
     ON CONFLICT (event_id, student_id)
     DO UPDATE SET status = 'Registered', registered_at = now()
        WHERE registration.status = 'Cancelled'
     RETURNING *`,
    [studentId, eventId],
    client
  );
  if (!rows[0]) {
    throw new ConflictError(`Student ${studentId} is already registered for event ${eventId}`, {
      kind: 'duplicate',
    });
  }
  return rows[0];
}

/** Record a judge's score. The DB enforces: judge assigned to event, participant registered, 0-100, no self-scoring, no duplicates. */
async function submitScore(eventId, judgeId, participantId, points, client) {
  try {
    const { rows } = await query(
      `INSERT INTO score (event_id, judge_id, participant_id, points)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [eventId, judgeId, participantId, points],
      client
    );
    return rows[0];
  } catch (err) {
    if (err.kind === 'foreign_key' && err.constraint) {
      if (err.constraint.includes('judge_id')) {
        throw new ValidationError(`Judge ${judgeId} is not assigned to event ${eventId}`, {
          code: err.code, constraint: err.constraint, kind: 'foreign_key', cause: err,
        });
      }
      if (err.constraint.includes('participant_id')) {
        throw new ValidationError(`Participant ${participantId} is not registered for event ${eventId}`, {
          code: err.code, constraint: err.constraint, kind: 'foreign_key', cause: err,
        });
      }
    }
    throw err;
  }
}

async function logAction(userId, action, endpoint, result, client) {
  const { rows } = await query(
    `INSERT INTO audit_log (user_id, action, endpoint, result)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, action, endpoint, result],
    client
  );
  return rows[0];
}

/* --------------------------------------------------------------- versions */

async function createVersion(versionNo, status = 'Draft', client) {
  const { rows } = await query(
    'INSERT INTO timetable_version (version_no, status) VALUES ($1, $2) RETURNING *',
    [versionNo, status],
    client
  );
  return rows[0];
}

/** Fetch a version. forUpdate=true takes a row lock (use inside a transaction). */
async function getVersionById(versionId, { forUpdate = false } = {}, client) {
  const { rows } = await query(
    `SELECT * FROM timetable_version WHERE version_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [versionId],
    client
  );
  return rows[0] || null;
}

async function listVersions(client) {
  const { rows } = await query('SELECT * FROM timetable_version ORDER BY version_no', [], client);
  return rows;
}

/* ------------------------------------------------------------------ slots */

/** Insert ONE schedule slot. Overlap in the same venue+version is rejected by the DB (ConflictError kind=double_booking). */
async function addSlot({ eventId, versionId, venueId, startTime, endTime }, client) {
  const { rows } = await query(
    `INSERT INTO schedule_slot (event_id, version_id, venue_id, start_time, end_time)
     VALUES ($1, $2, $3, $4::timestamp, $5::timestamp) RETURNING *`,
    [eventId, versionId, venueId, startTime, endTime],
    client
  );
  return rows[0];
}

async function deleteSlotsForVersion(versionId, client) {
  const { rowCount } = await query('DELETE FROM schedule_slot WHERE version_id = $1', [versionId], client);
  return rowCount;
}

/** Schedule with full venue, event and coordinator details. */
async function getSchedule(versionId, client) {
  const { rows } = await query(
    `SELECT s.slot_id, s.version_id, s.event_id, e.name AS event_name, e.theme, e.duration_min,
            s.venue_id, r.name AS venue_name, r.capacity AS venue_capacity,
            s.start_time, s.end_time,
            e.coordinator_id, c.name AS coordinator_name, c.email AS coordinator_email
       FROM schedule_slot s
       JOIN event    e ON e.event_id    = s.event_id
       JOIN resource r ON r.resource_id = s.venue_id
       JOIN app_user c ON c.user_id     = e.coordinator_id
      WHERE s.version_id = $1
      ORDER BY s.start_time, s.slot_id`,
    [versionId],
    client
  );
  return rows;
}

async function countSlots(versionId, client) {
  const { rows } = await query('SELECT COUNT(*) AS n FROM schedule_slot WHERE version_id = $1', [versionId], client);
  return rows[0].n;
}

/* -------------------------------------------------------------- conflicts */

/**
 * Remove Open, system-detected conflicts of a version that are no longer present in the clash views
 * (the schedule was fixed). Resolved / Ignored rows and manually raised rows (raised_by set) are kept.
 * Rows that still exist keep their conflict_id, so ids shown to a user stay valid.
 */
async function deleteStaleDetectedConflicts(versionId, judgeType, participantType, client) {
  const { rowCount } = await query(
    `DELETE FROM conflict c
      WHERE c.version_id = $1 AND c.status = 'Open' AND c.raised_by IS NULL
        AND NOT (
              (c.type = $2 AND EXISTS (SELECT 1 FROM v_judge_conflicts j
                                        WHERE j.version_id = c.version_id
                                          AND j.event_a = c.event_a AND j.event_b = c.event_b))
           OR (c.type = $3 AND EXISTS (SELECT 1 FROM v_participant_conflicts p
                                        WHERE p.version_id = c.version_id
                                          AND p.event_a = c.event_a AND p.event_b = c.event_b))
        )`,
    [versionId, judgeType, participantType],
    client
  );
  return rowCount;
}

/** Judge assigned to two overlapping slots (view v_judge_conflicts) -> conflict rows of the given type/severity. */
async function insertJudgeConflicts(versionId, type, severity, client) {
  const { rowCount } = await query(
    `INSERT INTO conflict (version_id, event_a, event_b, resource_id, type, severity, status)
     SELECT DISTINCT version_id, event_a, event_b, NULL::int, $2, $3, 'Open'
       FROM v_judge_conflicts WHERE version_id = $1
     ON CONFLICT DO NOTHING`,
    [versionId, type, severity],
    client
  );
  return rowCount;
}

/** Student registered for two overlapping slots (view v_participant_conflicts). */
async function insertParticipantConflicts(versionId, type, severity, client) {
  const { rowCount } = await query(
    `INSERT INTO conflict (version_id, event_a, event_b, resource_id, type, severity, status)
     SELECT DISTINCT version_id, event_a, event_b, NULL::int, $2, $3, 'Open'
       FROM v_participant_conflicts WHERE version_id = $1
     ON CONFLICT DO NOTHING`,
    [versionId, type, severity],
    client
  );
  return rowCount;
}

async function listConflicts(versionId, { status = null, severity = null } = {}, client) {
  const { rows } = await query(
    `SELECT * FROM conflict
      WHERE version_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR severity = $3)
      ORDER BY conflict_id`,
    [versionId, status, severity],
    client
  );
  return rows;
}

/* ------------------------------------------------------- version status */

async function archivePublishedVersionsExcept(versionId, client) {
  const { rowCount } = await query(
    `UPDATE timetable_version SET status = 'Archived'
      WHERE status = 'Published' AND version_id <> $1`,
    [versionId],
    client
  );
  return rowCount;
}

async function markVersionPublished(versionId, publishedBy, client) {
  const { rows } = await query(
    `UPDATE timetable_version
        SET status = 'Published', published_by = $2, published_at = now()
      WHERE version_id = $1
      RETURNING *`,
    [versionId, publishedBy],
    client
  );
  return rows[0];
}

module.exports = {
  // users
  createUser, getUserById,
  // events
  createEvent, getEventById, listEvents, setEventStatus, deleteEvent,
  assignJudge, addEventRequirement, getApprovedEvents,
  // resources
  getVenues,
  // registrations / scores / audit
  registerStudent, submitScore, logAction,
  // versions
  createVersion, getVersionById, listVersions,
  archivePublishedVersionsExcept, markVersionPublished,
  // slots
  addSlot, deleteSlotsForVersion, getSchedule, countSlots,
  // conflicts
  deleteStaleDetectedConflicts, insertJudgeConflicts, insertParticipantConflicts, listConflicts,
};
