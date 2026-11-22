'use strict';
/**
 * scripts/setupDb.js - create the database (if missing) and apply database/schema.sql.
 * Safe by default: running it normally does NOT delete data. Wiping needs --reset.
 *
 *   npm run db:setup                 create DB + apply schema (no data loss)
 *   node scripts/setupDb.js --sample also load database/sample_data.sql
 *   npm run db:reset                 DANGER: drop everything, recreate, load sample data
 *   --yes                            skip the confirmation prompt
 *   --dbname NAME                    override the database name
 */

const readline = require('readline');
const { createClient, getDatabaseName, closePool } = require('../src/config/db');
const { createDatabaseIfMissing, runSqlFile } = require('./lib');

function parseArgs(argv) {
  const args = { sample: false, reset: false, yes: false, dbname: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sample') args.sample = true;
    else if (argv[i] === '--reset') args.reset = true;
    else if (argv[i] === '--yes') args.yes = true;
    else if (argv[i] === '--dbname') args.dbname = argv[++i];
  }
  return args;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbname = getDatabaseName(args.dbname);

  if (args.reset && !args.yes) {
    const answer = await ask(`WARNING: --reset will DELETE ALL TABLES AND DATA in '${dbname}'. Continue? [y/N]: `);
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const created = await createDatabaseIfMissing(dbname);
  console.log(created ? `[OK] Created database '${dbname}'.` : `[OK] Database '${dbname}' exists.`);

  const client = await createClient(dbname);
  try {
    if (args.reset) {
      console.log(`Resetting schema in '${dbname}'...`);
      await runSqlFile(client, 'schema_reset.sql');
      console.log('[OK] schema_reset.sql executed.');
    }
    console.log(`Applying schema to '${dbname}'...`);
    await runSqlFile(client, 'schema.sql');
    console.log('[OK] schema.sql executed.');

    if (args.sample) {
      console.log(`Loading sample data into '${dbname}'...`);
      try {
        await runSqlFile(client, 'sample_data.sql');
      } catch (err) {
        // sample_data.sql opens its own BEGIN; leave nothing half-done.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      console.log('[OK] sample_data.sql executed.');
    }
  } finally {
    await client.end();
  }
  console.log('\nSetup completed successfully.\nVerify with: npm run db:check');
}

main()
  .catch((err) => {
    console.error(`\n[FAILED]: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
