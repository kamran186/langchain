import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../config/env.js';

export function createPool(connectionString = loadEnv().DATABASE_URL): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function runSqlFile(pool: pg.Pool, name: 'schema' | 'seed'): Promise<void> {
  const path = fileURLToPath(new URL(`./${name}.sql`, import.meta.url));
  await pool.query(await readFile(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const pool = createPool();
  const name = process.argv[2];
  if (name !== 'init' && name !== 'seed') throw new Error('Use init or seed');
  try { await runSqlFile(pool, name === 'init' ? 'schema' : 'seed'); }
  finally { await pool.end(); }
}
