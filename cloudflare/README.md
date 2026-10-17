# DBD Tracker Community Backend (Cloudflare Worker + D1)

Backend serverless para coleta comunitária anônima e agregação de métricas públicas do Dead by Daylight usando **Cloudflare Workers** e banco de dados **Cloudflare D1 (SQLite)**.

## 🚀 Como Configurar e Fazer Deploy

### 1. Instalar Dependências

```bash
cd cloudflare
npm install
```

### 2. Criar o Banco de Dados D1

```bash
npx wrangler d1 create dbd-tracker-community
```

O comando retornará um bloco de configuração semelhante a:
```jsonc
[[d1_databases]]
binding = "DB"
database_name = "dbd-tracker-community"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copie o `database_id` gerado e cole no arquivo `wrangler.jsonc` no campo `"database_id"`.

### 3. Aplicar o Esquema no D1

- **No ambiente local (para desenvolvimento):**
  ```bash
  npm run d1:init
  ```

- **No ambiente de produção (Cloudflare):**
  ```bash
  npm run d1:init:remote
  ```

### 4. Testar Localmente

```bash
npm run dev
```

O worker responderá em `http://localhost:8787`.

### 5. Fazer Deploy na Cloudflare

```bash
npm run deploy
```

O Wrangler exibirá a URL de produção do Worker, por exemplo:
`https://dbd-tracker-community.<seu-subdominio>.workers.dev`

Atualize o arquivo `desktop/community-config.json` com essa URL.

---

## 📡 Endpoints da API

- `GET /api/health`: Verificação de status do serviço.
- `POST /api/auth/session`: Emite ou valida a sessão anônima (`Authorization: Bearer <token>`).
- `POST /api/auth/link-email`: Vincula e-mail para permitir recuperação da conta.
- `POST /api/community-ingest`: Ingestão atômica de lotes de partidas normalizadas via `db.batch()`.
- `GET /api/community-stats`: Estatísticas públicas consolidadas para o Overlay (com Edge Caching de 5 minutos).
- `POST /api/admin/refresh-stats`: Recálculo manual sob demanda das tabelas de estatísticas consolidadas.
- `Cron Trigger (*/30 * * * *)`: Atualiza as tabelas consolidadas automaticamente a cada 30 minutos em background.
