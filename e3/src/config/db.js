'use strict';
/**
 * config/db.js - PostgreSQL connection settings and the shared connection pool.
 *
 * - Credentials come from .env (never hard-coded).
 * - NODE_ENV=test switches to DB_NAME_TEST, and refuses any test database whose
 *   name does not end in "_test" so tests can never touch real data.
 * - TIMESTAMP / DATE values are returned as plain strings, NOT JS Date objects.
 *   The schema uses TIMESTAMP WITHOUT TIME ZONE; node-postgres would otherwise
 *   convert them using the server's local time zone and shift the values.
 */

const path = require('path');
const dotenv = require('dotenv');
const { Pool, Client, types } = require('pg');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

// 1114 = timestamp, 1082 = date, 1083 = time  -> keep as strings
types.setTypeParser(1114, (v) => v);
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1083, (v) => v);
// 20 = int8 (COUNT(*) etc.) -> number instead of string
types.setTypeParser(20, (v) => parseInt(v, 10));

function isTestMode() {
  return process.env.NODE_ENV === 'test';
}

/** Name of the database to use (main or test), validated. */
function getDatabaseName(override) {
  const name =
    override ||
    (isTestMode()
      ? process.env.DB_NAME_TEST || 'event_timetable_test'
      : process.env.DB_NAME || 'event_timetable');
  if (isTestMode() && !/_test$/.test(name)) {
    throw new Error(
      `Refusing to run in test mode against database "${name}". ` +
        'Test database names must end with "_test".'
    );
  }
  return name;
}

/** Connection settings. Pass dbname to override (e.g. "postgres" for CREATE DATABASE). */
function getSettings(dbname) {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: dbname === 'postgres' ? 'postgres' : getDatabaseName(dbname),
  };
}

let pool = null;

/** Lazily-created shared pool. */
function getPool() {
  if (!pool) {
    pool = new Pool({
      ...getSettings(),
      max: parseInt(process.env.DB_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    // An idle client can error (e.g. server restart). Log it instead of crashing the process.
    pool.on('error', (err) => {
      console.error('[db] unexpected error on idle client:', err.message);
    });
  }
  return pool;
}

/** Close the shared pool (call on shutdown and at the end of tests). */
async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** A single stand-alone connection (used by setup scripts and CREATE DATABASE). */
async function createClient(dbname) {
  const client = new Client(getSettings(dbname));
  await client.connect();
  return client;
}

module.exports = { getSettings, getDatabaseName, getPool, closePool, createClient, isTestMode };
