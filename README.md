# Plano de Estudos TJSP — Oficial de Justiça

Aplicação web do plano diário de estudos para o concurso de **Oficial de Justiça do TJSP (VUNESP)** — 139 sessões de 26/10/2026 a 13/03/2027, com checklist do Anexo VIII do edital.

O progresso agora fica **no banco de dados (PostgreSQL/Neon)**, e não mais no navegador: marque uma sessão no celular e ela aparece concluída no computador. O app está pronto para rodar no **Render**.

## O que tem

- Calendário completo de 139 sessões, agrupado por semana, com busca por matéria/artigo e filtros por fase e status.
- Checklist de cobertura do conteúdo programático (Anexo VIII).
- Marcação de sessões concluídas salva no PostgreSQL, com atualização otimista e reenvio automático se a conexão cair.
- Exportar/importar progresso em JSON e migração automática das marcações antigas do navegador.
- Layout responsivo com folha de estilo própria para impressão/salvar em PDF.
- Sem framework, sem etapa de build: Node.js + Express + `pg`, HTML/CSS/JS servidos pelo próprio servidor.

## Estrutura

```
.
├── data/plan.json        # conteúdo do plano (139 sessões + checklist) — fonte da verdade
├── public/               # front-end estático
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/
│   ├── index.js          # bootstrap: env, banco, servidor, shutdown
│   ├── app.js            # rotas HTTP e arquivos estáticos
│   ├── db.js             # pool do Postgres, SSL e espera pelo Neon
│   ├── store.js          # PostgresStore (Neon) e FileStore (fallback local)
│   └── env.js            # leitura opcional do .env
├── scripts/db-check.js   # diagnóstico da conexão (npm run db:check)
├── test/                 # testes com pg-mem, HTTP e jsdom
├── render.yaml           # Blueprint do Render
└── .env.example
```

## 1. Banco no Neon

1. Crie uma conta em <https://neon.com> e um projeto (Postgres). Escolha a região mais próxima de você.
2. No painel do projeto, clique em **Connect** e selecione **Pooled connection**.
3. Copie a string, que se parece com:

   ```
   postgresql://usuario:senha@ep-verde-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

   Mantenha o `?sslmode=require`. Se a senha tiver caracteres especiais (`@`, `#`, `/`…), use a versão URL-encoded (o painel do Neon já oferece a string pronta).

4. **Não é preciso rodar SQL.** Na primeira subida, o servidor cria as tabelas `plans` e `study_sessions` e grava as 139 sessões. O seed é idempotente: reiniciar o serviço atualiza o conteúdo do plano sem apagar marcações.

Para conferir a conexão antes do deploy, coloque a string em um `.env` local e rode:

```bash
npm install
npm run db:check
```

## 2. Deploy no Render

O repositório já traz o `render.yaml`. Serviço: Node, plano free, região Ohio (a mais próxima do Brasil), build `npm ci --omit=dev`, start `npm start`, health check em `/healthz`.

### Opção A — Blueprint (recomendado)

1. Envie o repositório para o GitHub.
2. No Render: **New +** → **Blueprint** → conecte o repositório.
3. O Render lê o `render.yaml` e pede o valor de `DATABASE_URL` (marcado com `sync: false`; nada de segredo fica no Git). Cole a connection string do Neon.
4. **Apply** e aguarde o build. Quando o log mostrar `[db] schema pronto: 139 sessões sincronizadas`, abra a URL do serviço.
5. O selo abaixo da barra de progresso deve mostrar **PostgreSQL (Neon)**.

### Opção B — Web Service manual

1. **New +** → **Web Service** → selecione o repositório.
2. Runtime **Node**, Branch `main`, Build Command `npm ci --omit=dev`, Start Command `npm start`.
3. Em **Environment**, adicione:
   - `DATABASE_URL` = connection string do Neon (tipo *Secret*);
   - `NODE_VERSION` = `22`;
   - `PGPOOL_MAX` = `5` (opcional);
   - `BASIC_AUTH_PASSWORD` = uma senha sua (opcional, veja abaixo).
4. Em **Advanced**, defina **Health Check Path** = `/healthz`.
5. **Create Web Service**.

### Detalhes do plano free

- O serviço hiberna após 15 minutos sem acesso; a primeira visita depois disso pode levar até ~1 minuto.
- O Neon também suspende o compute após alguns minutos de inatividade e acorda em cerca de 1 segundo — por isso o `/healthz` não consulta o banco.
- Em caso de erro de conexão no boot, o app tenta 8 vezes com backoff antes de sair; o log mostra cada tentativa.
- Para um serviço sempre ativo, troque `plan: free` por `starter` no `render.yaml`.

### Proteger o acesso (recomendado)

A URL do Render é pública e o app não tem tela de login. Defina `BASIC_AUTH_PASSWORD` (e, se quiser, `BASIC_AUTH_USER`, padrão `estudos`) nas variáveis de ambiente: o navegador passa a pedir usuário e senha. O `/healthz` continua aberto para o health check do Render.

## 3. Rodando localmente

```bash
npm install
cp .env.example .env     # preencha DATABASE_URL (ou deixe vazio para usar arquivo local)
npm run dev              # http://localhost:3000
```

- Sem `DATABASE_URL`, o app grava em `data/progress.local.json` (ignorado pelo Git) e o selo mostra **arquivo local**. No Render esse disco é efêmero: sem banco configurado, o progresso se perde a cada deploy.
- `SKIP_DATABASE=true` força o modo arquivo mesmo com `DATABASE_URL` definida.
- `npm run db:check` testa a conexão com o Neon e mostra quantas sessões já foram concluídas.

### Variáveis de ambiente

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `DATABASE_URL` | — | Connection string do Postgres (Neon). Também aceita `NEON_DATABASE_URL`/`POSTGRES_URL`. |
| `PORT` | `3000` | Porta HTTP (o Render injeta automaticamente). |
| `PGPOOL_MAX` | `5` | Máximo de conexões no pool. |
| `SKIP_DATABASE` | — | `true` ignora o banco e usa `data/progress.local.json`. |
| `BASIC_AUTH_USER` | `estudos` | Usuário do Basic Auth (só é usado se a senha existir). |
| `BASIC_AUTH_PASSWORD` | — | Define a senha e ativa a proteção do site. |
| `PGSSLMODE` | — | `disable` desativa SSL (útil só em Postgres local). |

## Como o progresso é salvo

Tabelas criadas automaticamente no boot:

```sql
plans (id, title, subtitle, syllabus jsonb, created_at, updated_at)

study_sessions (
  plan_id, session_date, display_date, weekday, week, phase, subject, task,
  completed_at timestamptz,
  PRIMARY KEY (plan_id, session_date)
)
```

- Uma sessão concluída é uma linha com `completed_at` preenchido.
- O conteúdo do plano (`task`, `subject`, `phase`…) é sincronizado a partir de `data/plan.json` em todo boot; datas que saíram do arquivo são removidas do banco.
- Marcar duas vezes não altera o horário original da conclusão (`COALESCE`).
- Na primeira carga, se o banco estiver vazio, o app importa automaticamente as marcações antigas da chave `tjsp_oficial_justica_plano_2026_v2` do `localStorage` e marca a migração como feita.
- "Exportar progresso" gera um JSON com a lista `concluidas`; "Importar progresso" **substitui** o progresso atual por essa lista (datas fora do plano são ignoradas e contabilizadas).
- Se a conexão falhar ao marcar, a alteração fica em fila no navegador e é reenviada ao voltar a conexão (a cada 30 s e no evento `online`).

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness sem acesso ao banco (usada pelo Render). |
| `GET` | `/api/health` | Status do banco, versão do Postgres e duração da consulta. |
| `GET` | `/api/plan` | Plano completo: sessões com `completed`, checklist e resumo. |
| `PUT` | `/api/sessions/:date` | Corpo `{"completed": true|false}`; data no formato `AAAA-MM-DD`. |
| `DELETE` | `/api/progress` | Zera todas as marcações. |
| `POST` | `/api/progress/import` | Corpo `{"dates": ["AAAA-MM-DD", …]}`; substitui o progresso. |

Exemplos:

```bash
curl -s http://localhost:3000/api/health | jq
curl -s -X PUT http://localhost:3000/api/sessions/2026-10-26 \
     -H 'Content-Type: application/json' -d '{"completed":true}' | jq
curl -s -X DELETE http://localhost:3000/api/progress | jq
```

## Atualizar o conteúdo do plano

Edite `data/plan.json` (campos `date`, `display`, `weekday`, `week`, `phase`, `subject`, `task`). No próximo boot o servidor faz upsert das sessões e remove do banco as datas que não existem mais no arquivo. Marcações das sessões mantidas são preservadas.

## Testes

```bash
npm test        # 34 testes: paridade de conteúdo, store (pg-mem), API HTTP, FileStore e front-end (jsdom)
npm run check   # checagem de sintaxe dos arquivos JS
```

- **Paridade de conteúdo** (`test/content-parity.test.js`): compara `data/plan.json` e a página renderizada com o HTML original guardado em `test/fixtures/plano_original_v2.html` — 139 sessões (data, dia da semana, matéria, tarefa), 11 grupos do checklist, texto fixo e CSS. É a garantia de que nada do plano se perdeu na migração.
- **Postgres** (`test/store.test.js`): `pg-mem`, um Postgres em memória, rodando o mesmo SQL do Neon — seed idempotente, marcação/desmarcação, importação, limpeza de sessões obsoletas e health check. (O SQL também foi validado em PostgreSQL real via PGlite durante o desenvolvimento.)
- **API HTTP** (`test/api.test.js`): rotas, validações, importação, Basic Auth e arquivos estáticos.
- **Front-end** (`test/frontend.test.js`): monta a página real em jsdom e exercita busca, filtros, marcação, erro de rede e migração do `localStorage`.

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| Log `DATABASE_URL não definida` / selo "arquivo local" | Variável ausente no serviço | Adicione `DATABASE_URL` em Environment e faça *Manual Deploy → Clear build cache & deploy*. |
| `password authentication failed` | String errada ou senha não codificada | Copie novamente a string no Neon (Pooled connection) e use a senha URL-encoded. |
| `[db] tentativa 1/8 falhou` repetido no boot | Host/rede/SSL | Confira o host `-pooler`, o `?sslmode=require` e se o projeto do Neon não foi pausado/excluído. |
| Página abre, mas "Não foi possível carregar o plano" | API/DB indisponível | Abra `/api/health`; se retornar 503, o banco não respondeu. Use "Tentar novamente" na página. |
| Progresso zerou após um deploy | Estava sem banco (modo arquivo) | Configure `DATABASE_URL`; importe o backup JSON exportado antes. |
| Primeira visita do dia lenta | Serviço free hibernando + Neon acordando | Normal no plano free. |
| Tabelas não existem | Boot falhou antes do `init` | Veja os logs do Render; rode `npm run db:check` localmente. |
