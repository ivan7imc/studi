import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { JSDOM } from 'jsdom';

const plan = JSON.parse(fs.readFileSync(new URL('../data/plan.json', import.meta.url), 'utf8'));
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appCode = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 2000, label = 'condição' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`Tempo esgotado esperando ${label}`);
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

/** Monta a página num DOM real (jsdom) com fetch simulado apontando para o store em memória. */
async function mount({ failPlanRequest = false, legacy = null } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const server = {
    sessions: plan.sessions.map((session) => ({ ...session, completed: false, completedAt: null })),
    calls: [],
  };
  const summary = () => {
    const completed = server.sessions.filter((session) => session.completed).length;
    return {
      total: server.sessions.length,
      completed,
      pending: server.sessions.length - completed,
      percent: Math.round((completed / server.sessions.length) * 100),
      lastCompletedAt: server.sessions.find((session) => session.completed)?.completedAt ?? null,
    };
  };

  window.fetch = async (url, options = {}) => {
    const target = String(url);
    server.calls.push({ url: target, method: options.method || 'GET', body: options.body });

    if (target.endsWith('/api/health')) return response({ ok: true, storage: 'postgres', database: { ok: true } });

    if (target.endsWith('/api/plan')) {
      if (failPlanRequest) throw new TypeError('Failed to fetch');
      return response({
        plan: { id: plan.planId, title: plan.title, subtitle: plan.subtitle },
        sessions: server.sessions,
        syllabus: plan.syllabus,
        summary: summary(),
        storage: 'postgres',
      });
    }

    if (target.includes('/api/sessions/')) {
      const date = decodeURIComponent(target.split('/api/sessions/')[1]);
      const { completed } = JSON.parse(options.body);
      const session = server.sessions.find((item) => item.date === date);
      session.completed = completed;
      session.completedAt = completed ? new Date().toISOString() : null;
      return response({ date, completed, completedAt: session.completedAt, summary: summary() });
    }

    if (target.endsWith('/api/progress') && options.method === 'DELETE') {
      server.sessions.forEach((session) => {
        session.completed = false;
        session.completedAt = null;
      });
      return response({ cleared: server.sessions.length, summary: summary() });
    }

    if (target.endsWith('/api/progress/import')) {
      const dates = new Set((JSON.parse(options.body).dates || []).filter((date) => date));
      server.sessions.forEach((session) => {
        session.completed = dates.has(session.date);
        session.completedAt = session.completed ? new Date().toISOString() : null;
      });
      return response({ imported: dates.size, ignored: 0, summary: summary() });
    }

    return response({ error: 'endpoint desconhecido' }, 404);
  };

  window.alert = () => {};
  window.confirm = () => true;
  if (legacy) window.localStorage.setItem('tjsp_oficial_justica_plano_2026_v2', JSON.stringify(legacy));

  window.eval(appCode);
  return { dom, window, server };
}

test('renderiza as 139 sessões, o checklist e o progresso inicial', async () => {
  const { window, server } = await mount();
  await waitFor(() => window.document.querySelectorAll('#schedule .day').length > 0, { label: 'calendário' });

  assert.equal(window.document.querySelectorAll('#schedule .day').length, plan.sessions.length);
  assert.equal(window.document.querySelectorAll('#schedule .week').length, 20);
  assert.ok(window.document.querySelectorAll('#syllabus details').length >= plan.syllabus.length);
  assert.match(window.document.getElementById('progressText').textContent, /^0 de 139 sessões concluídas \(0%\)/);
  assert.equal(window.document.getElementById('storageBadge').textContent, 'PostgreSQL (Neon)');
  assert.equal(window.document.getElementById('syncStatus').dataset.state, 'saved');
  assert.ok(server.calls.some((call) => call.url.endsWith('/api/plan')));
});

test('marcar uma sessão envia PUT e atualiza a barra de progresso', async () => {
  const { window, server } = await mount();
  await waitFor(() => window.document.querySelectorAll('#schedule .day').length > 0, { label: 'calendário' });

  const checkbox = window.document.querySelector('#schedule .day[data-date="2026-10-26"] input[type="checkbox"]');
  assert.ok(checkbox);
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));

  await waitFor(() => window.document.querySelector('#schedule .day[data-date="2026-10-26"]').classList.contains('done'), {
    label: 'card marcado',
  });
  await waitFor(() => server.calls.some((call) => call.method === 'PUT'), { label: 'PUT' });

  const put = server.calls.find((call) => call.method === 'PUT');
  assert.equal(put.url, '/api/sessions/2026-10-26');
  assert.deepEqual(JSON.parse(put.body), { completed: true });

  await waitFor(() => /^1 de 139 sessões concluídas \(1%\)/.test(window.document.getElementById('progressText').textContent), {
    label: 'progresso 1/139',
  });
  assert.equal(window.document.getElementById('progress').style.width, '1%');
  await waitFor(() => window.document.getElementById('syncStatus').dataset.state === 'saved', { label: 'status sincronizado' });
});

test('desmarcar devolve a sessão para pendente', async () => {
  const { window } = await mount();
  await waitFor(() => window.document.querySelectorAll('#schedule .day').length > 0, { label: 'calendário' });

  const card = () => window.document.querySelector('#schedule .day[data-date="2026-10-27"]');
  const toggle = () => {
    const checkbox = card().querySelector('input[type="checkbox"]');
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  toggle();
  await waitFor(() => card().classList.contains('done'), { label: 'marcada' });
  toggle();
  await waitFor(() => !card().classList.contains('done'), { label: 'desmarcada' });
  await waitFor(() => /^0 de 139/.test(window.document.getElementById('progressText').textContent), {
    label: 'progresso zerado',
  });
});

test('busca e filtros reduzem a lista sem perder marcações', async () => {
  const { window } = await mount();
  await waitFor(() => window.document.querySelectorAll('#schedule .day').length > 0, { label: 'calendário' });

  const search = window.document.getElementById('search');
  search.value = 'citação';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => window.document.querySelectorAll('#schedule .day').length < plan.sessions.length, {
    label: 'busca aplicada',
  });
  assert.ok(window.document.querySelectorAll('#schedule .day').length > 0);

  search.value = 'termo-inexistente-xyz';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => window.document.getElementById('schedule').textContent.includes('Nenhuma sessão'), {
    label: 'estado vazio',
  });

  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => window.document.querySelectorAll('#schedule .day').length === plan.sessions.length, {
    label: 'lista completa',
  });

  const statusFilter = window.document.getElementById('statusFilter');
  statusFilter.value = 'done';
  statusFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => window.document.getElementById('schedule').textContent.includes('Nenhuma sessão'), {
    label: 'filtro concluídas vazio',
  });
});

test('erro de rede sem cache mostra a tela de erro com "Tentar novamente"', async () => {
  const { window } = await mount({ failPlanRequest: true });
  await waitFor(() => window.document.body.textContent.includes('Não foi possível carregar o plano'), {
    label: 'tela de erro',
  });
  assert.ok(window.document.querySelector('#schedule button'));
  await waitFor(() => window.document.getElementById('syncStatus').dataset.state === 'error', { label: 'status de erro' });
});

test('migra o progresso antigo do localStorage para o banco', async () => {
  const { window, server } = await mount({
    legacy: { '2026-10-26': true, '2026-10-27': true, '2026-10-28': false },
  });

  await waitFor(() => server.calls.some((call) => call.url.endsWith('/api/progress/import')), { label: 'importação' });
  const call = server.calls.find((item) => item.url.endsWith('/api/progress/import'));
  const payload = JSON.parse(call.body);
  assert.deepEqual(payload.dates.sort(), ['2026-10-26', '2026-10-27']);

  await waitFor(() => /^2 de 139/.test(window.document.getElementById('progressText').textContent), {
    label: 'progresso migrado',
  });
  assert.ok(window.localStorage.getItem('tjsp_plano_migrado_v3'));
});
