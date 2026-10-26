import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DataType, newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { PostgresStore } from '../src/store.js';

const plan = JSON.parse(fs.readFileSync(new URL('../data/plan.json', import.meta.url), 'utf8'));
const publicDir = new URL('../public', import.meta.url).pathname;

const quietLog = { log() {}, warn() {}, error() {} };

async function startServer({ auth = null } = {}) {
  const db = newDb({ noAstCoverageCheck: true });
  db.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'PostgreSQL 16.4 (pg-mem)' });
  const { Pool } = db.adapters.createPg();
  const store = new PostgresStore({ pool: new Pool(), plan, log: quietLog });
  await store.init();

  const app = createApp({ store, plan, publicDir, auth, log: quietLog });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withServer(run, options) {
  const ctx = await startServer(options);
  try {
    await run(ctx);
  } finally {
    await ctx.close();
  }
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('GET /api/plan devolve calendário, checklist e resumo', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await json(await fetch(`${base}/api/plan`));
    assert.equal(status, 200);
    assert.equal(body.storage, 'postgres');
    assert.equal(body.sessions.length, plan.sessions.length);
    assert.equal(body.syllabus.length, plan.syllabus.length);
    assert.deepEqual(body.summary, {
      total: plan.sessions.length,
      completed: 0,
      pending: plan.sessions.length,
      percent: 0,
      lastCompletedAt: null,
    });
    assert.equal(body.sessions[0].completed, false);
    assert.equal(body.sessions[0].subject, plan.sessions[0].subject);
  });
});

test('PUT /api/sessions/:date marca a sessão e atualiza o resumo', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await json(
      await fetch(`${base}/api/sessions/2026-10-26`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      })
    );

    assert.equal(status, 200);
    assert.equal(body.date, '2026-10-26');
    assert.equal(body.completed, true);
    assert.ok(body.completedAt);
    assert.equal(body.summary.completed, 1);

    const planResponse = await json(await fetch(`${base}/api/plan`));
    assert.equal(planResponse.body.sessions[0].completed, true);
    assert.equal(planResponse.body.summary.percent, Math.round((1 / plan.sessions.length) * 100));
  });
});

test('PUT valida data, corpo e existência no plano', async () => {
  await withServer(async ({ base }) => {
    const put = (date, body) =>
      fetch(`${base}/api/sessions/${date}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    assert.equal((await json(await put('26-10-2026', { completed: true }))).status, 400);
    assert.equal((await json(await put('2026-02-31', { completed: true }))).status, 400);
    assert.equal((await json(await put('2026-10-26', { completed: 'sim' }))).status, 400);
    assert.equal((await json(await put('2026-10-26', undefined))).status, 400);

    const outside = await json(await put('2027-12-31', { completed: true }));
    assert.equal(outside.status, 404);
    assert.match(outside.body.error, /não faz parte do plano/);
  });
});

test('DELETE /api/progress zera as marcações', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/api/sessions/2026-10-26`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    });
    await fetch(`${base}/api/sessions/2026-10-27`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    });

    const { status, body } = await json(await fetch(`${base}/api/progress`, { method: 'DELETE' }));
    assert.equal(status, 200);
    assert.equal(body.cleared, 2);
    assert.equal(body.summary.completed, 0);
  });
});

test('POST /api/progress/import aceita o backup exportado', async () => {
  await withServer(async ({ base }) => {
    const payload = {
      exportadoEm: '2026-10-26T12:00:00.000Z',
      plano: plan.planId,
      concluidas: ['2026-10-26', '2026-10-28', '2026-10-28', '2027-10-01', 'lixo'],
    };
    const { status, body } = await json(
      await fetch(`${base}/api/progress/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );

    assert.equal(status, 200);
    assert.equal(body.imported, 2);
    assert.equal(body.ignored, 3);
    assert.equal(body.summary.completed, 2);

    const planResponse = await json(await fetch(`${base}/api/plan`));
    const done = planResponse.body.sessions.filter((session) => session.completed).map((session) => session.date);
    assert.deepEqual(done, ['2026-10-26', '2026-10-28']);
  });
});

test('POST /api/progress/import rejeita corpo inválido', async () => {
  await withServer(async ({ base }) => {
    const post = (body) =>
      fetch(`${base}/api/progress/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    assert.equal((await json(await post({ concluidas: 'nada' }))).status, 400);
    assert.equal((await json(await post('{quebrado'))).status, 400);
  });
});

test('health checks e endpoints desconhecidos', async () => {
  await withServer(async ({ base }) => {
    const liveness = await json(await fetch(`${base}/healthz`));
    assert.equal(liveness.status, 200);
    assert.equal(liveness.body.ok, true);

    const health = await json(await fetch(`${base}/api/health`));
    assert.equal(health.status, 200);
    assert.equal(health.body.storage, 'postgres');
    assert.equal(health.body.database.ok, true);
    assert.equal(health.body.plan.sessions, plan.sessions.length);

    const missing = await json(await fetch(`${base}/api/nao-existe`));
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /não encontrado/);
  });
});

test('serve a página, o CSS e o JS', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /Oficial de Justiça — TJSP 2026/);
    assert.match(html, /\/app\.js|\.\/app\.js/);

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    // Não expõe arquivos fora de public/
    const traversal = await fetch(`${base}/../package.json`);
    assert.notEqual(traversal.status, 200);
  });
});

test('arquivos do front-end existem no diretório public', () => {
  for (const file of ['index.html', 'styles.css', 'app.js']) {
    assert.ok(fs.existsSync(path.join(publicDir, file)), `${file} ausente`);
  }
});

test('Basic Auth opcional protege o app e mantém /healthz aberto', async () => {
  const auth = { user: 'estudos', password: 'segredo' };
  await withServer(async ({ base }) => {
    const header = (value) => ({ Authorization: `Basic ${Buffer.from(value).toString('base64')}` });

    const blocked = await fetch(`${base}/api/plan`);
    assert.equal(blocked.status, 401);
    assert.match(blocked.headers.get('www-authenticate'), /^Basic/);
    assert.equal((await fetch(`${base}/`)).status, 401);

    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/plan`, { headers: header('estudos:segredo') })).status, 200);
    assert.equal((await fetch(`${base}/api/plan`, { headers: header('estudos:errado') })).status, 401);
    assert.equal((await fetch(`${base}/api/plan`, { headers: header('outro:segredo') })).status, 401);
  }, { auth });
});
