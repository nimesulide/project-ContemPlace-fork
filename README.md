# ContemPlace

A personal memory system. Send raw thoughts to a Telegram bot — they come back structured, embedded, and linked to your prior thinking. No editing. No forms. Just capture.

The stored notes form a semantic context layer. The intended use: an AI agent that already knows your accumulated thinking, retrieves relevant notes by similarity, and acts as a creative partner without you ever copying prior work into a prompt.

## How it works

You message the bot. The system:

1. Embeds your raw text and finds semantically related notes already in your database
2. Sends everything to an LLM that structures a note — title, body, tags, type, intent, entities — and links it to related notes
3. Stores the structured note alongside your exact raw input (never discarded)
4. Replies with a formatted confirmation showing the note, its metadata, and any linked notes

The bot returns a 200 to Telegram immediately and processes everything in the background. It never times out, regardless of LLM latency.

```
You → Telegram → Cloudflare Worker → return 200
                       └→ background:
                            embed raw text + fetch capture voice (parallel)
                            → find related notes by cosine similarity
                            → LLM structures the note + links it
                            → re-embed with metadata augmentation
                            → store note + links + audit log
                            → send confirmation to Telegram
```

## What the capture agent produces

Each note gets 10 fields from a single LLM pass:

| Field | Purpose |
|---|---|
| **title** | A claim or insight — not a topic label |
| **body** | 1–5 sentences, atomic, in the user's own voice |
| **type** | `idea` / `reflection` / `source` / `lookup` |
| **intent** | `reflect` / `plan` / `create` / `remember` / `reference` / `log` |
| **modality** | `text` / `link` / `list` / `mixed` |
| **tags** | Free-form, from the input |
| **entities** | Proper nouns with types (person, place, tool, project, concept) |
| **links** | Typed edges to related notes (`extends`, `contradicts`, `supports`, `is-example-of`) |
| **corrections** | Voice dictation fixes, applied silently and reported |
| **source_ref** | URL if one was included |

The body follows a strict traceability rule: every sentence must trace back to something you actually said. The agent cleans up grammar and filler but never fabricates information, adds conclusions, or pads for length.

Input can come from voice dictation. The agent detects and silently corrects transcription errors, cross-referencing proper nouns against existing notes. Corrections are shown in the reply.

## Stack

| Layer | Technology |
|---|---|
| Compute | Cloudflare Workers (TypeScript, V8 runtime) |
| Database | Supabase (Postgres 16 + pgvector) |
| AI gateway | OpenRouter (OpenAI-compatible SDK) |
| Embeddings | `openai/text-embedding-3-small` (1536 dimensions) |
| Capture LLM | `anthropic/claude-haiku-4-5` |
| Interface | Telegram bot (webhook-based) |

All models are configurable via environment variables. All AI calls route through OpenRouter.

## Setup

### Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers enabled
- [Supabase project](https://supabase.com) (free tier works)
- [OpenRouter API key](https://openrouter.ai)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/), [Supabase CLI](https://supabase.com/docs/guides/cli)

### 1. Clone and install

```bash
git clone https://github.com/freegyes/project-ContemPlace.git
cd project-ContemPlace
npm install
```

### 2. Link Supabase and deploy the schema

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF -p YOUR_DB_PASSWORD
supabase db push --linked --yes
```

The migration creates 8 tables, RLS policies, RPC functions, HNSW vector indexes, and seeds the default capture voice profile and SKOS domain concepts.

### 3. Configure secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # openssl rand -hex 32
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_CHAT_IDS          # comma-separated Telegram chat IDs
```

### 4. Deploy

```bash
wrangler deploy
```

Or use the full automated pipeline (schema + typecheck + tests + deploy + smoke tests):

```bash
bash scripts/deploy.sh
```

### 5. Register the Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://contemplace.YOUR_SUBDOMAIN.workers.dev" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]'
```

Send a message to your bot to verify.

### Local development

Copy `.dev.vars.example` to `.dev.vars`, fill in values, then:

```bash
npm run dev          # local Worker via wrangler
npm run typecheck    # TypeScript check
npx vitest run tests/parser.test.ts   # unit tests (local, no network)
npx vitest run tests/smoke.test.ts    # smoke tests (against live worker)
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_MODEL` | `anthropic/claude-haiku-4-5` | LLM for note structuring |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding model |
| `MATCH_THRESHOLD` | `0.60` | Cosine similarity floor for related notes |

Defaults live in `src/config.ts`. Override via `wrangler.toml` vars or Cloudflare dashboard.

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Async capture flow, two-pass embedding, prompt structure, error handling |
| [Capture agent](docs/capture-agent.md) | Classification taxonomy, entity extraction, linking logic, voice correction |
| [Schema](docs/schema.md) | All 8 tables, RPC functions, indexes, RLS, SKOS concepts |
| [Design decisions](docs/decisions.md) | Why this stack, key tradeoffs, lessons from real usage |
| [Roadmap](docs/roadmap.md) | Phase history and what's next |

## Project layout

```
src/
  index.ts        Worker entry point, webhook handler, capture orchestration
  config.ts       Environment variable parsing with defaults
  capture.ts      System frame, LLM call, response parser
  embed.ts        Embedding client, metadata-augmented embedding builder
  db.ts           Supabase operations (insert, search, capture voice, enrichment log)
  telegram.ts     Telegram API helpers
  types.ts        TypeScript interfaces and enums
scripts/
  deploy.sh       Automated 5-step deploy pipeline
supabase/
  migrations/     Schema migrations (v2 is current)
  seed/           SKOS domain concept seeds
tests/
  parser.test.ts  17 unit tests for capture response parsing
  smoke.test.ts   End-to-end tests against the live worker
reviews/          Specialist review notes from project bootstrap
```

## License

Private project. Not currently open-sourced.
