'use strict';
/**
 * tests/helpers.js - shared setup for all Node tests.
 *
 * IMPORTANT: this file forces NODE_ENV=test BEFORE the app config is loaded, so every test
 * runs against DB_NAME_TEST (default event_timetable_test). config/db.js refuses any test
 * database whose name does not end in "_test", so tests can never touch real data.
 * Require this file FIRST in every test file.
 */

process.env.NODE_ENV = 'test';

const { getPool, closePool, createClient, getDatabaseName } = require('../src/config/db');
const { createDatabaseIfMissing, runSqlFile } = require('../scripts/lib');
const repo = require('../src/repositories/repositories');

const ALL_TABLES = [
  'audit_log', 'score', 'registration', 'conflict', 'schedule_slot', 'allocation',
  'event_judge', 'event_requirement', 'judge_availability', 'venue_availability',
  'timetable_version', 'event', 'resource', 'fest_config', 'app_user',
];

/** Create the test database (if missing) and apply schema.sql. Call once in before(). */
async function setupTestDb() {
  const dbname = getDatabaseName(); // throws unless the name ends with _test
  await createDatabaseIfMissing(dbname);
  const client = await createClient(dbname);
  try {
    client.on('notice', () => {}); // silence "trigger does not exist, skipping" notices
    await runSqlFile(client, 'schema.sql');
  } finally {
    await client.end();
  }
}

/** Empty every table and restart the id sequences. Only ever runs on the *_test database. */
async function resetData() {
  const dbname = getDatabaseName();
  if (!/_test$/.test(dbname)) throw new Error('resetData() refused: not a test database');
  await getPool().query(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "2026-12-05 HH:MM:00" */
const T = (h, m = 0, day = 5) =>
  `2026-12-${String(day).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

/**
 * Minimal fixture: 1 admin, 2 coordinators, 2 judges, 3 students, 3 venues, 1 equipment.
 * Returns the generated ids.
 */
async function seed() {
  const pool = getPool();
  const user = async (name, email, role) =>
    (await pool.query(
      'INSERT INTO app_user (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING user_id',
      [name, email, 'hash', role]
    )).rows[0].user_id;
  const resource = async (type, name, capacity) =>
    (await pool.query('INSERT INTO resource (type, name, capacity) VALUES ($1,$2,$3) RETURNING resource_id', [
      type, name, capacity,
    ])).rows[0].resource_id;

  const ids = {
    admin: await user('Admin', 'admin@t.edu', 'Admin'),
    coord: await user('Coord One', 'coord1@t.edu', 'Coordinator'),
    coord2: await user('Coord Two', 'coord2@t.edu', 'Coordinator'),
    judge1: await user('Judge One', 'judge1@t.edu', 'Judge'),
    judge2: await user('Judge Two', 'judge2@t.edu', 'Judge'),
    stud1: await user('Student One', 'stud1@t.edu', 'Student'),
    stud2: await user('Student Two', 'stud2@t.edu', 'Student'),
    stud3: await user('Student Three', 'stud3@t.edu', 'Student'),
    venueA: await resource('Venue', 'Hall A', 100),
    venueB: await resource('Venue', 'Hall B', 50),
    venueC: await resource('Venue', 'Hall C', 2),
    projector: await resource('Equipment', 'Projector', null),
  };
  return ids;
}

/** Create an event owned by the fixture coordinator. */
async function mkEvent(ids, name, durationMin = 60, extra = {}) {
  return repo.createEvent({ name, durationMin, coordinatorId: ids.coord, ...extra });
}

module.exports = {
  getPool, closePool, setupTestDb, resetData, seed, mkEvent, sleep, T, repo,
};
