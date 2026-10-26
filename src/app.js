import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import express from 'express';

import { isIsoDate } from './store.js';

const MAX_IMPORT_DATES = 2000;

/** Envolve handlers assíncronos para que erros cheguem ao middleware de erro. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeEqual(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Proteção opcional por Basic Auth. Basta definir BASIC_AUTH_PASSWORD no
 * ambiente para que a URL pública do Render peça usuário e senha.
 */
function basicAuth({ user, password }) {
  return (req, res, next) => {
    const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator > -1) {
        const givenUser = decoded.slice(0, separator);
        const givenPass = decoded.slice(separator + 1);
        if (safeEqual(givenUser, user) && safeEqual(givenPass, password)) return next();
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Plano de Estudos TJSP", charset="UTF-8"');
    res.status(401).type('text/plain; charset=utf-8').send('Acesso restrito.');
  };
}

export function createApp({ store, plan, publicDir, startedAt = Date.now(), auth = null, log = console }) {
  const app = express();

  app.disable('x-powered-by');
  // O Render termina o TLS no proxy e encaminha X-Forwarded-*.
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Liveness: não toca no banco e fica fora da autenticação, para o health
  // check do Render não falhar enquanto o Neon acorda.
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  // Autenticação antes de ler o corpo da requisição.
  if (auth && auth.password) app.use(basicAuth(auth));

  app.use(express.json({ limit: '256kb' }));

  app.get(
    '/api/health',
    wrap(async (req, res) => {
      try {
        const database = await store.health();
        res.json({
          ok: true,
          storage: store.storage,
          database,
          plan: { id: plan.planId, sessions: plan.sessions.length },
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
      } catch (error) {
        log.error('[api] health check falhou:', error.message);
        res.status(503).json({ ok: false, storage: store.storage, error: 'Banco de dados indisponível.' });
      }
    })
  );

  app.get(
    '/api/plan',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await store.getPlanState());
    })
  );

  app.put(
    '/api/sessions/:date',
    wrap(async (req, res) => {
      const { date } = req.params;
      if (!isIsoDate(date)) throw httpError(400, 'Data inválida. Use o formato AAAA-MM-DD.');

      const { completed } = req.body ?? {};
      if (typeof completed !== 'boolean') {
        throw httpError(400, 'Envie o corpo {"completed": true} ou {"completed": false}.');
      }

      const session = await store.setSession(date, completed);
      if (!session) throw httpError(404, 'Essa data não faz parte do plano de estudos.');

      const state = await store.getPlanState();
      res.json({ ...session, summary: state.summary });
    })
  );

  app.delete(
    '/api/progress',
    wrap(async (req, res) => {
      const cleared = await store.clearProgress();
      const state = await store.getPlanState();
      res.json({ cleared, summary: state.summary });
    })
  );

  app.post(
    '/api/progress/import',
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const source = Array.isArray(body.dates) ? body.dates : body.concluidas;

      if (!Array.isArray(source)) {
        throw httpError(400, 'Envie {"dates": ["AAAA-MM-DD", ...]} com as sessões concluídas.');
      }
      if (source.length > MAX_IMPORT_DATES) {
        throw httpError(413, `Importação limitada a ${MAX_IMPORT_DATES} datas.`);
      }

      const dates = [...new Set(source.filter((value) => typeof value === 'string' && isIsoDate(value)))];
      const result = await store.importProgress(dates);
      const state = await store.getPlanState();

      res.json({
        ...result,
        // Datas válidas que não existem no plano (ex.: backup de outra versão).
        ignored: source.length - dates.length + result.ignored,
        summary: state.summary,
      });
    })
  );

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint não encontrado.' });
  });

  const indexFile = path.join(publicDir, 'index.html');

  app.use(
    express.static(publicDir, {
      index: false,
      etag: true,
      setHeaders(res, filePath) {
        // Revalidação sempre: um deploy novo aparece sem precisar limpar o cache.
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.get('/', (req, res) => res.sendFile(indexFile));

  app.use((req, res) => {
    res.status(404).type('text/plain; charset=utf-8').send('Página não encontrada.');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = error.status || 500;
    if (status >= 500) log.error('[api] erro:', error);

    // JSON malformado vindo do express.json()
    const message =
      error.type === 'entity.parse.failed'
        ? 'JSON inválido no corpo da requisição.'
        : status >= 500
          ? 'Erro interno no servidor.'
          : error.message;

    if (res.headersSent) return;
    res.status(status).json({ error: message });
  });

  return app;
}
