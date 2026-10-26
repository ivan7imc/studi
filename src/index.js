import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { createPool, resolveConnectionString, waitForDatabase } from './db.js';
import { loadEnvFile } from './env.js';
import { FileStore, PostgresStore } from './store.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env local é opcional: no Render as variáveis vêm do painel.
loadEnvFile(path.join(rootDir, '.env'));

const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SKIP_DB = /^(1|true|yes)$/i.test(process.env.SKIP_DATABASE || '');

async function loadPlan() {
  const raw = await fs.readFile(path.join(dataDir, 'plan.json'), 'utf8');
  const plan = JSON.parse(raw);

  if (!Array.isArray(plan.sessions) || plan.sessions.length === 0) {
    throw new Error('data/plan.json não contém sessões.');
  }
  if (!plan.planId || !plan.title) {
    throw new Error('data/plan.json precisa dos campos planId e title.');
  }
  return plan;
}

async function buildStore(plan) {
  const { connectionString, source } = resolveConnectionString();

  if (!connectionString || SKIP_DB) {
    if (!connectionString) {
      console.warn(
        '[store] DATABASE_URL não definida: usando arquivo local (data/progress.local.json).\n' +
          '        No Render esse disco é efêmero — configure a connection string do Neon em Environment.'
      );
    }
    const store = new FileStore({ plan, dataDir });
    await store.init();
    return store;
  }

  console.log(`[db] conectando ao PostgreSQL via ${source}…`);
  const pool = createPool(connectionString);
  await waitForDatabase(pool, { attempts: 8, delayMs: 1500 });

  const store = new PostgresStore({ pool, plan });
  const result = await store.init();
  console.log(`[db] schema pronto: ${result.sessions} sessões sincronizadas (${result.removed} removidas).`);
  return store;
}

async function main() {
  const plan = await loadPlan();
  const store = await buildStore(plan);
  const startedAt = Date.now();

  const authPassword = (process.env.BASIC_AUTH_PASSWORD || '').trim();
  const auth = authPassword
    ? { user: (process.env.BASIC_AUTH_USER || 'estudos').trim(), password: authPassword }
    : null;
  if (auth) console.log('[server] Basic Auth ativado (BASIC_AUTH_PASSWORD definida).');

  const app = createApp({ store, plan, publicDir, startedAt, auth });
  const server = app.listen(PORT, HOST, () => {
    console.log(
      `[server] ouvindo em http://${HOST}:${PORT} • plano "${plan.title}" • ` +
        `${plan.sessions.length} sessões • armazenamento: ${store.storage}`
    );
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[server] ${signal} recebido, encerrando…`);

    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();

    server.close(async () => {
      try {
        await store.close();
      } catch (error) {
        console.error('[server] erro ao fechar o banco:', error.message);
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[startup] falha ao iniciar:', error);
  process.exit(1);
});
