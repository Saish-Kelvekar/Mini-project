'use strict';
/** scripts/testConnection.js - verify connectivity, tables, views and row counts (port of test_connection.py). */

const { getSettings, createClient, closePool } = require('../src/config/db');

const EXPECTED_TABLES = [
  'allocation', 'app_user', 'audit_log', 'conflict', 'event',
  'event_judge', 'event_requirement', 'fest_config', 'judge_availability',
  'registration', 'resource', 'schedule_slot', 'score',
  'timetable_version', 'venue_availability',
];
const EXPECTED_VIEWS = ['v_capacity_violations', 'v_event_judge_shortfall', 'v_judge_conflicts', 'v_participant_conflicts'];

async function main() {
  const s = getSettings();
  console.log(`Connecting to '${s.database}' on ${s.host}:${s.port} as ${s.user} ...`);

  let client;
  try {
    client = await createClient(s.database);
  } catch (err) {
    console.error('\n[CONNECTION FAILED]');
    console.error(err.message);
    console.error('\nCommon troubleshooting steps:');
    console.error(' 1. Ensure the PostgreSQL service is running.');
    console.error(' 2. Confirm DB_PASSWORD etc. in .env (copy .env.example to .env).');
    console.error(' 3. Run: npm run db:setup');
    process.exitCode = 1;
    return;
  }

  try {
    const v = await client.query('SELECT version()');
    console.log('Connected. Server:', v.rows[0].version.split(',')[0]);

    const t = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    );
    const foundTables = t.rows.map((r) => r.table_name);
    const missingTables = EXPECTED_TABLES.filter((x) => !foundTables.includes(x));
    console.log(`\nTables found: ${foundTables.length} (expected at least ${EXPECTED_TABLES.length})`);
    if (missingTables.length) {
      console.error('Missing tables:', missingTables.join(', '));
      console.error('Run: npm run db:setup');
      process.exitCode = 1;
      return;
    }

    const vw = await client.query(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY table_name`
    );
    const foundViews = vw.rows.map((r) => r.table_name);
    const missingViews = EXPECTED_VIEWS.filter((x) => !foundViews.includes(x));
    console.log(`Views found:  ${foundViews.length} (expected ${EXPECTED_VIEWS.length})`);
    if (missingViews.length) {
      console.error('Missing views:', missingViews.join(', '));
      process.exitCode = 1;
      return;
    }

    console.log('\nRow counts across tables:');
    for (const table of EXPECTED_TABLES) {
      // table names come from the fixed list above, not user input
      const r = await client.query(`SELECT count(*)::int AS cnt FROM ${table}`);
      console.log(`  ${table.padEnd(22)} ${r.rows[0].cnt}`);
    }
    console.log('\nAll database checks passed successfully.');
  } finally {
    await client.end();
  }
}

main()
  .catch((err) => {
    console.error('[FAILED]', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
