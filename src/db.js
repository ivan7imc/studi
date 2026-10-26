import pg from 'pg';

/**
 * Colunas do tipo DATE devem chegar como "AAAA-MM-DD" (string), nunca como Date.
 * Sem isso o driver converte para meia-noite no fuso local e o dia pode mudar.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

const DEFAULT_POOL_MAX = 5;

/** Nomes de variável aceitos, em ordem de prioridade. O Render injeta DATABASE_URL. */
const CONNECTION_ENV_KEYS = ['DATABASE_URL', 'NEON_DATABASE_URL', 'POSTGRES_URL'];

/**
 * Lê a string de conexão do ambiente. No Render, basta apontar `DATABASE_URL`
 * para a connection string do Neon (a "Pooled connection" é a recomendada).
 */
export function resolveConnectionString(env = process.env) {
  for (const key of CONNECTION_ENV_KEYS) {
    const value = (env[key] || '').trim();
    if (value) return { connectionString: value, source: key };
  }
  return { connectionString: '', source: null };
}

/** `?sslmode=disable` é usado apenas em desenvolvimento local com Postgres sem TLS. */
export function shouldUseSsl(connectionString, env = process.env) {
  if (env.PGSSLMODE === 'disable') return false;
  return !/[?&]sslmode=disable(&|$)/i.test(connectionString);
}

/**
 * Cria o pool de conexões. `rejectUnauthorized: false` é o padrão recomendado
 * para Postgres gerenciado (Neon, Render, Supabase): o tráfego continua
 * criptografado, sem exigir a CA local.
 */
export function createPool(connectionString, env = process.env) {
  const max = Number.parseInt(env.PGPOOL_MAX || '', 10);

  const pool = new pg.Pool({
    connectionString,
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: shouldUseSsl(connectionString, env) ? { rejectUnauthorized: false } : false,
  });

  // Um pool nunca deve derrubar o processo por erro em conexão ociosa.
  pool.on('error', (error) => {
    console.error('[db] erro em conexão ociosa:', error.message);
  });

  return pool;
}

/**
 * O Neon pode estar acordando (scale to zero) ou o deploy pode subir antes da
 * rede. Tentamos algumas vezes antes de desistir.
 */
export async function waitForDatabase(pool, { attempts = 8, delayMs = 1500, log = console } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (error) {
      lastError = error;
      log.warn(`[db] tentativa ${attempt}/${attempts} falhou: ${error.message}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}
