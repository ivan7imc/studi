import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DataType, newDb } from 'pg-mem';
import { PostgresStore } from '../src/store.js';

const plan = JSON.parse(fs.readFileSync(new URL('../data/plan.json', import.meta.url), 'utf8'));

function makePool() {
  // pg-mem é apenas um dublê de teste: desligamos a checagem de AST que
  // reclama de recursos válidos no Postgres real (DEFAULT now(), jsonb etc.).
  const db = newDb({ noAstCoverageCheck: true });
  db.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'PostgreSQL 16.4 (pg-mem)' });
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

test('seed cria o schema e carrega todas as sessões do plano', async () => {
  const store = new PostgresStore({ pool: makePool(), plan });
  const result = await store.init();
  assert.equal(result.sessions, plan.sessions.length);

  const state = await store.getPlanState();
  assert.equal(state.sessions.length, plan.sessions.length);
  assert.equal(state.sessions[0].date, '2026-10-26');
  assert.equal(state.sessions[0].display, '26/10/2026');
  assert.equal(state.sessions.at(-1).date, '2027-03-13');
  assert.equal(state.syllabus.length, plan.syllabus.length);
  assert.equal(state.summary.completed, 0);
  assert.equal(state.summary.total, plan.sessions.length);
  assert.equal(state.storage, 'postgres');
});

test('init é idempotente e preserva o progresso', async () => {
  const pool = makePool();
  const store = new PostgresStore({ pool, plan });
  await store.init();
  await store.setSession('2026-10-26', true);

  const second = new PostgresStore({ pool, plan });
  await second.init();

  const state = await second.getPlanState();
  assert.equal(state.sessions.length, plan.sessions.length);
  assert.equal(state.summary.completed, 1);
  assert.equal(state.sessions[0].completed, true);
});

test('marcar e desmarcar sessões', async () => {
  const store = new PostgresStore({ pool: makePool(), plan });
  await store.init();

  const marked = await store.setSession('2026-10-27', true);
  assert.equal(marked.date, '2026-10-27');
  assert.equal(marked.completed, true);
  assert.ok(marked.completedAt);

  let state = await store.getPlanState();
  assert.equal(state.summary.completed, 1);
  assert.equal(state.summary.percent, Math.round((1 / plan.sessions.length) * 100));

  const unmarked = await store.setSession('2026-10-27', false);
  assert.equal(unmarked.completedAt, null);

  state = await store.getPlanState();
  assert.equal(state.summary.completed, 0);

  // Marcar duas vezes não muda o horário original (PUT idempotente).
  const first = await store.setSession('2026-10-27', true);
  const again = await store.setSession('2026-10-27', true);
  assert.equal(first.completedAt, again.completedAt);
});

test('data fora do plano não é aceita', async () => {
  const store = new PostgresStore({ pool: makePool(), plan });
  await store.init();
  assert.equal(await store.setSession('2030-01-01', true), null);
});

test('zerar progresso devolve quantas marcações foram apagadas', async () => {
  const store = new PostgresStore({ pool: makePool(), plan });
  await store.init();
  await store.setSession('2026-10-26', true);
  await store.setSession('2026-10-27', true);

  assert.equal(await store.clearProgress(), 2);
  const state = await store.getPlanState();
  assert.equal(state.summary.completed, 0);
  assert.equal(await store.clearProgress(), 0);
});

test('importação substitui o progresso e ignora datas desconhecidas', async () => {
  const store = new PostgresStore({ pool: makePool(), plan });
  await store.init();
  await store.setSession('2026-10-26', true);

  const result = await store.importProgress(['2026-10-27', '2026-10-28', '2031-05-05', '2026-10-27']);
  assert.equal(result.imported, 2);
  assert.equal(result.ignored, 1);

  const state = await store.getPlanState();
  assert.equal(state.summary.completed, 2);
  assert.deepEqual(
    state.sessions.filter((session) => session.completed).map((session) => session.date),
    ['2026-10-27', '2026-10-28']
  );
});

test('init remove sessões que saíram do plano', async () => {
  const pool = makePool();
  const store = new PostgresStore({ pool, plan });
  await store.init();

  await pool.query(
    `INSERT INTO study_sessions (plan_id, session_date, display_date, weekday, week, phase, subject, task)
     VALUES ($1, '2027-04-01', '01/04/2027', 'quinta-feira', 99, 'Extra', 'Extra', 'Sessão que não existe mais')`,
    [plan.planId]
  );
  assert.equal((await store.getPlanState()).sessions.length, plan.sessions.length + 1);

  const result = await store.init();
  assert.equal(result.removed, 1);
  assert.equal((await store.getPlanState()).sessions.length, plan.sessions.length);
});

test('health responde com versão do servidor', async () => {
  const store = new PostgresStore({ pool: makePool(), plan });
  await store.init();
  const health = await store.health();
  assert.equal(health.ok, true);
  assert.ok(health.server.length > 0);
});
