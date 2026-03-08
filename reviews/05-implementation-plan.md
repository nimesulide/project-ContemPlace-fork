# Phase 1 Implementation Plan

> Scope: working Telegram capture loop on Cloudflare Workers. No MCP server. Done when 5 real messages produce correctly structured notes with confirmations, within 8 seconds each.

> **Pre-implementation review sweep (2026-03-08):** 10 fixes applied — added `raw_input` column and insert param, `ALLOWED_CHAT_IDS` whitelist, removed `package-lock.json` from `.gitignore`, deferred `assets` table to Phase 2, switched confirmation to full body (no checkmark prefix), consolidated env files to `.dev.vars` only, fixed RLS to `using (false)`, added `MATCH_THRESHOLD` validation, added `vitest.config.ts` for `.dev.vars` loading.

**Product intent (from the owner — do not lose sight of this during implementation):**
An always-on place to capture unedited thoughts via low-friction interfaces (Telegram first, more channels later). Store fast, structure automatically, never ask the user to edit. The stored notes become a semantic context layer: Phase 2 exposes them via MCP so LLM agents can retrieve relevant notes by similarity and act as creative collaborators, review partners, or thinking companions — without the user having to provide context via the prompt. The capture pipeline must be channel-agnostic: adding a new input (Slack, email, voice, web) should mean writing a new entry point, not rewriting the pipeline. Raw input is always preserved — it's the irreplaceable source of truth.

Read this plan top to bottom before starting. Every architectural decision is already made. Do not deviate, do not improvise. If you hit a gap, re-read the relevant review file rather than guessing.

**Key architecture:** Cloudflare Workers (V8/TypeScript/npm), NOT Supabase Edge Functions. Supabase is database only. The Worker returns 200 immediately and processes in `ctx.waitUntil()`. One capture mode (no /fast). Embedding model: `openai/text-embedding-3-small` at 1536 dimensions (default output, no `dimensions` parameter).

---

## Task 1 — Account Setup

Four external accounts must exist before any code is written. All are manual steps.

### 1a — Supabase [USER INPUT REQUIRED]

1. Go to [supabase.com](https://supabase.com) and create a free account.
2. Create a new project. Choose a region close to you. Set a strong database password and save it somewhere safe (you will not need it in code, but you may need it for direct DB access later).
3. After the project provisions (~2 minutes), go to **Project Settings → API**. Note:
   - **Project URL** — format: `https://[project-ref].supabase.co`
   - **service_role secret** — under "Project API keys". This is the key that bypasses RLS. Treat it like a root password. Do not put it in any file that will be committed.
   - **anon public** key — you will not use this in code. Do not use it anywhere.

### 1b — OpenRouter [USER INPUT REQUIRED]

1. Go to [openrouter.ai](https://openrouter.ai) and create an account.
2. Navigate to **Keys** and create a new API key. Copy it immediately — it is only shown once.
3. Navigate to **Credits** and add a small amount (e.g. $5). The models used (Claude Haiku, embedding models) are paid and will not work on the free tier.
4. Set a **spending limit** in your account settings to cap blast radius if the key leaks. $10/month is sufficient.

### 1c — Telegram BotFather [USER INPUT REQUIRED]

1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`. Follow the prompts: choose a name (display name, e.g. "ContemPlace") and a username (must end in `bot`, e.g. `contemplace_bot`).
3. BotFather gives you a bot token in the format `1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ`. Copy it.
4. Send `/setprivacy` to BotFather, select your bot, and set it to **Disable** (the bot needs to receive all messages).

### 1d — Cloudflare [USER INPUT REQUIRED]

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and create a free account (or use an existing one).
2. Install the Wrangler CLI: `npm install -g wrangler` (or use `npx wrangler` throughout).
3. Authenticate: `wrangler login` — this opens a browser for OAuth.
4. After login, note your **Workers subdomain** (visible in the Cloudflare dashboard under Workers & Pages → Overview). Your worker will be at `https://contemplace.YOUR_SUBDOMAIN.workers.dev`.

**Verify before moving on:** You have four things: a Supabase project URL + service role key, an OpenRouter API key with credits, a Telegram bot token, and a Cloudflare account with Wrangler authenticated. Write them nowhere yet.

---

## Task 2 — Repository Structure

Create the project directory (if it does not already exist) and initialise git. The `.gitignore` goes first — before any other file.

```
contemplace/
├── .gitignore
├── .gitleaks.toml
├── .dev.vars.example
├── vitest.config.ts
├── scripts/
│   └── install-hooks.sh
├── supabase/
│   ├── config.toml
│   └── migrations/
│       └── 20260101000000_initial_schema.sql
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types.ts
│   ├── telegram.ts
│   ├── embed.ts
│   ├── db.ts
│   └── capture.ts
├── tests/
│   └── smoke.test.ts
├── wrangler.toml
├── package.json
└── tsconfig.json
```

### 2a — `.gitignore`

Create this file first. Adapted from `reviews/02-security.md` with Cloudflare-specific entries:

```gitignore
# Environment and secrets
.env
.env.local
.env.*.local
.env.production
.env.staging
.dev.vars
*.pem
*.key
*.p12
*.pfx
secrets.json
secrets.*.json

# Cloudflare
.wrangler/

# Supabase local dev
.supabase/

# Node
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# OS and editor
.DS_Store
.DS_Store?
._*
.Spotlight-V8
.Trashes
Thumbs.db
.vscode/settings.json
.vscode/*.code-workspace
.idea/
*.swp
*.swo
*~

# Test output and coverage
coverage/
.nyc_output/
test-results/

# Build artifacts
dist/
build/
*.js.map

# Logs
*.log
logs/

# Temporary files
*.tmp
*.temp
.cache/

# MCP client configs (Phase 2 — contain API keys)
claude_desktop_config.json
*.mcp.json
```

### 2b — `.dev.vars.example`

Single source of truth for all local/dev/test secrets. Cloudflare Workers use `.dev.vars` for local development secrets (loaded by `wrangler dev`). The `vitest.config.ts` also loads this file for smoke tests.

```dotenv
# Copy to .dev.vars and fill in real values.
# .dev.vars is gitignored — never commit it.

# From BotFather — keep this absolutely secret.
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Random secret for webhook verification.
# Generate with: openssl rand -hex 32
TELEGRAM_WEBHOOK_SECRET=your_webhook_secret_here

# From openrouter.ai — covers all LLM and embedding calls.
OPENROUTER_API_KEY=sk-or-v1-your_openrouter_key_here

# From Supabase dashboard → Project Settings → API.
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Comma-separated Telegram chat IDs allowed to use the bot.
# Leave empty to allow all (not recommended in production).
ALLOWED_CHAT_IDS=your_chat_id_here

# ── Test-only vars (not used by the Worker itself) ──────────
# Deployed Worker URL — only needed for smoke tests.
WORKER_URL=https://contemplace.YOUR_SUBDOMAIN.workers.dev

# Your personal Telegram chat ID — only needed for smoke tests.
# Find it: send a message to your bot, then curl
# https://api.telegram.org/bot{TOKEN}/getUpdates and look at message.chat.id
TELEGRAM_CHAT_ID=your_chat_id_here
```

### 2c — `vitest.config.ts`

Loads `.dev.vars` so smoke tests can read all environment variables from the single source of truth:

```typescript
import { defineConfig } from 'vitest/config';
import { readFileSync, existsSync } from 'fs';

function loadDevVars(): Record<string, string> {
  const path = '.dev.vars';
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    vars[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return vars;
}

export default defineConfig({
  test: {
    env: loadDevVars(),
  },
});
```

### 2d — `wrangler.toml`

```toml
name = "contemplace"
main = "src/index.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
CAPTURE_MODEL = "anthropic/claude-haiku-4-5"
EMBED_MODEL = "openai/text-embedding-3-small"
MATCH_THRESHOLD = "0.65"
```

Non-secret configuration goes in `[vars]`. Secrets go via `wrangler secret put` (Task 4).

### 2e — `package.json`

```json
{
  "name": "contemplace",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run tests/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "openai": "^4",
    "@supabase/supabase-js": "^2"
  },
  "devDependencies": {
    "wrangler": "^3",
    "@cloudflare/workers-types": "^4",
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

### 2f — `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### 2g — `.gitleaks.toml`

```toml
title = "ContemPlace gitleaks config"

[extend]
useDefault = true
```

### 2h — `scripts/install-hooks.sh`

```bash
#!/usr/bin/env bash
set -e
command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks not found. Install with: brew install gitleaks"; exit 1; }

HOOK=".git/hooks/pre-commit"
cat > "$HOOK" << 'HOOKEOF'
#!/usr/bin/env bash
gitleaks protect --staged --verbose
HOOKEOF
chmod +x "$HOOK"
echo "Pre-commit hook installed."
```

Make it executable: `chmod +x scripts/install-hooks.sh`.

### 2i — Supabase CLI init

Install the Supabase CLI if not present: `brew install supabase/tap/supabase`

Run in the repo root:

```bash
supabase init
```

This generates `supabase/config.toml`. Verify it contains no keys. Link to your cloud project:

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

### 2j — Install dependencies and first commit

```bash
npm install
git init
git add .gitignore .dev.vars.example .gitleaks.toml scripts/ \
  wrangler.toml package.json package-lock.json tsconfig.json vitest.config.ts supabase/config.toml
git commit -m "chore: repo scaffold — gitignore, wrangler config, package.json, tsconfig"
```

**Verify:** `git log --all -p | grep -iE "(key|token|secret|password|bearer)"` returns nothing.

---

## Task 3 — Schema Deployment

**File to create:** `supabase/migrations/20260101000000_initial_schema.sql`

Use the corrected schema from `reviews/04-schema.md` verbatim. All `vector()` dimensions are already 1536 in that schema. The file must contain, in order:

1. `create extension if not exists vector;`
2. `notes` table with `raw_input` column, `archived_at` column, `embedding vector(1536)`
3. Five indexes on `notes`: `notes_embedding_idx` (partial HNSW, `ef_construction=128`), `notes_tags_idx`, `notes_created_idx`, `notes_active_idx`, `notes_null_embedding_idx`
4. `links` table with `unique(from_id, to_id, link_type)` constraint
5. `links_to_id_idx` index
6. `processed_updates` table with `bigint primary key`
7. RLS `enable` on all three tables (`notes`, `links`, `processed_updates`)
8. Three RLS policies (`for all using (false)`) — deny all non-service access
9. `update_updated_at()` function and `notes_updated_at` trigger
10. `match_notes()` function with `query_embedding vector(1536)`, null-embedding guard, and `archived_at IS NULL` filter

Here is the full SQL:

```sql
-- Enable pgvector
create extension if not exists vector;

-- ============================================================
-- NOTES
-- ============================================================
create table notes (
  id          uuid        primary key default gen_random_uuid(),
  title       text        not null,
  body        text        not null,
  raw_input   text        not null,              -- user's original message, never discarded
  type        text        not null check (type in ('idea', 'reflection', 'source', 'lookup')),
  tags        text[]      not null default '{}',
  source_ref  text,
  source      text        not null default 'telegram',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  embedding   vector(1536)
);

create index notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;

create index notes_tags_idx on notes using gin (tags);
create index notes_created_idx on notes (created_at desc);

create index notes_active_idx on notes (created_at desc)
  where archived_at is null;

create index notes_null_embedding_idx on notes (id)
  where embedding is null and archived_at is null;

-- ============================================================
-- LINKS
-- ============================================================
create table links (
  id         uuid        primary key default gen_random_uuid(),
  from_id    uuid        not null references notes(id) on delete cascade,
  to_id      uuid        not null references notes(id) on delete cascade,
  link_type  text        not null check (link_type in ('extends', 'contradicts', 'supports', 'is-example-of')),
  created_at timestamptz not null default now(),
  unique(from_id, to_id, link_type)
);

create index links_to_id_idx on links (to_id);

-- ASSETS — deferred to Phase 2 (image handling). Add via standalone migration when needed.

-- ============================================================
-- TELEGRAM DEDUPLICATION
-- ============================================================
create table processed_updates (
  update_id    bigint      primary key,
  processed_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
-- RLS is enabled on all tables. Policies use `using (false)` to deny
-- all access via the anon/authenticated roles. The service_role key
-- bypasses RLS entirely (Supabase behavior), so our Worker — which
-- connects with service_role — is unaffected. This is simpler and
-- safer than matching on auth.role(), which can be fragile if JWT
-- claims change or if a policy misconfiguration leaks data.
alter table notes             enable row level security;
alter table links             enable row level security;
alter table processed_updates enable row level security;

create policy "deny all non-service access" on notes             for all using (false);
create policy "deny all non-service access" on links             for all using (false);
create policy "deny all non-service access" on processed_updates for all using (false);

-- ============================================================
-- UPDATED_AT TRIGGER (notes only — links are immutable)
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_updated_at
  before update on notes
  for each row execute function update_updated_at();

-- ============================================================
-- SEMANTIC SEARCH FUNCTION
-- ============================================================
create or replace function match_notes(
  query_embedding  vector(1536),
  match_threshold  float   default 0.5,
  match_count      int     default 10,
  filter_type      text    default null,
  filter_source    text    default null,
  filter_tags      text[]  default null
)
returns table (
  id          uuid,
  title       text,
  body        text,
  type        text,
  tags        text[],
  source_ref  text,
  source      text,
  created_at  timestamptz,
  similarity  float
)
language sql stable as $$
  select
    n.id,
    n.title,
    n.body,
    n.type,
    n.tags,
    n.source_ref,
    n.source,
    n.created_at,
    1 - (n.embedding <=> query_embedding) as similarity
  from notes n
  where
    n.embedding is not null
    and n.archived_at is null
    and 1 - (n.embedding <=> query_embedding) > match_threshold
    and (filter_type   is null or n.type   = filter_type)
    and (filter_source is null or n.source = filter_source)
    and (filter_tags   is null or n.tags   @> filter_tags)
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
```

Deploy:

```bash
supabase db push
```

**If `db push` fails** with a pgvector error, go to Dashboard → Database → Extensions, search for "vector", and enable it. Then re-run.

**Verify:** Supabase dashboard → Table Editor shows all three tables (`notes`, `links`, `processed_updates`). Database → Functions shows `match_notes` and `update_updated_at`.

---

## Task 4 — Secrets Configuration [USER INPUT REQUIRED]

Secrets are set via `wrangler secret put` and are available to the Worker at runtime via the `env` parameter. They are never stored in files that get committed.

Generate the webhook secret:

```bash
openssl rand -hex 32   # use this as TELEGRAM_WEBHOOK_SECRET
```

Set all secrets (each command prompts for the value interactively):

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_CHAT_IDS        # comma-separated chat IDs, e.g. "123456,789012"
```

Note: unlike Supabase Edge Functions, Cloudflare Workers do NOT auto-inject Supabase credentials. Both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must be set explicitly.

Also create a local `.dev.vars` file (gitignored) by copying `.dev.vars.example` and filling in real values. This single file is used by both `wrangler dev` and smoke tests (via `vitest.config.ts`).

**Verify:** `wrangler secret list` shows all six secrets. None of these values appear in any committed file.

---

## Task 5 — Worker Source Code

Create all source files in `src/`. Each file is described below with its full implementation.

### 5a — `src/types.ts`

All TypeScript interfaces. No runtime code.

```typescript
// ── Cloudflare Worker Env ──────────────────────────────────────────────────

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  CAPTURE_MODEL: string;
  EMBED_MODEL: string;
  MATCH_THRESHOLD: string;
  ALLOWED_CHAT_IDS: string;
}

// ── Telegram Types ─────────────────────────────────────────────────────────

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  sticker?: unknown;
  photo?: unknown[];
  audio?: unknown;
  voice?: unknown;
  document?: unknown;
  forward_origin?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: unknown;
  callback_query?: unknown;
}

// ── Note Types ─────────────────────────────────────────────────────────────

export type NoteType = 'idea' | 'reflection' | 'source' | 'lookup';
export type LinkType = 'extends' | 'contradicts' | 'supports' | 'is-example-of';

export interface CaptureLink {
  to_id: string;
  link_type: LinkType;
}

export interface CaptureResult {
  title: string;
  body: string;
  type: NoteType;
  tags: string[];
  source_ref: string | null;
  links: CaptureLink[];
}

export interface MatchedNote {
  id: string;
  title: string;
  body: string;
  type: string;
  tags: string[];
  source_ref: string | null;
  source: string;
  created_at: string;
  similarity: number;
}
```

### 5b — `src/config.ts`

Reads env vars from the `Env` object with defaults. Never reads from `process.env` or `Deno.env`.

```typescript
import type { Env } from './types';

export interface Config {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  openrouterApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  captureModel: string;
  embedModel: string;
  matchThreshold: number;
  allowedChatIds: number[];
}

function parseAndValidateThreshold(value: string | undefined): number {
  const parsed = parseFloat(value || '0.65');
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid MATCH_THRESHOLD: "${value}" — must be a float between 0 and 1`);
  }
  return parsed;
}

export function loadConfig(env: Env): Config {
  return {
    telegramBotToken: requireSecret(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
    telegramWebhookSecret: requireSecret(env.TELEGRAM_WEBHOOK_SECRET, 'TELEGRAM_WEBHOOK_SECRET'),
    openrouterApiKey: requireSecret(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY'),
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey: requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY'),
    captureModel: env.CAPTURE_MODEL || 'anthropic/claude-haiku-4-5',
    embedModel: env.EMBED_MODEL || 'openai/text-embedding-3-small',
    matchThreshold: parseAndValidateThreshold(env.MATCH_THRESHOLD),
    allowedChatIds: (env.ALLOWED_CHAT_IDS || '').split(',').map(Number).filter(Boolean),
  };
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required secret: ${name}`);
  }
  return value;
}
```

### 5c — `src/telegram.ts`

Telegram API helpers. No `parse_mode` — plain text only.

```typescript
import type { Config } from './config';

export async function sendTelegramMessage(
  config: Config,
  chatId: number,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(JSON.stringify({
      event: 'telegram_send_error',
      status: response.status,
      body,
      chatId,
    }));
  }
}

export async function sendTypingAction(
  config: Config,
  chatId: number,
): Promise<void> {
  await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendChatAction`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    },
  );
}
```

### 5d — `src/embed.ts`

Embedding helper. Uses the `openai` npm package pointed at OpenRouter. Does NOT pass a `dimensions` parameter — `text-embedding-3-small` defaults to 1536.

```typescript
import OpenAI from 'openai';
import type { Config } from './config';

export function createOpenAIClient(config: Config): OpenAI {
  return new OpenAI({
    apiKey: config.openrouterApiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/contemplace/contemplace',
      'X-Title': 'ContemPlace',
    },
  });
}

export async function embedText(
  client: OpenAI,
  config: Config,
  text: string,
): Promise<number[]> {
  const response = await client.embeddings.create({
    model: config.embedModel,
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('Embedding API returned no data');
  }
  return embedding;
}
```

### 5e — `src/db.ts`

Supabase client creation and all DB operations.

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { CaptureLink, CaptureResult, MatchedNote } from './types';

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

/**
 * Attempt to insert the update_id. Returns true if this is a new update,
 * false if it's a duplicate (23505 unique violation).
 * Throws on unexpected DB errors.
 */
export async function tryClaimUpdate(
  db: SupabaseClient,
  updateId: number,
): Promise<boolean> {
  const { error } = await db
    .from('processed_updates')
    .insert({ update_id: updateId });

  if (!error) return true;

  if (error.code === '23505') {
    return false; // duplicate — already processed
  }

  // Unexpected error — log but treat as claimable to avoid dropping messages
  console.error(JSON.stringify({
    event: 'dedup_insert_error',
    error: error.message,
    code: error.code,
    update_id: updateId,
  }));
  return true;
}

export async function findRelatedNotes(
  db: SupabaseClient,
  embedding: number[],
  threshold: number,
): Promise<MatchedNote[]> {
  const { data, error } = await db.rpc('match_notes', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: 5,
    filter_type: null,
    filter_source: null,
    filter_tags: null,
  });

  if (error) {
    console.error(JSON.stringify({
      event: 'match_notes_error',
      error: error.message,
    }));
    return [];
  }

  return (data as MatchedNote[]) ?? [];
}

export async function insertNote(
  db: SupabaseClient,
  capture: CaptureResult,
  embedding: number[],
  rawInput: string,
): Promise<string> {
  const { data, error } = await db
    .from('notes')
    .insert({
      title: capture.title,
      body: capture.body,
      raw_input: rawInput,
      type: capture.type,
      tags: capture.tags,
      source_ref: capture.source_ref,
      source: 'telegram',
      embedding: embedding,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Note insert failed: ${error?.message ?? 'no data returned'}`);
  }

  return (data as { id: string }).id;
}

export async function insertLinks(
  db: SupabaseClient,
  noteId: string,
  links: CaptureLink[],
): Promise<void> {
  if (links.length === 0) return;

  const rows = links.map(l => ({
    from_id: noteId,
    to_id: l.to_id,
    link_type: l.link_type,
  }));

  const { error } = await db.from('links').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'links_insert_error',
      error: error.message,
      noteId,
      links: rows,
    }));
  }
}
```

### 5f — `src/capture.ts`

The capture agent: system prompt, LLM call, JSON parsing with type narrowing. The system prompt is the one from the starter brief, with /fast mode references removed.

```typescript
import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult, CaptureLink, MatchedNote, NoteType, LinkType } from './types';

const SYSTEM_PROMPT = `You are a knowledge capture agent following the Evergreen Notes methodology.
Transform raw input into a single, well-formed note and identify its typed relationships to existing notes.

Rules:
- Title must be a claim or insight, not a topic label.
  Good: "Constraints make creative work stronger"
  Bad: "Creativity" or "Note about constraints"
- Body: 2-5 sentences, atomic. Preserve the user's voice and framing.
  Clean up stream-of-consciousness into coherent prose. Do not over-formalize.
- Type: one of idea | reflection | source | lookup
  reflection = first-person, personal insight about creativity or inner life;
               only use when the user's words explicitly signal personal resonance
  lookup = a research/investigation prompt; only if primarily investigative
  source = from an external source with a URL
  idea = everything else (default)
- Tags: 2-5 lowercase strings, no # prefix
- source_ref: URL if the user included one, otherwise null
- Links: for each related note provided, decide if a typed relationship applies.
  Types: extends | contradicts | supports | is-example-of
  Only link when the relationship is conceptually meaningful, not just topically similar.
  It is fine to link to zero notes.
- If the input is genuinely too short to form a useful note, do your best.
  Do not ask for clarification — just capture what is there.

Return valid JSON only. No text outside the JSON object.
{
  "title": "...",
  "body": "...",
  "type": "idea|reflection|source|lookup",
  "tags": ["...", "..."],
  "source_ref": null,
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
  ]
}`;

const VALID_NOTE_TYPES: readonly NoteType[] = ['idea', 'reflection', 'source', 'lookup'];
const VALID_LINK_TYPES: readonly LinkType[] = ['extends', 'contradicts', 'supports', 'is-example-of'];

export async function runCaptureAgent(
  client: OpenAI,
  config: Config,
  text: string,
  relatedNotes: MatchedNote[],
): Promise<CaptureResult> {
  const today = new Date().toISOString().split('T')[0];

  const relatedSection = relatedNotes.length > 0
    ? '\n\nRelated notes for context:\n' +
      relatedNotes.map(n => `[${n.id}] "${n.title}"\n${n.body}`).join('\n\n')
    : '';

  const userMessage = `Today's date: ${today}\n\nCapture this:\n${text}${relatedSection}`;

  const completion = await client.chat.completions.create({
    model: config.captureModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error('LLM returned empty content');
  }

  return parseCaptureResponse(rawContent);
}

function parseCaptureResponse(raw: string): CaptureResult {
  // Strip markdown code fences if the model wraps JSON in them
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`LLM response is not an object: ${cleaned.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['title'] !== 'string') {
    throw new Error('LLM response missing title');
  }
  if (typeof obj['body'] !== 'string') {
    throw new Error('LLM response missing body');
  }
  if (typeof obj['type'] !== 'string') {
    throw new Error('LLM response missing type');
  }
  if (!Array.isArray(obj['tags'])) {
    throw new Error('LLM response missing tags array');
  }

  const noteType: NoteType = VALID_NOTE_TYPES.includes(obj['type'] as NoteType)
    ? (obj['type'] as NoteType)
    : 'idea';

  const links: CaptureLink[] = Array.isArray(obj['links'])
    ? (obj['links'] as unknown[]).filter((l): l is CaptureLink => {
        if (typeof l !== 'object' || l === null) return false;
        const link = l as Record<string, unknown>;
        return (
          typeof link['to_id'] === 'string' &&
          VALID_LINK_TYPES.includes(link['link_type'] as LinkType)
        );
      })
    : [];

  return {
    title: obj['title'] as string,
    body: obj['body'] as string,
    type: noteType,
    tags: (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string'),
    source_ref: typeof obj['source_ref'] === 'string' ? obj['source_ref'] : null,
    links,
  };
}
```

### 5g — `src/index.ts`

The Worker entry point. This is the critical file. The sync path verifies the webhook, parses the body, guards non-text, checks the chat ID whitelist, runs the dedup check, and returns 200. All heavy processing happens in `ctx.waitUntil()`.

```typescript
import type { Env, TelegramUpdate } from './types';
import { loadConfig } from './config';
import { sendTelegramMessage, sendTypingAction } from './telegram';
import { createOpenAIClient, embedText } from './embed';
import { createSupabaseClient, tryClaimUpdate, findRelatedNotes, insertNote, insertLinks } from './db';
import { runCaptureAgent } from './capture';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Only accept POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const config = loadConfig(env);

    // ── 1. Verify webhook secret ──────────────────────────────────────────
    const incomingSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!incomingSecret || incomingSecret !== config.telegramWebhookSecret) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── 2. Parse body ─────────────────────────────────────────────────────
    let update: TelegramUpdate;
    try {
      const raw: unknown = await request.json();
      update = raw as TelegramUpdate;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // ── 3. Guard non-message updates ──────────────────────────────────────
    if (!update.message) {
      return new Response('ok', { status: 200 });
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text ?? message.caption;

    if (!text) {
      // Non-text message (sticker, photo, audio, etc.)
      ctx.waitUntil(
        sendTelegramMessage(config, chatId, 'I can only process text for now. Send a text message.')
      );
      return new Response('ok', { status: 200 });
    }

    // ── 3a. Chat ID whitelist ─────────────────────────────────────────────
    if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chatId)) {
      console.warn(JSON.stringify({
        event: 'unauthorized_chat',
        chatId,
        textPreview: text.slice(0, 50),
      }));
      // Return 200 silently — don't reveal the bot exists to unauthorized users
      return new Response('ok', { status: 200 });
    }

    // ── 4. /start command ─────────────────────────────────────────────────
    if (text.trim() === '/start') {
      ctx.waitUntil(
        sendTelegramMessage(
          config,
          chatId,
          'ContemPlace is running. Send me any text to capture it as a note.',
        )
      );
      return new Response('ok', { status: 200 });
    }

    // ── 5. Dedup check (sync — fast DB call) ──────────────────────────────
    const db = createSupabaseClient(config);
    const isNew = await tryClaimUpdate(db, update.update_id);
    if (!isNew) {
      return new Response('ok', { status: 200 });
    }

    // ── 6. Return 200, process in background ──────────────────────────────
    ctx.waitUntil(processCapture(config, chatId, text, db));
    return new Response('ok', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function processCapture(
  config: ReturnType<typeof loadConfig>,
  chatId: number,
  text: string,
  db: ReturnType<typeof createSupabaseClient>,
): Promise<void> {
  try {
    const openai = createOpenAIClient(config);

    // Embed and send typing indicator concurrently
    const [embedding] = await Promise.all([
      embedText(openai, config, text),
      sendTypingAction(config, chatId),
    ]);

    // Find related notes
    const relatedNotes = await findRelatedNotes(db, embedding, config.matchThreshold);

    // Run capture LLM
    const capture = await runCaptureAgent(openai, config, text, relatedNotes);

    // Insert note (pass original text as raw_input)
    const noteId = await insertNote(db, capture, embedding, text);

    // Insert links
    await insertLinks(db, noteId, capture.links);

    // Build confirmation reply
    let reply = `${capture.title}\n\n${capture.body}`;

    if (capture.links.length > 0) {
      const linkedTitles = capture.links
        .map(l => {
          const matched = relatedNotes.find(n => n.id === l.to_id);
          return matched ? `[[${matched.title}]]` : null;
        })
        .filter((t): t is string => t !== null);

      if (linkedTitles.length > 0) {
        reply += `\n\nLinked to: ${linkedTitles.join(', ')}`;
      }
    }

    await sendTelegramMessage(config, chatId, reply);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      event: 'capture_error',
      error: errorMessage,
      chatId,
      textPreview: text.slice(0, 100),
    }));
    await sendTelegramMessage(
      config,
      chatId,
      `Something went wrong capturing your note.\n\nError: ${errorMessage}\n\nPlease try again.`,
    );
  }
}
```

**Key design points in this file:**

- `loadConfig(env)` is called on every request (Cloudflare Workers don't persist module state across requests the same way Node does). `Config` is a plain object — cheap to create.
- `createSupabaseClient(config)` and `createOpenAIClient(config)` are called inside the handler, not at module scope. The Supabase client is created in the sync path (needed for dedup) and passed to `processCapture`. The OpenAI client is created inside `processCapture` (only needed in the async path).
- The chat ID whitelist check runs after the non-text guard but before the dedup check. Unauthorized users get a silent 200 — the bot does not reveal its existence.
- The dedup check runs **before** returning 200. It's a single fast DB insert (~50ms). If it returns false (duplicate), the Worker returns 200 without spawning any background work.
- All heavy processing (embed, match_notes, LLM, insert, Telegram reply) runs in `ctx.waitUntil()`. The Worker has already returned 200 to Telegram, so there is no retry pressure.
- All errors in the background path send a user-facing Telegram message.

### 5h — Verify the source compiles

```bash
npx tsc --noEmit
```

Must pass with zero errors. If there are type conflicts between `@cloudflare/workers-types` and the `openai` package (e.g. conflicting `fetch` types), add `"skipLibCheck": true` to `tsconfig.json` (already included above).

---

## Task 6 — Deploy Worker

```bash
wrangler deploy
```

After deploy, the Worker URL is:
`https://contemplace.YOUR_SUBDOMAIN.workers.dev`

**Verify the Worker deployed:**

The Cloudflare dashboard → Workers & Pages → `contemplace` should show the Worker as active.

**Verify webhook signature check before registering the webhook:**

```bash
# Must return 403 (no secret header)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://contemplace.YOUR_SUBDOMAIN.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"test": true}'

# Must return 403 (wrong secret)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://contemplace.YOUR_SUBDOMAIN.workers.dev \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: wrong-value" \
  -d '{"test": true}'

# Must return 200 (/start command, valid secret)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://contemplace.YOUR_SUBDOMAIN.workers.dev \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: YOUR_ACTUAL_WEBHOOK_SECRET" \
  -d '{
    "update_id": 999999,
    "message": {
      "message_id": 1,
      "chat": { "id": 123456, "type": "private" },
      "from": { "id": 123456, "is_bot": false, "first_name": "Test" },
      "date": 1700000000,
      "text": "/start"
    }
  }'
```

If the third curl does not return 200, check the Worker logs in the Cloudflare dashboard (Workers & Pages → `contemplace` → Logs). If you see "Missing required secret" errors, verify `wrangler secret list` and re-deploy.

---

## Task 7 — Register Telegram Webhook [USER INPUT REQUIRED]

Only do this after Task 6 is verified. Registering the webhook before the Worker works means Telegram will retry failed deliveries for up to 24 hours.

### 7a — Register webhook

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://contemplace.YOUR_SUBDOMAIN.workers.dev" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\"]"
```

The `allowed_updates=["message"]` tells Telegram to only send `message` updates — not edited messages, callback queries, or channel posts.

Expected response:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### 7b — Verify webhook registration

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Check:
- `url` matches your Workers URL
- `has_custom_certificate` is `false`
- `pending_update_count` is `0`
- `last_error_message` is absent or empty

### 7c — Register /start command

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      { "command": "start", "description": "Show welcome message" }
    ]
  }'
```

Note: only `/start` is registered. There is no `/fast` command in v1.

**Verify [USER INPUT REQUIRED]:** Open Telegram. Send `/start` to your bot. You should receive: "ContemPlace is running. Send me any text to capture it as a note." If no reply arrives within 10 seconds, check the Worker logs in the Cloudflare dashboard.

---

## Task 8 — End-to-End Verification [USER INPUT REQUIRED]

Send these five messages from Telegram to your bot, in order. After each, verify in the Supabase Table Editor that a row was inserted in `notes`.

**Message 1 — Basic capture:**
```
Constraints make creative work stronger because they force deliberate choices instead of infinite optionality.
```
Expected: A note with `type = 'idea'`, non-null `embedding`, non-empty `tags`. Confirmation reply shows the title and full body.

**Message 2 — Source capture:**
```
https://en.wikipedia.org/wiki/Ikigai — Japanese concept of finding purpose at the intersection of what you love, what you're good at, what the world needs, and what you can be paid for.
```
Expected: `type = 'source'`, `source_ref` is the Wikipedia URL. Confirmation reply shows title and full body.

**Message 3 — Reflection:**
```
I notice I work best when I've committed to a constraint before I start, rather than leaving options open. The open option always feels like escape.
```
Expected: `type = 'reflection'` (the user's words explicitly signal personal resonance). Confirmation reply shows title and full body.

**Message 4 — Related note linking (must run after messages 1 and 3 are stored):**
```
The blank canvas problem: infinite possibility can be more paralyzing than a tight brief. Designers know this. So do writers.
```
Expected: The related-note lookup finds messages 1 and/or 3 (similarity > 0.65). The LLM may create a link. The confirmation may include a "Linked to:" line.

**Message 5 — Non-text guard:**
Send any sticker.
Expected: Bot replies "I can only process text for now. Send a text message." No row inserted in `notes`.

**All five must pass before moving to smoke tests.**

---

## Task 9 — Smoke Tests

**File to create:** `tests/smoke.test.ts`

These tests run against the deployed Worker using vitest. They read environment variables from `.dev.vars` via the `vitest.config.ts` loader. Run manually before each release.

```typescript
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const WORKER_URL = process.env['WORKER_URL'] ?? '';
const WEBHOOK_SECRET = process.env['TELEGRAM_WEBHOOK_SECRET'] ?? '';
const CHAT_ID = Number(process.env['TELEGRAM_CHAT_ID'] ?? '0');
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function makeUpdateId(): number {
  return Math.floor(Date.now() / 1000) * 100 + Math.floor(Math.random() * 100);
}

function makeUpdateBody(text: string, updateId?: number): string {
  const id = updateId ?? makeUpdateId();
  return JSON.stringify({
    update_id: id,
    message: {
      message_id: id,
      chat: { id: CHAT_ID, type: 'private' },
      from: { id: CHAT_ID, is_bot: false, first_name: 'TestUser' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });
}

async function postToWorker(body: string, secret?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret !== undefined) {
    headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  }
  return fetch(WORKER_URL, {
    method: 'POST',
    headers,
    body,
  });
}

describe('webhook security', () => {
  it('returns 403 when secret header is missing', async () => {
    const res = await postToWorker(makeUpdateBody('test'));
    expect(res.status).toBe(403);
  });

  it('returns 403 when secret header is wrong', async () => {
    const res = await postToWorker(makeUpdateBody('test'), 'wrong-secret-value');
    expect(res.status).toBe(403);
  });
});

describe('capture flow', () => {
  it('stores a note with non-null embedding', async () => {
    const marker = `smoke-test-${Date.now()}`;
    const text = `Smoke test note about ${marker} — testing the capture pipeline`;
    const res = await postToWorker(makeUpdateBody(text), WEBHOOK_SECRET);
    expect(res.status).toBe(200);

    // Wait for background processing to complete
    await new Promise(r => setTimeout(r, 10000));

    const { data, error } = await supabase
      .from('notes')
      .select('id, title, embedding')
      .ilike('body', `%${marker}%`)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data![0]!.embedding).not.toBeNull();
  }, 30000);
});

describe('deduplication', () => {
  it('does not create duplicate notes for the same update_id', async () => {
    const updateId = makeUpdateId();
    const marker = `dedup-test-${updateId}`;
    const text = `Dedup smoke test about ${marker}`;
    const body = makeUpdateBody(text, updateId);

    const res1 = await postToWorker(body, WEBHOOK_SECRET);
    expect(res1.status).toBe(200);

    const res2 = await postToWorker(body, WEBHOOK_SECRET);
    expect(res2.status).toBe(200);

    // Wait for background processing
    await new Promise(r => setTimeout(r, 10000));

    const { data, error } = await supabase
      .from('notes')
      .select('id')
      .ilike('body', `%${marker}%`);

    expect(error).toBeNull();
    expect(data!.length).toBeLessThanOrEqual(1);
  }, 30000);
});

describe('edge cases', () => {
  it('returns 200 for non-text update without crashing', async () => {
    const body = JSON.stringify({
      update_id: makeUpdateId(),
      message: {
        message_id: makeUpdateId(),
        chat: { id: CHAT_ID, type: 'private' },
        from: { id: CHAT_ID, is_bot: false, first_name: 'TestUser' },
        date: Math.floor(Date.now() / 1000),
        sticker: { file_id: 'fake', type: 'regular' },
      },
    });
    const res = await postToWorker(body, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });
});
```

Run the tests:

```bash
npx vitest run tests/smoke.test.ts
```

The `vitest.config.ts` at the project root loads `.dev.vars` into `process.env` automatically. All tests must pass. If the capture test fails on embedding being null, check Worker logs for an OpenRouter error. If the dedup test shows >1 note, check that the `processed_updates` table has the unique constraint.

---

## Task 10 — Pre-Publish Checklist

Before committing and pushing to a public GitHub repository:

### 10a — Secret audit

```bash
# Must return nothing
git log --all -p | grep -iE "(sk-or|bot[0-9]{10}|service_role|webhook_secret)"

# Check staged files
git diff --cached | grep -iE "(key|token|secret|password)"
```

### 10b — .gitignore check

```bash
git ls-files .env .dev.vars
# Must return nothing
```

### 10c — Install hooks

```bash
./scripts/install-hooks.sh
```

### 10d — `supabase/config.toml` check

Open `supabase/config.toml`. Verify it contains only `project_id` and local dev port settings. No values that look like keys (starting with `eyJ`, `sk-`, or 64 hex characters).

### 10e — README stub

Create `README.md` with at minimum:
- Project description
- Prerequisites (Supabase account, OpenRouter account with credits, Telegram bot, Cloudflare account)
- Setup steps referencing exact commands from Tasks 1-7
- A **Security** section with warnings from `reviews/02-security.md` (R8 section)
- Note that `./scripts/install-hooks.sh` must be run before the first commit

### 10f — Final checks

Verify the Worker is active:
```bash
wrangler deployments list
```

Verify webhook is healthy:
```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Confirm `pending_update_count` is `0` or low and `last_error_message` is absent.

### 10g — Commit and push

```bash
git add src/ supabase/migrations/ tests/ wrangler.toml package.json package-lock.json \
  tsconfig.json vitest.config.ts scripts/ .gitleaks.toml .dev.vars.example README.md
git commit -m "feat: Phase 1 — Telegram capture loop on Cloudflare Workers"
git remote add origin https://github.com/YOUR_USERNAME/contemplace.git
git push -u origin main
```

Enable GitHub secret scanning immediately after push: **Settings → Security → Secret scanning → Enable**, then **Push protection → Enable**.

---

## Reference: Async Pattern

The previous plan used synchronous processing with dedup-on-retry (because Supabase Edge Functions cannot reliably run background work). This plan uses Cloudflare Workers' `ctx.waitUntil()`, which guarantees the background task runs to completion even after the response is sent.

The flow:
1. **Sync path** (~50-100ms): verify secret → parse body → guard non-text → chat ID whitelist check → dedup check → return 200.
2. **Async path** (3-8s): embed text → find related notes → run LLM → insert note + links → send confirmation.

Telegram sees the 200 immediately and never retries. The dedup check in the sync path is a safety net for the rare case where Telegram sends the same update twice before the first request reaches the dedup insert.

---

## Reference: Environment Variables

| Variable | Where it lives | Used in |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `wrangler secret put` | Worker — sending messages, webhook registration |
| `TELEGRAM_WEBHOOK_SECRET` | `wrangler secret put` | Worker — signature verification |
| `OPENROUTER_API_KEY` | `wrangler secret put` | Worker — embeddings + LLM calls |
| `SUPABASE_URL` | `wrangler secret put` | Worker — DB access |
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put` | Worker — DB access |
| `ALLOWED_CHAT_IDS` | `wrangler secret put` | Worker — chat ID whitelist (comma-separated) |
| `CAPTURE_MODEL` | `wrangler.toml` `[vars]` | Worker — LLM model string (default: `anthropic/claude-haiku-4-5`) |
| `EMBED_MODEL` | `wrangler.toml` `[vars]` | Worker — embedding model string (default: `openai/text-embedding-3-small`) |
| `MATCH_THRESHOLD` | `wrangler.toml` `[vars]` | Worker — similarity threshold (default: `0.65`) |
| `TELEGRAM_CHAT_ID` | `.dev.vars` only | Smoke tests |
| `WORKER_URL` | `.dev.vars` only | Smoke tests |

Secrets go via `wrangler secret put`. Non-secret config goes in `wrangler.toml` under `[vars]`. Local dev secrets and test variables go in `.dev.vars`.

---

## Completion Criteria

Phase 1 is done when:

1. All smoke tests pass.
2. Five manual messages sent from Telegram produce correctly structured rows in `notes` with non-null `embedding`.
3. Confirmation replies arrive in Telegram within 8 seconds.
4. The pre-publish checklist in Task 10 is complete.
5. The repository is on GitHub with secret scanning enabled.
