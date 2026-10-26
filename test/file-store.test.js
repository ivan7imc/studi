import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileStore } from '../src/store.js';

const plan = JSON.parse(await fs.readFile(new URL('../data/plan.json', import.meta.url), 'utf8'));
const quietLog = { log() {}, warn() {}, error() {} };

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'plano-tjsp-'));
}

test('FileStore grava e recarrega o progresso', async () => {
  const dir = await tempDir();
  const store = new FileStore({ plan, dataDir: dir, log: quietLog });
  await store.init();

  let state = await store.getPlanState();
  assert.equal(state.storage, 'file');
  assert.equal(state.sessions.length, plan.sessions.length);
  assert.equal(state.summary.completed, 0);

  await store.setSession('2026-10-26', true);
  await store.setSession('2027-03-13', true);

  const reloaded = new FileStore({ plan, dataDir: dir, log: quietLog });
  await reloaded.init();
  state = await reloaded.getPlanState();
  assert.equal(state.summary.completed, 2);

  const done = state.sessions.filter((session) => session.completed).map((session) => session.date);
  assert.deepEqual(done, ['2026-10-26', '2027-03-13']);
  assert.equal(await reloaded.setSession('2030-01-01', true), null);
});

test('FileStore importa, zera e ignora datas fora do plano', async () => {
  const dir = await tempDir();
  const store = new FileStore({ plan, dataDir: dir, log: quietLog });
  await store.init();

  const imported = await store.importProgress(['2026-10-27', '2031-01-01']);
  assert.deepEqual(imported, { imported: 1, ignored: 1 });

  const state = await store.getPlanState();
  assert.equal(state.summary.completed, 1);

  assert.equal(await store.clearProgress(), 1);
  assert.equal((await store.getPlanState()).summary.completed, 0);
});

test('FileStore tolera arquivo corrompido', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'progress.local.json'), '{ não é json', 'utf8');

  const store = new FileStore({ plan, dataDir: dir, log: quietLog });
  await store.init();
  const state = await store.getPlanState();
  assert.equal(state.summary.completed, 0);
  assert.equal((await store.health()).ok, true);
});
