// Carregador mínimo de .env (sem dependências).
// Variáveis já definidas no ambiente (ex.: Render) têm prioridade sobre o arquivo.

import fs from 'node:fs';

export function loadEnvFile(file, env = process.env) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (env[key] === undefined) env[key] = value;
  }

  return env;
}
