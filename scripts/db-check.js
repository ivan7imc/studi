// Diagnóstico da conexão com o banco: npm run db:check
// Útil para validar a connection string do Neon antes de configurar o Render.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, resolveConnectionString, waitForDatabase } from '../src/db.js';
import { loadEnvFile } from '../src/env.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(path.join(rootDir, '.env'));

const { connectionString, source } = resolveConnectionString();

if (!connectionString) {
  console.error('✖ DATABASE_URL (ou NEON_DATABASE_URL) não está definida.');
  console.error('  Copie a connection string do Neon e coloque no .env ou no painel do Render.');
  process.exit(1);
}

const masked = connectionString.replace(/(:\/\/[^:]+:)[^@]+@/, '$1****@');
console.log(`→ Conectando usando ${source}: ${masked}`);

const pool = createPool(connectionString);
let exitCode = 0;

try {
  await waitForDatabase(pool, { attempts: 3, delayMs: 1000 });

  const info = await pool.query('SELECT current_database() AS database, version() AS version');
  console.log(`✔ Conectado ao banco "${info.rows[0].database}"`);
  console.log(`  ${String(info.rows[0].version).split(' ').slice(0, 2).join(' ')}`);

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('plans', 'study_sessions')
      ORDER BY table_name`
  );
  const found = tables.rows.map((row) => row.table_name);

  if (found.length === 2) {
    const stats = await pool.query(
      `SELECT count(*)::int AS total,
              count(completed_at)::int AS concluidas,
              max(completed_at) AS ultima
         FROM study_sessions`
    );
    const { total, concluidas, ultima } = stats.rows[0];
    console.log(`✔ Tabelas ok — ${concluidas}/${total} sessões concluídas${ultima ? ` (última em ${ultima.toISOString()})` : ''}`);
  } else {
    console.log('⚠ Tabelas ainda não existem: o servidor cria o schema no primeiro boot (npm start).');
  }
} catch (error) {
  exitCode = 1;
  console.error(`✖ Falha ao conectar: ${error.message}`);
  console.error('  Verifique se a string é a "Pooled connection", se a senha está correta e se termina em ?sslmode=require.');
} finally {
  await pool.end();
}

process.exit(exitCode);
