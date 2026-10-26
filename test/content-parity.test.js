// Garante que nenhum conteúdo do plano original (versão 2, HTML autocontido)
// se perdeu na migração para o app com banco de dados.
//
// A fixture guarda o arquivo recebido, com as 139 sessões e o checklist do
// Anexo VIII. Qualquer remoção de tarefa, matéria, data ou item do checklist
// quebra estes testes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { JSDOM } from 'jsdom';

const fixture = fs.readFileSync(new URL('./fixtures/plano_original_v2.html', import.meta.url), 'utf8');
const plan = JSON.parse(fs.readFileSync(new URL('../data/plan.json', import.meta.url), 'utf8'));
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appCode = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const FIELDS = ['date', 'display', 'weekday', 'week', 'phase', 'subject', 'task'];

/** Extrai o literal de array do script original (mesma semântica de um parser). */
function readArray(name) {
  const script = fixture.slice(fixture.indexOf('<script>') + 8, fixture.indexOf('</script>'));
  const from = script.indexOf('[', script.indexOf(`const ${name} = `));
  assert.ok(from > 0, `array ${name} não encontrado na fixture`);

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < script.length; i += 1) {
    const char = script[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(script.slice(from, i + 1));
    }
  }
  throw new Error(`array ${name} incompleto na fixture`);
}

const originalSessions = readArray('sessions');
const originalSyllabus = readArray('syllabus');

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Texto visível do documento, com espaço entre elementos de bloco para não
 * grudar palavras de parágrafos vizinhos.
 */
function visibleText(document) {
  const BLOCK = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'li', 'ul', 'ol', 'div', 'section', 'header', 'main',
    'footer', 'button', 'option', 'summary', 'label', 'details', 'table', 'tr', 'td', 'th', 'br',
  ]);

  const walk = (node) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
    const inner = [...node.childNodes].map(walk).join(' ');
    return BLOCK.has(tag) ? ` ${inner} ` : inner;
  };

  return normalize(walk(document.body));
}

function words(text) {
  return (text.match(/[\p{L}\p{N}ºª§°]+/gu) || []).map((word) => word.toLowerCase());
}

test('fixture contém o plano completo da versão 2', () => {
  assert.equal(originalSessions.length, 139);
  assert.equal(originalSyllabus.length, 11);
  assert.equal(originalSessions[0].date, '2026-10-26');
  assert.equal(originalSessions.at(-1).date, '2027-03-13');
});

test('data/plan.json reproduz exatamente as 139 sessões do original', () => {
  assert.equal(plan.sessions.length, originalSessions.length);

  const divergencias = [];
  originalSessions.forEach((original, index) => {
    const atual = plan.sessions[index];
    assert.ok(atual, `sessão ${index} ausente`);
    for (const field of FIELDS) {
      if (original[field] !== atual[field]) {
        divergencias.push({ date: original.date, field, original: original[field], atual: atual[field] });
      }
    }
  });

  assert.deepEqual(divergencias, [], 'campos divergentes em relação ao plano original');
});

test('data/plan.json reproduz exatamente o checklist do Anexo VIII', () => {
  assert.equal(plan.syllabus.length, originalSyllabus.length);
  originalSyllabus.forEach((original, index) => {
    assert.deepEqual(plan.syllabus[index], original, `grupo ${index} do checklist divergente`);
  });
});

test('resumo do plano preserva semanas, fases e sessões do núcleo do cargo', () => {
  const countBy = (list, key) => {
    const map = new Map();
    list.forEach((item) => map.set(item[key], (map.get(item[key]) || 0) + 1));
    return [...map].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };

  assert.deepEqual(countBy(plan.sessions, 'week'), countBy(originalSessions, 'week'));
  assert.deepEqual(
    [...new Set(plan.sessions.map((session) => session.phase))],
    [...new Set(originalSessions.map((session) => session.phase))]
  );
  assert.equal(plan.sessions.filter((session) => session.task.includes('★')).length, 21);
});

test('todo o texto fixo do original existe na página nova', () => {
  const original = new JSDOM(fixture).window.document;
  const atual = new JSDOM(html).window.document;

  // Conteúdo gerado por JS (calendário, checklist, barra de progresso e status)
  // é comparado pelos dados nos testes acima e pela renderização no teste final.
  original.querySelectorAll('script, #schedule, #syllabus, #progressText').forEach((node) => node.remove());
  atual
    .querySelectorAll('script, #schedule, #syllabus, #progressText, #banner, #syncStatus, #storageBadge, noscript')
    .forEach((node) => node.remove());

  const originalWords = new Set(words(visibleText(original)));
  const atualWords = new Set(words(visibleText(atual)));
  const faltando = [...originalWords].filter((word) => !atualWords.has(word));

  assert.deepEqual(faltando, [], 'palavras do texto original que desapareceram da página');
});

test('CSS do original continua no topo de public/styles.css', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const originalCss = fixture.slice(fixture.indexOf('<style>') + 7, fixture.indexOf('</style>')).trim();

  assert.ok(css.startsWith(originalCss), 'o CSS original deve ser preservado (prefixo de styles.css)');
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, 'chaves desbalanceadas');
});

test('a tela renderizada mostra cada sessão do original', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  window.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(
        String(url).includes('health')
          ? { ok: true, storage: 'postgres' }
          : {
              plan: { id: plan.planId, title: plan.title, subtitle: plan.subtitle },
              sessions: plan.sessions.map((session) => ({ ...session, completed: false, completedAt: null })),
              syllabus: plan.syllabus,
              summary: { total: plan.sessions.length, completed: 0, pending: plan.sessions.length, percent: 0, lastCompletedAt: null },
              storage: 'postgres',
            }
      ),
  });
  window.eval(appCode);

  for (let i = 0; i < 200 && window.document.querySelectorAll('#schedule .day').length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const cards = [...window.document.querySelectorAll('#schedule .day')];
  assert.equal(cards.length, originalSessions.length);

  const byDate = new Map(cards.map((card) => [card.dataset.date, card]));
  const problemas = [];

  for (const original of originalSessions) {
    const card = byDate.get(original.date);
    if (!card) {
      problemas.push(`${original.date}: cartão não renderizado`);
      continue;
    }
    if (card.querySelector('h3').textContent !== original.subject) problemas.push(`${original.date}: matéria`);
    if (card.querySelector('.date').textContent !== `${original.weekday} • ${original.display}`) {
      problemas.push(`${original.date}: data/dia da semana`);
    }
    if (card.querySelector('.task').textContent !== original.task) problemas.push(`${original.date}: tarefa`);
    if (card.querySelector('.tag').textContent !== '60 min') problemas.push(`${original.date}: duração`);
    if (!card.querySelector('.complete').textContent.includes('Sessão concluída')) {
      problemas.push(`${original.date}: rótulo do checkbox`);
    }
  }

  assert.deepEqual(problemas, []);

  const syllabusText = normalize(window.document.getElementById('syllabus').textContent);
  const checklistAusente = originalSyllabus.flatMap((group) => [group.title, ...group.items]).filter(
    (item) => !syllabusText.includes(item)
  );
  assert.deepEqual(checklistAusente, [], 'itens do checklist ausentes na tela');

  assert.equal(window.document.querySelectorAll('#schedule .week').length, 20);
});
