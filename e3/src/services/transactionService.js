'use strict';
/**
 * services/transactionService.js - transactions + error mapping.
 *
 * withTransaction(fn) checks out ONE client from the pool, runs BEGIN, calls
 * fn(client), then COMMIT. Any error causes ROLLBACK. The client is always
 * released. Every PostgreSQL error is translated into a domain error.
 *
 * (Replaces db/connection.py get_db_connection() and db/exceptions.py.)
 */

const { getPool } = require('../config/db');

class DatabaseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = details.code || null; // PostgreSQL SQLSTATE, e.g. "23P01"
    this.constraint = details.constraint || null;
    this.detail = details.detail || null;
    this.kind = details.kind || null; // machine-friendly reason, e.g. "double_booking"
    this.retryable = Boolean(details.retryable);
    if (details.cause) this.cause = details.cause;
    if (details.extra) this.extra = details.extra; // e.g. blocking conflict ids
  }
}
/** Duplicate / overlapping data, or a business rule that blocks the action (HTTP 409). */
class ConflictError extends DatabaseError {}
/** Bad input: FK, CHECK, NOT NULL, role triggers, malformed values (HTTP 400). */
class ValidationError extends DatabaseError {}
/** Row does not exist (HTTP 404). */
class NotFoundError extends DatabaseError {}

/** Translate a raw pg error into one of the domain errors above. */
function mapPgError(err) {
  if (err instanceof DatabaseError) return err;
  const d = {
    code: err.code,
    constraint: err.constraint,
    detail: err.detail,
    cause: err,
  };
  const msg = err.message;
  switch (err.code) {
    case '23505': // unique_violation
      return new ConflictError(`Duplicate record: ${msg}`, { ...d, kind: 'duplicate' });
    case '23P01': // exclusion_violation  (double-booking)
      return new ConflictError(
        `Double-booking rejected: the venue/resource is already booked for an overlapping time. ${err.detail || ''}`.trim(),
        { ...d, kind: 'double_booking' }
      );
    case '23503': // foreign_key_violation
      return new ValidationError(`Referenced record does not exist (or is still referenced): ${msg}`, {
        ...d,
        kind: 'foreign_key',
      });
    case '23514': // check_violation (CHECK constraints and our trigger functions)
      return new ValidationError(`Rule violated: ${msg}`, { ...d, kind: 'check' });
    case '23502': // not_null_violation
      return new ValidationError(`Missing required value: ${msg}`, { ...d, kind: 'not_null' });
    case '22P02': // invalid_text_representation
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '22003': // numeric_value_out_of_range
      return new ValidationError(`Invalid value: ${msg}`, { ...d, kind: 'invalid_value' });
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new DatabaseError(`Transaction conflict, please retry: ${msg}`, {
        ...d,
        kind: 'retry',
        retryable: true,
      });
    default:
      return new DatabaseError(msg, d);
  }
}

/**
 * Run fn(client) inside one transaction on one pooled connection.
 * Resolves with fn's return value after COMMIT. Rejects (after ROLLBACK) with a domain error.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  let releaseArg;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is in an unknown state: tell the pool to destroy it.
      releaseArg = rollbackErr;
    }
    throw mapPgError(err);
  } finally {
    client.release(releaseArg);
  }
}

/** Run a single query on the pool (or on a given client) with error mapping. */
async function query(text, params = [], client = null) {
  try {
    return await (client || getPool()).query(text, params);
  } catch (err) {
    throw mapPgError(err);
  }
}

module.exports = {
  withTransaction,
  query,
  mapPgError,
  DatabaseError,
  ConflictError,
  ValidationError,
  NotFoundError,
};
