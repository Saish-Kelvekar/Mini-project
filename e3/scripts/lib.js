'use strict';
/** Shared helpers for the setup / check / SQL-test scripts and the Node tests. */

const fs = require('fs');
const path = require('path');
const { createClient, getDatabaseName } = require('../src/config/db');

const DB_DIR = path.join(__dirname, '..', 'database');

/** Read a .sql file and drop psql-only backslash commands (e.g. \set ON_ERROR_STOP on). */
function readSqlFile(filename) {
  const text = fs.readFileSync(path.join(DB_DIR, filename), 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n');
}

/** Connect to the built-in "postgres" database and CREATE DATABASE if missing. */
async function createDatabaseIfMissing(dbname = getDatabaseName()) {
  const admin = await createClient('postgres');
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbname]);
    if (rows.length) return false;
    // Identifiers cannot be parameterized; quote safely.
    const ident = '"' + dbname.replace(/"/g, '""') + '"';
    await admin.query(`CREATE DATABASE ${ident}`);
    return true;
  } finally {
    await admin.end();
  }
}

/** Run a whole .sql file (multi-statement) on a client. */
async function runSqlFile(client, filename) {
  const result = await client.query(readSqlFile(filename));
  return result;
}

module.exports = { readSqlFile, createDatabaseIfMissing, runSqlFile };
