/* Plano de Estudos TJSP — Oficial de Justiça
 * Progresso persistido no servidor (PostgreSQL/Neon). Sem estado global:
 * `state.sessions` é a fonte da verdade depois de cada resposta da API.
 */
(() => {
  'use strict';

  const API = {
    plan: '/api/plan',
    health: '/api/health',
    session: (date) => `/api/sessions/${encodeURIComponent(date)}`,
    progress: '/api/progress',
    import: '/api/progress/import',
  };

  const CACHE_KEY = 'tjsp_plano_cache_v3';
  const PENDING_KEY = 'tjsp_plano_pendentes_v3';
  const LEGACY_KEY = 'tjsp_oficial_justica_plano_2026_v2';
  const LEGACY_MIGRATED_KEY = 'tjsp_plano_migrado_v3';
  const REQUEST_TIMEOUT_MS = 15000;
  const RETRY_DELAY_MS = 30000;

  const state = {
    plan: null,
    sessions: [],
    syllabus: [],
    summary: { total: 0, completed: 0, pending: 0, percent: 0, lastCompletedAt: null },
    storage: null,
    pending: new Map(),
    syncing: false,
    offline: false,
    loadFailed: false,
    migrating: false,
    lastLoad: 0,
  };

  const el = {
    schedule: document.getElementById('schedule'),
    syllabus: document.getElementById('syllabus'),
    progress: document.getElementById('progress'),
    progressbar: document.querySelector('.progressbar'),
    progressText: document.getElementById('progressText'),
    sync: document.getElementById('syncStatus'),
    syncText: document.getElementById('syncText'),
    storageBadge: document.getElementById('storageBadge'),
    banner: document.getElementById('banner'),
    search: document.getElementById('search'),
    phaseFilter: document.getElementById('phaseFilter'),
    statusFilter: document.getElementById('statusFilter'),
    printBtn: document.getElementById('printBtn'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    importFile: document.getElementById('importFile'),
    clearBtn: document.getElementById('clearBtn'),
  };

  /* ------------------------------------------------------------------ */
  /* utilidades                                                          */
  /* ------------------------------------------------------------------ */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* armazenamento cheio/disponibilidade: o servidor continua sendo a fonte da verdade */
    }
  }

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (!response.ok) {
        const error = new Error((data && data.error) || `Falha na requisição (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* status de sincronização                                             */
  /* ------------------------------------------------------------------ */

  function setSync(mode, text) {
    el.sync.dataset.state = mode;
    el.syncText.textContent = text;
  }

  function updateSync() {
    if (state.syncing) {
      setSync('saving', 'Salvando no banco de dados…');
      return;
    }
    if (state.loadFailed) {
      setSync('error', 'Sem conexão com o servidor.');
      return;
    }
    if (state.pending.size) {
      setSync('offline', `Sem conexão com o servidor — ${state.pending.size} alteração(ões) aguardando envio.`);
      return;
    }
    if (state.offline) {
      setSync('offline', 'Sem conexão com o servidor — exibindo a última versão salva neste navegador.');
      return;
    }
    if (state.storage === 'file') {
      setSync('local', 'Modo local: sem DATABASE_URL, o progresso fica em arquivo e pode se perder no deploy.');
      return;
    }
    const when = formatTime(state.summary.lastCompletedAt);
    setSync('saved', when ? `Sincronizado com o banco de dados • última sessão em ${when}` : 'Sincronizado com o banco de dados.');
  }

  function updateStorageBadge() {
    if (!state.storage) {
      el.storageBadge.textContent = 'indisponível';
      el.storageBadge.dataset.kind = 'warn';
      return;
    }
    if (state.storage === 'postgres') {
      el.storageBadge.textContent = 'PostgreSQL (Neon)';
      el.storageBadge.dataset.kind = 'ok';
      return;
    }
    el.storageBadge.textContent = 'arquivo local (efêmero no Render)';
    el.storageBadge.dataset.kind = 'warn';
  }

  function showBanner(message, { retry = false } = {}) {
    el.banner.innerHTML = '';
    if (!message) {
      el.banner.hidden = true;
      return;
    }
    const text = document.createElement('span');
    text.textContent = message;
    el.banner.append(text);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Tentar novamente';
      button.addEventListener('click', () => load());
      el.banner.append(button);
    }
    el.banner.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* estado e renderização                                               */
  /* ------------------------------------------------------------------ */

  function applyPlan(data) {
    state.plan = data.plan || null;
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    state.syllabus = Array.isArray(data.syllabus) ? data.syllabus : [];
    state.storage = data.storage || null;
    state.summary = data.summary || computeSummary();
    state.lastLoad = Date.now();

    if (el.phaseFilter.options.length <= 1) {
      const phases = [...new Set(state.sessions.map((session) => session.phase))];
      phases.forEach((phase) => {
        const option = document.createElement('option');
        option.value = phase;
        option.textContent = phase;
        el.phaseFilter.append(option);
      });
    }
  }

  function computeSummary() {
    const total = state.sessions.length;
    const completedSessions = state.sessions.filter((session) => session.completed);
    const stamps = completedSessions.map((session) => session.completedAt).filter(Boolean).sort();
    return {
      total,
      completed: completedSessions.length,
      pending: total - completedSessions.length,
      percent: total ? Math.round((completedSessions.length / total) * 100) : 0,
      lastCompletedAt: stamps.length ? stamps[stamps.length - 1] : null,
    };
  }

  function overlayPending() {
    if (!state.pending.size) return;
    const byDate = new Map(state.sessions.map((session) => [session.date, session]));
    state.pending.forEach((completed, date) => {
      const session = byDate.get(date);
      if (!session) return;
      session.completed = completed;
      if (!completed) session.completedAt = null;
    });
    state.summary = computeSummary();
  }

  function cardHtml(session) {
    return `<article class="day${session.completed ? ' done' : ''}" data-date="${esc(session.date)}">
      <div class="daytop">
        <div><div class="date">${esc(session.weekday)} • ${esc(session.display)}</div><h3>${esc(session.subject)}</h3></div>
        <span class="tag">60 min</span>
      </div>
      <p class="task">${esc(session.task)}</p>
      <label class="complete"><input type="checkbox" data-date="${esc(session.date)}"${session.completed ? ' checked' : ''} aria-label="Marcar a sessão de ${esc(session.display)} como concluída"> Sessão concluída</label>
    </article>`;
  }

  function render() {
    const query = el.search.value.toLowerCase().trim();
    const phase = el.phaseFilter.value;
    const status = el.statusFilter.value;

    const groups = new Map();
    state.sessions.forEach((session) => {
      if (phase && session.phase !== phase) return;
      if (status === 'done' && !session.completed) return;
      if (status === 'pending' && session.completed) return;
      if (query) {
        const haystack = `${session.date} ${session.display} ${session.weekday} ${session.phase} ${session.subject} ${session.task}`.toLowerCase();
        if (!haystack.includes(query)) return;
      }
      if (!groups.has(session.week)) groups.set(session.week, []);
      groups.get(session.week).push(session);
    });

    el.schedule.innerHTML = '';

    if (!groups.size) {
      const empty = document.createElement('section');
      empty.className = 'panel';
      empty.textContent = 'Nenhuma sessão corresponde aos filtros.';
      el.schedule.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    groups.forEach((items, week) => {
      const done = items.filter((item) => item.completed).length;
      const section = document.createElement('section');
      section.className = 'week';
      section.innerHTML = `<div class="weekhead"><div>
          <h2>Semana ${esc(week)} — ${esc(items[0].phase)}</h2>
          <p>Semana iniciada em ${esc(items[0].display)} • ${items.length} sessões • ${done} concluída(s)</p>
        </div></div>`;
      const grid = document.createElement('div');
      grid.className = 'days';
      grid.innerHTML = items.map(cardHtml).join('');
      section.append(grid);
      fragment.append(section);
    });
    el.schedule.append(fragment);
  }

  function renderProgress() {
    const { total, completed } = state.summary;
    const pct = total ? Math.round((completed / total) * 100) : 0;
    el.progress.style.width = `${pct}%`;
    if (el.progressbar) el.progressbar.setAttribute('aria-valuenow', String(pct));

    const suffix = state.storage === 'file'
      ? ' Progresso em arquivo local — configure o banco para não perder no deploy.'
      : ' Progresso salvo no banco de dados e sincronizado entre dispositivos.';
    el.progressText.textContent = `${completed} de ${total} sessões concluídas (${pct}%).${suffix}`;
  }

  function renderSyllabus() {
    el.syllabus.innerHTML = '';
    const fragment = document.createDocumentFragment();
    state.syllabus.forEach((group, index) => {
      const details = document.createElement('details');
      if (index === 0) details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.title;
      details.append(summary);
      const list = document.createElement('ul');
      (group.items || []).forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item;
        list.append(li);
      });
      details.append(list);
      fragment.append(details);
    });
    el.syllabus.append(fragment);
  }

  function renderAll() {
    render();
    renderProgress();
    renderSyllabus();
    updateStorageBadge();
    updateSync();
  }

  function renderFatalError(error) {
    el.schedule.innerHTML = '';
    const panel = document.createElement('section');
    panel.className = 'panel error-panel';
    const title = document.createElement('h2');
    title.textContent = 'Não foi possível carregar o plano';
    const detail = document.createElement('p');
    detail.textContent = error && error.message ? error.message : 'Erro desconhecido.';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Verifique se o serviço está no ar e se a variável DATABASE_URL aponta para o banco do Neon.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary';
    retry.textContent = 'Tentar novamente';
    retry.addEventListener('click', () => load());
    panel.append(title, detail, hint, retry);
    el.schedule.append(panel);
    el.progressText.textContent = 'Progresso indisponível no momento.';
  }

  /* ------------------------------------------------------------------ */
  /* sincronização do progresso                                          */
  /* ------------------------------------------------------------------ */

  function persistPending() {
    writeJson(PENDING_KEY, Object.fromEntries(state.pending));
  }

  function restorePending() {
    const stored = readJson(PENDING_KEY, null);
    if (!stored || typeof stored !== 'object') return;
    Object.entries(stored).forEach(([date, completed]) => {
      if (typeof completed === 'boolean') state.pending.set(date, completed);
    });
  }

  async function flushPending() {
    if (state.syncing || state.pending.size === 0) return;
    state.syncing = true;
    updateSync();

    try {
      while (state.pending.size) {
        const [date, completed] = state.pending.entries().next().value;
        const response = await fetchJson(API.session(date), {
          method: 'PUT',
          body: JSON.stringify({ completed }),
        });
        state.pending.delete(date);
        persistPending();
        if (response && response.summary) state.summary = response.summary;
        const session = state.sessions.find((item) => item.date === date);
        if (session && response) session.completedAt = response.completedAt || null;
      }
      state.offline = false;
      showBanner('');
    } catch (error) {
      state.offline = true;
      showBanner(
        `Não foi possível salvar no banco de dados (${error.message}). As marcações ficam guardadas aqui e serão reenviadas automaticamente.`,
        { retry: true }
      );
      scheduleRetry();
    } finally {
      state.syncing = false;
      renderProgress();
      updateSync();
    }
  }

  let retryTimer = null;
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (state.pending.size) flushPending();
    }, RETRY_DELAY_MS);
  }

  function toggleSession(date, completed) {
    const session = state.sessions.find((item) => item.date === date);
    if (!session) return;

    session.completed = completed;
    if (!completed) session.completedAt = null;
    state.pending.set(date, completed);
    persistPending();

    state.summary = computeSummary();
    renderProgress();

    const card = el.schedule.querySelector(`.day[data-date="${date}"]`);
    if (card) card.classList.toggle('done', completed);

    flushPending();
  }

  /* ------------------------------------------------------------------ */
  /* carga inicial                                                       */
  /* ------------------------------------------------------------------ */

  async function load({ silent = false } = {}) {
    if (!silent) setSync('loading', 'Carregando o progresso do banco de dados…');

    try {
      const data = await fetchJson(API.plan);
      applyPlan(data);
      overlayPending();
      writeJson(CACHE_KEY, data);
      state.offline = false;
      state.loadFailed = false;
      showBanner('');
      renderAll();
      await migrateLegacyProgress();
      await flushPending();
    } catch (error) {
      const cached = readJson(CACHE_KEY, null);
      if (cached && Array.isArray(cached.sessions) && cached.sessions.length) {
        applyPlan(cached);
        overlayPending();
        state.offline = true;
        state.loadFailed = false;
        renderAll();
        showBanner(
          `Não foi possível falar com o servidor (${error.message}). Exibindo a última versão salva neste navegador.`,
          { retry: true }
        );
      } else {
        state.offline = true;
        state.loadFailed = true;
        renderFatalError(error);
        updateSync();
        if (state.pending.size) scheduleRetry();
      }
    }
  }

  /** Traz as marcações antigas do localStorage (versão 2) para o banco. */
  async function migrateLegacyProgress() {
    if (state.migrating) return;
    if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return;
    if (state.summary.completed > 0) return;

    const legacy = readJson(LEGACY_KEY, null);
    if (!legacy || typeof legacy !== 'object') return;

    const dates = Object.keys(legacy).filter((date) => legacy[date]);
    if (!dates.length) return;

    state.migrating = true;
    try {
      const result = await fetchJson(API.import, {
        method: 'POST',
        body: JSON.stringify({ dates }),
      });
      localStorage.setItem(LEGACY_MIGRATED_KEY, new Date().toISOString());
      const fresh = await fetchJson(API.plan);
      applyPlan(fresh);
      overlayPending();
      writeJson(CACHE_KEY, fresh);
      renderAll();
      if (result && result.imported) {
        setSync('saved', `Progresso antigo migrado do navegador: ${result.imported} sessão(ões) concluída(s).`);
      }
    } catch {
      /* silencioso: tentamos novamente na próxima carga */
    } finally {
      state.migrating = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* ações                                                               */
  /* ------------------------------------------------------------------ */

  function exportProgress() {
    const payload = {
      exportadoEm: new Date().toISOString(),
      plano: state.plan ? state.plan.id : 'tjsp-oficial-justica-2026-v2',
      totalSessoes: state.sessions.length,
      concluidas: state.sessions.filter((session) => session.completed).map((session) => session.date),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'progresso-plano-tjsp.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importProgress(file) {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      window.alert('Arquivo inválido: envie o JSON gerado pelo botão "Exportar progresso".');
      return;
    }

    const dates = Array.isArray(payload) ? payload : payload.dates || payload.concluidas;
    if (!Array.isArray(dates)) {
      window.alert('O arquivo não contém a lista "concluidas" de sessões.');
      return;
    }

    const confirmed = window.confirm(
      `Importar ${dates.length} sessão(ões) concluída(s)? As marcações atuais serão substituídas.`
    );
    if (!confirmed) return;

    setSync('saving', 'Importando progresso…');
    try {
      const result = await fetchJson(API.import, { method: 'POST', body: JSON.stringify({ dates }) });
      state.pending.clear();
      persistPending();
      await load({ silent: true });
      showBanner('');
      setSync('saved', `Progresso importado: ${result.imported} sessão(ões) concluída(s).`);
    } catch (error) {
      window.alert(`Não foi possível importar: ${error.message}`);
      updateSync();
    }
  }

  async function clearProgress() {
    if (!window.confirm('Tem certeza de que deseja apagar todas as marcações?')) return;

    setSync('saving', 'Zerando marcações…');
    state.pending.clear();
    persistPending();
    try {
      const result = await fetchJson(API.progress, { method: 'DELETE' });
      await load({ silent: true });
      showBanner('');
      setSync('saved', `Marcações apagadas (${result && result.cleared ? result.cleared : 0} sessão(ões)).`);
    } catch (error) {
      window.alert(`Não foi possível zerar as marcações: ${error.message}`);
      updateSync();
    }
  }

  /* ------------------------------------------------------------------ */
  /* eventos                                                             */
  /* ------------------------------------------------------------------ */

  el.schedule.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-date]');
    if (!checkbox) return;
    toggleSession(checkbox.dataset.date, checkbox.checked);
  });

  el.search.addEventListener('input', render);
  el.phaseFilter.addEventListener('change', render);
  el.statusFilter.addEventListener('change', render);
  el.printBtn.addEventListener('click', () => window.print());
  el.exportBtn.addEventListener('click', exportProgress);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', () => {
    const file = el.importFile.files && el.importFile.files[0];
    el.importFile.value = '';
    if (file) importProgress(file);
  });
  el.clearBtn.addEventListener('click', clearProgress);

  window.addEventListener('online', () => {
    if (state.pending.size) flushPending();
    else load({ silent: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.syncing || state.pending.size) return;
    if (Date.now() - state.lastLoad < 30000) return;
    load({ silent: true });
  });

  /* ------------------------------------------------------------------ */
  /* início                                                              */
  /* ------------------------------------------------------------------ */

  restorePending();
  load();

  fetchJson(API.health)
    .then((health) => {
      if (health && health.storage) state.storage = health.storage;
      if (state.storage) updateStorageBadge();
      updateSync();
    })
    .catch(() => {
      /* o /api/plan já informa o modo de armazenamento; health é apenas informativo */
    });
})();
