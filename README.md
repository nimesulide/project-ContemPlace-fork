# ContemPlace

A personal memory capture system. Send raw thoughts to a Telegram bot; they come back structured, embedded, and stored — ready for semantic retrieval by an AI agent.

## What it does

You send a message. The bot returns a structured note with a title, a cleaned-up body in your own voice, and links to related notes already in your database. No editing, no forms, no structure imposed by you.

The stored notes become a semantic context layer. The intended downstream use (Phase 2) is an MCP server that lets an AI agent retrieve relevant notes by similarity — so you can think out loud with a collaborator that already knows your prior thinking.

## Stack

| Layer | Technology |
|---|---|
| Compute | Cloudflare Workers (TypeScript) |
| Database | Supabase — Postgres 16 + pgvector |
| AI gateway | OpenRouter (OpenAI-compatible SDK) |
| Embeddings | `openai/text-embedding-3-small` (1536 dimensions) |
| Capture LLM | `anthropic/claude-haiku-4-5` |
| Interface | Telegram bot (webhook) |

## How it works

```
You → Telegram → Cloudflare Worker
                      │
                      ├─ verify webhook secret
                      ├─ check chat ID whitelist
                      ├─ dedup check → return 200
                      │
                      └─ ctx.waitUntil():
                            embed text
                            find semantically related notes
                            LLM structures the note + links it
                            insert into Supabase
                            send formatted reply to Telegram
```

The Worker returns 200 immediately and processes everything in the background. Telegram never times out; the bot is always responsive.

## Capture agent

The LLM follows Evergreen Notes methodology: titles are claims or insights, not topic labels. Bodies are atomic — one idea, in the user's own voice, nothing added that wasn't said. Notes are typed (`idea`, `reflection`, `source`, `lookup`) and linked to related notes with typed edges (`extends`, `contradicts`, `supports`, `is-example-of`).

Input can come from voice dictation. The agent detects and silently corrects transcription errors, cross-referencing proper nouns against existing notes. Corrections are reported in the reply.

## Setup

### Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers enabled
- [Supabase project](https://supabase.com) (free tier is fine)
- [OpenRouter account](https://openrouter.ai) with API key
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/), [Supabase CLI](https://supabase.com/docs/guides/cli)

### 1. Clone and install

```bash
git clone https://github.com/freegyes/project-ContemPlace.git
cd project-ContemPlace
npm install
```

### 2. Deploy the database schema

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 3. Configure secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # openssl rand -hex 32
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_CHAT_IDS          # your Telegram chat ID
```

### 4. Deploy the Worker

```bash
npm run deploy
```

### 5. Register the Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://contemplace.YOUR_SUBDOMAIN.workers.dev" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]'
```

Send `/start` to your bot to verify it's alive.

### Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in real values, then:

```bash
npm run dev        # local Worker via wrangler
npm test           # smoke tests against the deployed worker
npm run typecheck  # TypeScript check
```

## Configuration

Non-secret config lives in `wrangler.toml` and can be overridden via env vars:

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_MODEL` | `anthropic/claude-haiku-4-5` | LLM for note structuring |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding model |
| `MATCH_THRESHOLD` | `0.60` | Cosine similarity cutoff for related notes (0–1) |

## Roadmap

- **Phase 1** (done): Telegram → Worker → Supabase, async capture, semantic linking, formatted replies
- **Phase 2**: MCP server for agent retrieval, image handling, additional input channels
