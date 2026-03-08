# Integration Gotchas Review

## Telegram

### Webhook retry behaviour and duplicate note creation

Telegram's webhook delivery timeout is **5 seconds**. If your Edge Function does not return an HTTP 200 within that window, Telegram marks the delivery as failed and retries with exponential backoff — roughly at 5s, 10s, 20s, 40s, 80s, 160s, then it stops. Each retry is a fresh HTTP POST with an identical `update_id`.

The thoughtful capture path (embed → match_notes → LLM call → insert → reply) will regularly exceed 5 seconds, especially on cold starts. That means Telegram will retry, and without deduplication your function will insert the same note two or three times.

**The correct fix is idempotency on `update_id`, not async processing.** Store each processed `update_id` and short-circuit duplicates before doing any work. The simplest approach: a `processed_updates` table with a unique constraint on `update_id`, or check at insert time.

```sql
create table processed_updates (
  update_id bigint primary key,
  processed_at timestamptz default now()
);
```

In the Edge Function, attempt an insert before processing:

```typescript
const { error: dedupError } = await supabase
  .from('processed_updates')
  .insert({ update_id: update.update_id });

if (dedupError?.code === '23505') {
  // duplicate — already processed
  return new Response('ok', { status: 200 });
}
```

The 23505 code is Postgres's unique_violation. Return 200 immediately on duplicate — never return an error to Telegram, or it will keep retrying.

**The alternative — return 200 immediately and process in the background — does not work in Supabase Edge Functions.** Deno's `EdgeRuntime.waitUntil()` is not available; the function terminates as soon as the response is returned. Background processing requires a separate queue (e.g. Supabase Queue or pg_cron), which is out of scope for Phase 1. Idempotency is the right call here.

### Message types that will crash the function

Telegram sends many update types beyond text messages. Without an explicit guard, your function will crash or produce corrupt data on:

| Message type | `message.text` value | Action |
|---|---|---|
| Sticker | `undefined` | Guard and reply "I can only process text" |
| Photo | `undefined` (use `caption` instead if present) | Defer to Phase 2; reply with notice |
| Audio / Voice | `undefined` | Defer to Phase 2 (voice transcription is planned) |
| Document | `undefined` | Reply with notice |
| Forward | `message.text` is present, but `message.forward_origin` is set | Handle normally — forwarded text is fine |
| `/start` command | `"/start"` | Reply with a welcome message; do not attempt capture |
| Other commands | text starting with `/` (not `/fast`) | Reply with unknown command message |
| Edited message | `update.edited_message` (not `update.message`) | Currently ignored; add a guard to return 200 silently |
| Channel post | `update.channel_post` | Ignore and return 200 |
| Callback query | `update.callback_query` | Ignore and return 200 |

The minimum safe guard at the top of the handler:

```typescript
const message = update.message ?? update.edited_message;
if (!message) return new Response('ok', { status: 200 });

const text = message.text ?? message.caption;
if (!text) {
  await sendTelegramMessage(chatId, 'I can only process text for now. Send a text message.');
  return new Response('ok', { status: 200 });
}
```

### Registering /fast with BotFather

The brief covers webhook registration but not command registration. Without this, `/fast` will not appear in the bot's command menu (the `/` autocomplete list) — the bot still works, but the UX is poor.

After creating the bot, message BotFather with `/setcommands`, select your bot, and send:

```
fast - Quick capture (title + tags only, no related note lookup)
```

One command per line. No leading slash in the list. BotFather confirms immediately.

You can also set commands programmatically via the API — useful to document this in the README so it can be replicated:

```
POST https://api.telegram.org/bot{TOKEN}/setMyCommands
Content-Type: application/json

{
  "commands": [
    { "command": "fast", "description": "Quick capture (title + tags only)" }
  ]
}
```

### Rate limits

Telegram's rate limits for bots:

- **30 messages per second** globally across all chats.
- **1 message per second** to any single chat (strictly enforced; exceeding this returns 429 with a `retry_after` field in seconds).
- **20 messages per minute** to groups (not relevant here — this is a single-user bot).

For this build (one user, one chat), the 1 msg/s per-chat limit is the only one that matters. You are very unlikely to hit it. If you do (e.g. rapid-fire test messages), the Telegram API returns:

```json
{ "ok": false, "error_code": 429, "description": "Too Many Requests: retry after 1", "parameters": { "retry_after": 1 } }
```

Handle this in `sendTelegramMessage` — check for 429 and either retry after `retry_after` seconds or log and drop. For Phase 1, logging and dropping is fine.

### Testing the webhook without Docker

Because the user is developing cloud-only (no local Supabase), the correct approach is to deploy the function to the cloud and test against it directly. The brief already implies this. Two practical tools:

**Option 1: `curl` to simulate Telegram updates directly.** You can POST a fake Telegram update payload to your deployed Edge Function URL, bypassing Telegram entirely. Include the `X-Telegram-Bot-Api-Secret-Token` header to pass signature verification:

```bash
curl -X POST https://YOUR_REF.supabase.co/functions/v1/ingest-telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: YOUR_WEBHOOK_SECRET" \
  -d '{
    "update_id": 1,
    "message": {
      "message_id": 1,
      "chat": { "id": YOUR_CHAT_ID, "type": "private" },
      "from": { "id": YOUR_USER_ID, "is_bot": false, "first_name": "Test" },
      "date": 1700000000,
      "text": "Test note about something interesting"
    }
  }'
```

**Option 2: Telegram's own test infrastructure.** Use `@userinfobot` to get your real chat ID, then just send real messages via Telegram. This is the most realistic test because it includes real `update_id` values and the actual Telegram delivery path.

**Option 3: `ngrok` is not needed** and not recommended here — the Edge Function is already publicly addressable on Supabase's infrastructure.

For smoke tests (per the preferences), use Deno's test runner against the deployed function with the curl approach above, asserting on both the HTTP response and the resulting database row.

---

## Supabase Edge Functions

### Correct import syntax in Deno

Deno does not use `node_modules`. Imports must use URLs or import maps. The two critical SDKs:

**Supabase JS client** — use the ESM CDN URL, not the npm specifier without a prefix:

```typescript
// Correct
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Also correct (with import map in deno.json)
import { createClient } from '@supabase/supabase-js';
// ...where deno.json maps "@supabase/supabase-js" to the esm.sh URL

// Wrong — will fail in Deno without an import map
import { createClient } from '@supabase/supabase-js';
```

**OpenAI-compatible SDK** — the `openai` npm package works in Deno via the `npm:` specifier (Deno 1.28+, which Supabase Edge Functions support):

```typescript
// Correct
import OpenAI from 'npm:openai';

// Also correct (pinned version, recommended)
import OpenAI from 'npm:openai@4';
```

Using `npm:openai` is preferable to the esm.sh URL for this package because the npm specifier handles the package's internal CJS/ESM resolution correctly.

**Recommended `deno.json` import map:**

```json
{
  "imports": {
    "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2",
    "openai": "npm:openai@4"
  }
}
```

### What `--no-verify-jwt` does and whether it is correct

By default, Supabase Edge Functions require a valid Supabase JWT in the `Authorization` header. Calling `supabase functions deploy --no-verify-jwt` disables this check, making the function publicly callable without a Supabase auth token.

This is correct for this build. Telegram's webhook posts do not carry Supabase JWTs — they carry the `X-Telegram-Bot-Api-Secret-Token` header. If you deploy without `--no-verify-jwt`, every webhook delivery from Telegram returns 401 and no notes are captured.

The security tradeoff is that the function is publicly reachable without Supabase auth. This is mitigated by the webhook secret check (the `X-Telegram-Bot-Api-Secret-Token` header verified against `TELEGRAM_WEBHOOK_SECRET`). As the security review covers, that verification must actually run — dropping it means anyone who discovers the URL can post arbitrary data.

### Cold start behaviour

Supabase Edge Functions are Deno isolates that spin up on demand. Cold start latency is typically **300–800ms** on Supabase's free tier, occasionally up to 1–2 seconds under low traffic. This is already inside the 5-second Telegram window, but it consumes budget that could otherwise be used for actual processing.

On the free tier, functions are not "warm" between invocations — there is no keep-alive mechanism. Every invocation after a period of inactivity (roughly a few minutes) will incur a cold start. For a personal bot with infrequent messages, expect cold starts on most invocations.

**Practical implication:** The 5-second budget is approximately: 1s cold start + 0.5s embed + 1.5s LLM + 0.5s DB + 0.5s Telegram reply = 4s, leaving ~1s margin. If the LLM is slow (Haiku typically responds in 1–2s but can spike), you will hit the 5-second wall. The deduplication approach above handles this gracefully.

### Environment variables / secrets in Deno

Node.js uses `process.env.VAR_NAME`. Deno uses `Deno.env.get('VAR_NAME')`.

```typescript
// Node — wrong in Deno
const token = process.env.TELEGRAM_BOT_TOKEN;

// Deno — correct
const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
```

In Supabase Edge Functions, secrets set via `supabase secrets set KEY=VALUE` are available as environment variables at runtime via `Deno.env.get()`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — you do not need to set those manually.

For strict TypeScript, assert non-null at startup:

```typescript
function requireEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const TELEGRAM_BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const OPENROUTER_API_KEY = requireEnv('OPENROUTER_API_KEY');
```

This crashes fast and loudly at deploy time if a secret is missing, which is the right behaviour.

### Returning 200 immediately and processing asynchronously

As noted above, **this pattern does not work in Supabase Edge Functions.** `EdgeRuntime.waitUntil()` is documented in some Supabase examples but its availability is inconsistent and it is not guaranteed to complete after the response is sent on the free tier. Do not rely on it.

The correct solution for this build is the idempotency approach: process synchronously, return 200 after completion, and handle Telegram retries via `update_id` deduplication. If the function exceeds 5 seconds regularly, the right fix is to make the processing faster (e.g. run embed and LLM call concurrently where possible), not to defer to background processing.

One concrete optimisation — embed and match_notes can run before the LLM call. But the embed itself is a prerequisite for match_notes. The one parallelism available in thoughtful mode is running the Telegram `sendChatAction` (typing indicator) concurrently with the embed call, since sendChatAction has no dependency:

```typescript
const [_, embeddingResponse] = await Promise.all([
  sendChatAction(chatId, 'typing'),
  openai.embeddings.create({ model: EMBED_MODEL, input: text }),
]);
```

---

## OpenRouter

### Correct base URL and SDK configuration

The brief states the correct base URL (`https://openrouter.ai/api/v1`) but does not show how to configure the SDK. The full SDK initialisation:

```typescript
const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/YOUR_USERNAME/contemplace', // required by OpenRouter for tracking
    'X-Title': 'ContemPlace',                                        // optional but recommended
  },
});
```

The `HTTP-Referer` header is technically optional but OpenRouter's docs state it is used to associate usage with your account and show in your dashboard. Omitting it is fine but adding it is good practice, especially for a tutorial project.

### voyage/voyage-3 on OpenRouter

**The model identifier `voyage/voyage-3` is not available on OpenRouter.** Voyage AI's embedding models are not in OpenRouter's model catalogue. OpenRouter's model list (as of early 2026) does not include Voyage embeddings.

The brief hard-codes 1024 dimensions for the schema, which is correct for voyage-3's default output. You have two options:

**Option A: Use OpenRouter for embeddings with a different model.**
The most capable embedding model on OpenRouter that produces 1024-dimensional vectors is `mistral/mistral-embed` (1024 dims). Alternatively, several models produce 1536 dims (OpenAI `text-embedding-3-small` or `text-embedding-ada-002`), but that would require changing the schema dimension.

```typescript
// Using mistral-embed via OpenRouter (1024 dims)
const embedding = await openai.embeddings.create({
  model: 'mistral/mistral-embed',
  input: text,
});
```

**Option B: Call Voyage AI directly** (recommended if you want voyage-3 specifically).
Voyage has its own API at `https://api.voyageai.com/v1` with OpenAI-compatible embedding endpoints. This requires a separate `VOYAGE_API_KEY` and a second SDK instance or a second fetch call. The model identifier on Voyage's own API is `voyage-3`.

```typescript
const voyageClient = new OpenAI({
  apiKey: VOYAGE_API_KEY,
  baseURL: 'https://api.voyageai.com/v1',
});

const embedding = await voyageClient.embeddings.create({
  model: 'voyage-3',
  input: text,
});
```

**Recommendation:** The brief's intent is to route everything through OpenRouter to keep API key management simple. Given Voyage is not on OpenRouter, either switch the embedding model to `mistral/mistral-embed` (1024 dims, stays on OpenRouter, one API key) or add Voyage directly as a second client. The schema dimension of 1024 is fine either way. **This is the most significant factual error in the brief** and must be resolved before implementation starts.

### How OpenRouter handles errors

OpenRouter returns OpenAI-compatible error objects for most errors:

```json
{
  "error": {
    "code": 429,
    "message": "Rate limit exceeded",
    "type": "rate_limit_error"
  }
}
```

However, there are two non-obvious differences from the OpenAI API:

1. **Provider errors are wrapped.** If an upstream provider (e.g. Anthropic) returns an error, OpenRouter wraps it in the OpenAI error format with a `metadata.provider_name` field. The HTTP status code is passed through, but the error structure is OpenRouter's envelope, not Anthropic's native error format.

2. **Model availability errors.** If a model is unavailable, OpenRouter returns 503 with `error.type: "service_unavailable"`. The OpenAI SDK will throw this as an `APIError`. Catch it explicitly:

```typescript
import { APIError } from 'npm:openai';

try {
  const response = await openai.chat.completions.create({ ... });
} catch (err) {
  if (err instanceof APIError) {
    console.error(JSON.stringify({ event: 'openrouter_error', status: err.status, message: err.message }));
    // send user-facing error per preferences
  }
  throw err;
}
```

### Rate limits on the free tier

OpenRouter's free tier rate limits (as of early 2026):

- **20 requests per minute** across all models (global, not per-model).
- **200 requests per day** hard cap.
- Free tier models are labelled `:free` and have their own sub-limits.

For this build, you are using paid models (Haiku, Sonnet) via OpenRouter, which means you need credits loaded — they are not free-tier models. The rate limits for paid calls are much higher (typically 60 req/min or more depending on the provider). With a loaded account, you are very unlikely to hit limits for personal use.

The `voyage/voyage-3` issue above is more pressing than rate limits for this build.

### Streaming

Streaming is not needed for any part of this build. The Telegram reply is sent after the full LLM response is parsed and the note is inserted — there is no intermediate UI to update. Do not use `stream: true`; it complicates JSON parsing significantly (you would need to buffer the stream and then parse the complete content) with no user-visible benefit. Use non-streaming completions throughout.

---

## pgvector

### The `<=>` operator and cosine distance

The brief is correct. `<=>` is pgvector's cosine distance operator. `1 - (embedding <=> query_embedding)` gives cosine similarity (1 = identical, 0 = orthogonal, -1 = opposite). The `match_notes` function uses `<=>` correctly throughout — both in the similarity calculation and in the `ORDER BY`.

The HNSW index is created with `vector_cosine_ops`, which is required for `<=>` to use the index. If you use `<->` (L2) or `<#>` (inner product) in queries against a `vector_cosine_ops` index, the index is ignored and you get a sequential scan. The brief is consistent on this.

### HNSW index parameters at this scale

`m=16, ef_construction=64` are pgvector's default values. They are appropriate — neither wasteful nor insufficient — for a collection growing from zero to a few thousand notes.

At small collection sizes (under ~10,000 notes), the HNSW index provides no meaningful performance advantage over a sequential scan. Postgres will often choose the sequential scan anyway at this scale, which is fine — it is faster for small tables. The index becomes valuable above ~50,000 rows. For this build, the main reason to create it now is so the schema is production-ready and does not require a migration later (building an HNSW index on a large table is expensive and locks the table in older Postgres versions).

One genuine issue: `ef_construction=64` is the default but on the low end for accuracy. For a personal memory system where recall quality matters (you want to find conceptually related notes, not miss them), consider `ef_construction=128`. The tradeoff is slightly slower index builds, which is irrelevant at this scale. This is advisory, not critical.

### Calling the RPC from Supabase JS client

The brief shows the SQL function but not the JS call. The correct syntax:

```typescript
const { data, error } = await supabase.rpc('match_notes', {
  query_embedding: embeddingVector,   // number[]
  match_threshold: 0.65,
  match_count: 5,
  filter_type: null,
  filter_source: null,
  filter_tags: null,
});

if (error) throw new Error(`match_notes RPC failed: ${error.message}`);
```

Parameter names in the `.rpc()` call must match the SQL function's parameter names exactly (snake_case). The embedding vector must be a plain JavaScript `number[]` array, not a typed array — the Supabase JS client serialises it to JSON for the RPC call.

Note: `filter_type`, `filter_source`, and `filter_tags` have SQL defaults, but you must still pass them explicitly in the JS client or the client will omit them from the payload and the RPC will use the SQL defaults. Passing `null` explicitly is equivalent to using the default.

### Null embeddings

The brief's `match_notes` function does not guard against null embeddings, and this is a real crash risk. If an embedding call fails (OpenRouter timeout, API error) and you insert a note with `embedding = null`, then a subsequent call to `match_notes` that encounters that row will silently produce `null` for the similarity computation, which then fails the `> match_threshold` comparison in an undefined way in Postgres. In practice, Postgres evaluates `null > 0.65` as `null` (not true), so the row is excluded from results. The query does not crash.

However, the HNSW index cannot index null values — null-embedding rows are excluded from index scans entirely (they only appear in sequential scans). This means notes with failed embeddings will never surface in semantic search. That is the correct behaviour — an un-embedded note has no similarity to anything — but it should be logged clearly so you know embeddings failed.

The schema review should address whether to add a check constraint or a partial index to make this explicit. For the integration layer, the key action is: **never silently swallow embedding errors**. If the embed call fails, log it, send the user a failure message (per the preferences: never fail silently), and do not insert a note with a null embedding. The note is lost. That is preferable to a ghost note that can never be retrieved.

---

## Changes required to the brief

1. **Critical — voyage/voyage-3 is not on OpenRouter.** The brief states "Voyage/voyage-3 via OpenRouter" as the embedding model. This model is not available through OpenRouter. Either replace with `mistral/mistral-embed` (1024 dims, stays on OpenRouter, one API key) or add a second client pointing to `https://api.voyageai.com/v1` with a separate `VOYAGE_API_KEY`. The schema dimension of 1024 is compatible with both options. A decision is required before implementation begins.

2. **Critical — no deduplication mechanism for Telegram retries.** The brief does not address `update_id` deduplication. Add a `processed_updates` table (schema shown above) and a short-circuit check at the top of the handler. Without this, every thoughtful capture that takes >5 seconds (likely most of them on cold starts) will produce duplicate notes.

3. **Required — message type guards are missing.** The Edge Function as implied by the brief will crash or behave incorrectly on sticker, photo, audio, voice, edited message, and non-`/fast` command updates. Add guards as shown above before any processing logic.

4. **Required — BotFather command registration is not documented.** The brief covers webhook registration but not `setMyCommands`. Add the `setMyCommands` API call (or BotFather instructions) to the setup steps so `/fast` appears in the command menu.

5. **Required — SDK initialisation for OpenRouter is not shown.** The brief mentions the base URL but not the `HTTP-Referer` header or full SDK init. Add the complete SDK initialisation block to the brief or implementation plan.

6. **Advisory — `ef_construction` for HNSW.** Consider raising `ef_construction` from 64 to 128 for better recall accuracy. No impact at small scale; relevant when the collection grows.

7. **Advisory — `Deno.env.get()` not `process.env`.** Ensure the implementation plan explicitly calls out the Deno environment variable API, since the brief does not mention this and it is a common source of silent failures (the function deploys successfully but all env vars are `undefined` at runtime).

8. **Advisory — OpenRouter paid tier required.** The models specified in the brief (Haiku, Sonnet) are not free-tier models on OpenRouter. The brief should note that credits must be loaded before the integration will work, and that the free tier is insufficient for these model choices.
