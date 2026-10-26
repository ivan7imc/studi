import fs from 'node:fs/promises';
import path from 'node:path';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Converte o valor devolvido pelo driver em "AAAA-MM-DD".
 * O pool de produção já devolve string (type parser em db.js); a normalização
 * existe para tolerar drivers/adaptadores que devolvem Date (testes).
 */
export function toIsoDate(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

/** Valida "AAAA-MM-DD" e rejeita datas impossíveis (ex.: 2026-02-31). */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function summarize(sessions) {
  const total = sessions.length;
  const completed = sessions.filter((session) => Boolean(session.completed)).length;
  const completedDates = sessions
    .filter((session) => session.completedAt)
    .map((session) => session.completedAt)
    .sort();
  return {
    total,
    completed,
    pending: total - completed,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    lastCompletedAt: completedDates.length ? completedDates[completedDates.length - 1] : null,
  };
}

function buildPlanState({ plan, rows, storage }) {
  const syllabus = Array.isArray(plan.syllabus) ? plan.syllabus : [];
  const sessions = rows
    .map((row) => ({
      date: toIsoDate(row.date),
      display: row.display,
      weekday: row.weekday,
      week: Number(row.week),
      phase: row.phase,
      subject: row.subject,
      task: row.task,
      completed: Boolean(row.completed_at ?? row.completedAt ?? row.completed),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    plan: { id: plan.planId, title: plan.title, subtitle: plan.subtitle },
    sessions,
    syllabus,
    summary: summarize(sessions),
    storage,
  };
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignora falha no rollback para preservar o erro original */
    }
    throw error;
  } finally {
    client.release();
  }
}

const PLAN_SELECT = `
  SELECT session_date AS date, display_date AS display, weekday, week, phase, subject, task, completed_at
    FROM study_sessions
   WHERE plan_id = $1
   ORDER BY session_date
`;

/**
 * Armazenamento principal: PostgreSQL (Neon no Render).
 * O conteúdo do plano é semeado a cada boot (idempotente); o progresso do
 * usuário vive em `study_sessions.completed_at` e nunca é sobrescrito pelo seed.
 */
export class PostgresStore {
  constructor({ pool, plan, log = console }) {
    this.pool = pool;
    this.plan = plan;
    this.log = log;
  }

  get storage() {
    return 'postgres';
  }

  /** Cria o schema e sincroniza o conteúdo do plano. Seguro para rodar em todo deploy. */
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id         text PRIMARY KEY,
        title      text NOT NULL,
        subtitle   text NOT NULL DEFAULT '',
        syllabus   jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS study_sessions (
        plan_id      text NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
        session_date date NOT NULL,
        display_date text NOT NULL,
        weekday      text NOT NULL,
        week         integer NOT NULL,
        phase        text NOT NULL,
        subject      text NOT NULL,
        task         text NOT NULL,
        completed_at timestamptz,
        PRIMARY KEY (plan_id, session_date)
      )
    `);

    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS study_sessions_week_idx ON study_sessions (plan_id, week, session_date)'
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS study_sessions_completed_idx ON study_sessions (plan_id, completed_at)'
    );

    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO plans (id, title, subtitle, syllabus)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET title = EXCLUDED.title,
               subtitle = EXCLUDED.subtitle,
               syllabus = EXCLUDED.syllabus,
               updated_at = now()`,
        [this.plan.planId, this.plan.title, this.plan.subtitle, JSON.stringify(this.plan.syllabus || [])]
      );

      // Upsert do calendário em um único comando (139 linhas x 7 parâmetros).
      const columns = ['session_date', 'display_date', 'weekday', 'week', 'phase', 'subject', 'task'];
      const params = [this.plan.planId];
      const rows = this.plan.sessions.map((session) => {
        const values = [
          session.date,
          session.display,
          session.weekday,
          session.week,
          session.phase,
          session.subject,
          session.task,
        ];
        const placeholders = values.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `($1, ${placeholders.join(', ')})`;
      });

      await client.query(
        `INSERT INTO study_sessions (plan_id, ${columns.join(', ')})
         VALUES ${rows.join(', ')}
         ON CONFLICT (plan_id, session_date) DO UPDATE
           SET display_date = EXCLUDED.display_date,
               weekday = EXCLUDED.weekday,
               week = EXCLUDED.week,
               phase = EXCLUDED.phase,
               subject = EXCLUDED.subject,
               task = EXCLUDED.task`,
        params
      );

      // Remove sessões que saíram do plano (mantém o banco fiel ao data/plan.json).
      const existing = await client.query('SELECT session_date AS date FROM study_sessions WHERE plan_id = $1', [
        this.plan.planId,
      ]);
      const keep = new Set(this.plan.sessions.map((session) => session.date));
      const stale = existing.rows.map((row) => toIsoDate(row.date)).filter((date) => !keep.has(date));

      if (stale.length) {
        const placeholders = stale.map((_, index) => `$${index + 2}::date`).join(', ');
        await client.query(
          `DELETE FROM study_sessions WHERE plan_id = $1 AND session_date IN (${placeholders})`,
          [this.plan.planId, ...stale]
        );
      }

      return { sessions: this.plan.sessions.length, removed: stale.length };
    });
  }

  async getPlanState() {
    const { rows } = await this.pool.query(PLAN_SELECT, [this.plan.planId]);
    return buildPlanState({ plan: this.plan, rows, storage: this.storage });
  }

  /** Marca/desmarca uma sessão. Devolve null quando a data não existe no plano. */
  async setSession(date, completed) {
    const { rows, rowCount } = await this.pool.query(
      `UPDATE study_sessions
          SET completed_at = CASE
                WHEN $3::boolean THEN COALESCE(completed_at, now())
                ELSE NULL
              END
        WHERE plan_id = $1 AND session_date = $2::date
        RETURNING session_date AS date, completed_at`,
      [this.plan.planId, date, completed]
    );

    if (rowCount === 0) return null;

    return {
      date: toIsoDate(rows[0].date),
      completed,
      completedAt: rows[0].completed_at ? new Date(rows[0].completed_at).toISOString() : null,
    };
  }

  /** Zera todas as marcações do plano e devolve quantas foram apagadas. */
  async clearProgress() {
    const result = await this.pool.query(
      'UPDATE study_sessions SET completed_at = NULL WHERE plan_id = $1 AND completed_at IS NOT NULL',
      [this.plan.planId]
    );
    return result.rowCount;
  }

  /** Substitui o progresso pela lista informada (usado na importação de backup). */
  async importProgress(dates) {
    const requested = [...new Set(dates)];
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT session_date AS date FROM study_sessions WHERE plan_id = $1', [
        this.plan.planId,
      ]);
      const known = new Set(existing.rows.map((row) => toIsoDate(row.date)));
      const accepted = requested.filter((date) => known.has(date));

      await client.query(
        'UPDATE study_sessions SET completed_at = NULL WHERE plan_id = $1 AND completed_at IS NOT NULL',
        [this.plan.planId]
      );

      if (accepted.length) {
        const placeholders = accepted.map((_, index) => `$${index + 2}::date`).join(', ');
        await client.query(
          `UPDATE study_sessions SET completed_at = now()
            WHERE plan_id = $1 AND session_date IN (${placeholders})`,
          [this.plan.planId, ...accepted]
        );
      }

      return { imported: accepted.length, ignored: requested.length - accepted.length };
    });
  }

  async health() {
    const startedAt = process.hrtime.bigint();
    const { rows } = await this.pool.query('SELECT version() AS version');
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return {
      ok: true,
      latencyMs: Math.round(latencyMs),
      server: String(rows[0]?.version || '').split(' ').slice(0, 2).join(' ') || 'PostgreSQL',
    };
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * Fallback para rodar localmente sem banco (ou num deploy sem DATABASE_URL).
 * Grava em um JSON dentro de `dataDir` — no Render esse disco é efêmero.
 */
export class FileStore {
  constructor({ plan, dataDir, log = console }) {
    this.plan = plan;
    this.file = path.join(dataDir, 'progress.local.json');
    this.log = log;
    this.state = {};
    this.writeQueue = Promise.resolve();
  }

  get storage() {
    return 'file';
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') this.log.warn(`[store] não foi possível ler ${this.file}: ${error.message}`);
      this.state = {};
    }
    return { sessions: this.plan.sessions.length, removed: 0 };
  }

  #progress() {
    const stored = this.state[this.plan.planId];
    return stored && typeof stored === 'object' ? stored : {};
  }

  async #persist() {
    const payload = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, payload, 'utf8');
      await fs.rename(temp, this.file);
    });
    return this.writeQueue;
  }

  async getPlanState() {
    const progress = this.#progress();
    const rows = this.plan.sessions.map((session) => ({
      ...session,
      date: session.date,
      completed_at: progress[session.date] || null,
    }));
    return buildPlanState({ plan: this.plan, rows, storage: this.storage });
  }

  async setSession(date, completed) {
    const session = this.plan.sessions.find((item) => item.date === date);
    if (!session) return null;

    const progress = this.#progress();
    const completedAt = completed ? progress[date] || new Date().toISOString() : null;
    if (completedAt) progress[date] = completedAt;
    else delete progress[date];

    this.state[this.plan.planId] = progress;
    await this.#persist();
    return { date, completed, completedAt };
  }

  async clearProgress() {
    const progress = this.#progress();
    const cleared = Object.keys(progress).length;
    this.state[this.plan.planId] = {};
    await this.#persist();
    return cleared;
  }

  async importProgress(dates) {
    const requested = [...new Set(dates)];
    const known = new Set(this.plan.sessions.map((session) => session.date));
    const accepted = requested.filter((date) => known.has(date));
    const progress = Object.fromEntries(accepted.map((date) => [date, new Date().toISOString()]));
    this.state[this.plan.planId] = progress;
    await this.#persist();
    return { imported: accepted.length, ignored: requested.length - accepted.length };
  }

  async health() {
    return { ok: true, latencyMs: 0, server: 'arquivo local (sem banco de dados)' };
  }

  async close() {}
}
