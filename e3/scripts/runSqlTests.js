'use strict';
/**
 * scripts/runSqlTests.js - run database/tests.sql (16 plain-SQL tests) against the TEST database.
 *
 * NODE_ENV is forced to "test" so the DB used is DB_NAME_TEST (must end in "_test").
 * The test database is created and the schema applied if needed.
 */

process.env.NODE_ENV = 'test';

const { createClient, getDatabaseName, closePool } = require('../src/config/db');
const { createDatabaseIfMissing, runSqlFile, readSqlFile } = require('./lib');

async function main() {
  const dbname = getDatabaseName();
  await createDatabaseIfMissing(dbname);
  const client = await createClient(dbname);
  client.on('notice', (n) => console.log('  ' + n.message));

  try {
    await runSqlFile(client, 'schema.sql');
    console.log(`Running database/tests.sql against '${dbname}' ...\n`);
    const results = await client.query(readSqlFile('tests.sql'));
    const last = Array.isArray(results) ? results[results.length - 1] : results;
    const row = last.rows[0];
    console.log('\nSummary:', row);

    const failed = await client.query(`SELECT test_id, name FROM test_results WHERE status <> 'PASS' ORDER BY test_id`);
    if (failed.rows.length) console.log('Failed:', failed.rows);
    if (row.fail_count !== 0 || row.total_tests !== 16) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main()
  .catch((err) => {
    console.error(`[FAILED] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
