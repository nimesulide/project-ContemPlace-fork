# Architecture

ContemPlace runs as a single Cloudflare Worker that receives Telegram webhooks and processes them asynchronously. Supabase provides the database — Postgres with pgvector for semantic search. There are no Edge Functions, no queues, no background job runners. The Worker does everything.

## Why this shape

The system needs to do four things fast: receive a message, embed it, call an LLM, and store the result. Cloudflare Workers can do all of this in a single request lifecycle using `ctx.waitUntil()` for background processing. There's no cold start penalty, the runtime is globally distributed, and the deployment is a single command.

Supabase was chosen over a self-managed Postgres instance because it bundles pgvector, PostgREST (for RPC calls from the Worker), and a management dashboard — all on a free tier that's sufficient for a single-user system. The tradeoff is vendor lock-in on the database layer, but the schema is standard Postgres and could be migrated.

OpenRouter sits between the Worker and all AI models. This adds a hop but means the system can switch between models (or providers) by changing an environment variable. No code change, no redeployment needed. The `openai` npm package talks to OpenRouter via a `baseURL` override — the same SDK works for embeddings and chat completions.

## The async capture flow

Telegram sends a webhook POST for every message. The Worker must respond quickly or Telegram will retry (and eventually disable the webhook). The solution: return HTTP 200 immediately, then do all the real work in `ctx.waitUntil()`.

```
 Telegram POST
       │
       ▼
 ┌─────────────────────────────────┐
 │  1. Verify webhook secret       │ ← 403 if wrong
 │  2. Parse body                  │ ← 200 if non-text message
 │  3. Check chat ID whitelist     │ ← 200 silently if not allowed
 │  4. Dedup (insert update_id)    │ ← 200 if already processed
 │  5. Return 200                  │
 └─────────────────────────────────┘
       │
       ▼  ctx.waitUntil()
 ┌─────────────────────────────────┐
 │  A. In parallel:                │
 │     • embed raw text            │
 │     • fetch capture voice       │
 │     • send typing indicator     │
 │                                 │
 │  B. Find related notes          │
 │     (match_notes RPC, top 5)    │
 │                                 │
 │  C. Call capture LLM            │
 │     (system frame + voice       │
 │      + raw input + related      │
 │      notes + today's date)      │
 │                                 │
 │  D. Parse + validate response   │
 │     (10 fields, logged defaults │
 │      for invalid values)        │
 │                                 │
 │  E. Re-embed with metadata      │
 │     augmentation (fallback to   │
 │     raw embedding on failure)   │
 │                                 │
 │  F. Insert note + links         │
 │                                 │
 │  G. In parallel:                │
 │     • log enrichments           │
 │     • send Telegram reply       │
 └─────────────────────────────────┘
```

Steps A and G use `Promise.all()` for parallelism. The rest is sequential because each step depends on the previous one's output.

## Two-pass embedding

Every note gets embedded twice:

1. **Raw embedding** — the user's exact input text, embedded before the LLM runs. Used to find related notes via `match_notes()`. This is the lookup embedding.

2. **Augmented embedding** — after the LLM classifies the note, `buildEmbeddingInput()` prepends metadata: `[Type: idea] [Intent: plan] [Tags: cooking, project] The actual text...`. This is stored in the `notes.embedding` column.

The augmented embedding bakes organizational context into the vector space. Two notes about "cooking" and "woodworking" that share the intent `plan` will be slightly closer in vector space than they would be from raw text alone. This matters for downstream retrieval — an agent searching for "things the user is planning" benefits from intent being part of the vector.

If the augmented embedding fails (API error, timeout), the system falls back to the raw embedding and logs an `augmented_embed_fallback` enrichment entry. The note is never lost.

The cost of double-embedding is negligible — roughly $0.00001 per note at current `text-embedding-3-small` pricing.

## System prompt structure

The LLM prompt is split into two parts that live in different places:

**System frame** — lives in code (`SYSTEM_FRAME` in `src/capture.ts`). This is the structural contract: the JSON schema the LLM must return, the allowed values for each enum field, the rules for entity extraction and linking, and the voice correction instructions. It changes only when the data model changes.

**Capture voice** — lives in the database (`capture_profiles` table, fetched at runtime by `getCaptureVoice()`). This is the stylistic layer: how titles should be phrased, how bodies should read, the traceability rule, tone preferences, examples of good and bad output. It can be edited in the Supabase SQL Editor without redeploying.

This split exists because structural changes (adding a new field, a new enum value) require code changes anyway, but stylistic tuning (shorter titles, different tone) should be instant. Any capture interface — Telegram, a future MCP tool, a CLI — fetches the same capture voice from the same table, ensuring consistent note style regardless of entry point.

The user message, related notes (with their type and intent metadata), and today's date are injected as the user turn. Related notes are provided so the LLM can create typed links; the date is provided so it can resolve relative time references ("yesterday", "next week").

## Error handling

The system distinguishes between errors the user should see and errors that need debugging:

- **User-facing:** A generic "Something went wrong" message sent to Telegram. Never includes stack traces, model names, or internal details.
- **Console logs:** Full structured JSON with the error, the input that caused it, and the processing stage. Visible in the Cloudflare Workers dashboard.

The parser (`parseCaptureResponse`) handles malformed LLM output gracefully. Each of the 10 fields has a fallback default (e.g., invalid type defaults to `idea`, missing intent defaults to `remember`). Every fallback is logged as structured JSON so prompt tuning issues can be diagnosed from logs.

## Deduplication

Telegram can deliver the same webhook multiple times. The `processed_updates` table stores each `update_id` with a unique constraint. Before processing, the Worker attempts an insert — if it hits a `23505` unique violation, the update was already processed and is silently ignored.

This runs *before* the 200 response, so dedup is synchronous and guaranteed even if the background processing fails.

## Security boundaries

- **Webhook verification:** Every request must include a valid `x-telegram-bot-api-secret-token` header matching the configured secret. Missing or wrong = 403.
- **Chat ID whitelist:** Only chat IDs listed in `ALLOWED_CHAT_IDS` are processed. Others get a silent 200 (no information leak).
- **Service role key:** All Supabase access uses the service role key, bypassing RLS. The anon key is never used. RLS is enabled on all tables with a `deny all` policy as defense in depth — if the anon key were ever exposed, it would have zero access.
- **No raw SQL interpolation:** JSONB columns (`entities`, `metadata`) contain LLM-generated content and are never interpolated into SQL strings. All queries use parameterized Supabase client calls.
