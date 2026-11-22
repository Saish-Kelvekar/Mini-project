'use strict';
const h = require('./helpers'); // must be first: forces NODE_ENV=test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDatabaseName } = require('../src/config/db');

before(async () => {
  await h.setupTestDb();
});
after(async () => {
  await h.closePool();
});

test('connects to PostgreSQL and runs a query', async () => {
  const { rows } = await h.getPool().query('SELECT 1 AS one');
  assert.equal(rows[0].one, 1);
});

test('tests run on an isolated *_test database, never the main one', async () => {
  const { rows } = await h.getPool().query('SELECT current_database() AS db');
  assert.match(rows[0].db, /_test$/);
});

test('config refuses a non-"_test" database name while in test mode', () => {
  assert.throws(() => getDatabaseName('event_timetable'), /must end with "_test"/);
});

test('server is PostgreSQL 15+ (schema uses UNIQUE NULLS NOT DISTINCT)', async () => {
  const { rows } = await h.getPool().query('SHOW server_version_num');
  assert.ok(Number(rows[0].server_version_num) >= 150000, `server_version_num=${rows[0].server_version_num}`);
});

test('btree_gist extension is installed (needed by the EXCLUDE constraints)', async () => {
  const { rows } = await h.getPool().query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
  assert.equal(rows.length, 1);
});

test('all 15 tables and 4 views from schema.sql exist', async () => {
  const t = await h.getPool().query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
  );
  const v = await h.getPool().query(`SELECT table_name FROM information_schema.views WHERE table_schema='public'`);
  const tables = t.rows.map((r) => r.table_name);
  const views = v.rows.map((r) => r.table_name);
  for (const name of [
    'allocation', 'app_user', 'audit_log', 'conflict', 'event', 'event_judge', 'event_requirement',
    'fest_config', 'judge_availability', 'registration', 'resource', 'schedule_slot', 'score',
    'timetable_version', 'venue_availability',
  ]) assert.ok(tables.includes(name), `missing table ${name}`);
  for (const name of ['v_capacity_violations', 'v_event_judge_shortfall', 'v_judge_conflicts', 'v_participant_conflicts'])
    assert.ok(views.includes(name), `missing view ${name}`);
});

test('pool serves more concurrent queries than it has connections', async () => {
  const jobs = Array.from({ length: 25 }, (_, i) => h.getPool().query('SELECT pg_sleep(0.05), $1::int AS n', [i]));
  const results = await Promise.all(jobs);
  assert.deepEqual(results.map((r) => r.rows[0].n), Array.from({ length: 25 }, (_, i) => i));
});

test('TIMESTAMP values come back as unchanged strings (no time-zone shift)', async () => {
  const { rows } = await h.getPool().query(`SELECT '2026-12-05 09:00:00'::timestamp AS t, '2026-12-05'::date AS d`);
  assert.equal(typeof rows[0].t, 'string');
  assert.equal(rows[0].t, '2026-12-05 09:00:00');
  assert.equal(rows[0].d, '2026-12-05');
});

test('COUNT(*) comes back as a number, not a string', async () => {
  const { rows } = await h.getPool().query('SELECT COUNT(*) AS n FROM app_user');
  assert.equal(typeof rows[0].n, 'number');
});
