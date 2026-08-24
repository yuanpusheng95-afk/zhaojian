import pg from 'pg';

const { Client } = pg;

if (process.env.DATABASE_URL) {
  process.stdout.write('Using DATABASE_URL supplied by the environment.\n');
  const url = new URL(process.env.DATABASE_URL);
  if (!url.pathname.endsWith('_test')) {
    url.pathname = '/photo_agent_test';
    process.env.DATABASE_URL = url.toString();
    process.stdout.write('Overriding non-test database with photo_agent_test.\n');
  }
  process.exit(0);
}

const client = new Client({
  connectionString:
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/postgres',
});
await client.connect();
try {
  const result = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = 'photo_agent_test'",
  );
  if (result.rowCount === 0) {
    await client.query('CREATE DATABASE photo_agent_test OWNER photo_agent');
    process.stdout.write('Created photo_agent_test.\n');
  }
} finally {
  await client.end();
}
