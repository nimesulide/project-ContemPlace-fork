# Security Review

## Pre-implementation checklist

- [ ] Create `.gitignore` (from the complete version below) before `git init` or before the first `git add`
- [ ] Create `.env.example` (from the complete version below) and commit it — never commit `.env`
- [ ] Run `git secrets --install` or install `gitleaks` as a pre-commit hook before any commit containing secrets
- [ ] Enable GitHub secret scanning on the repository immediately after creation (Settings → Security → Secret scanning → Enable)
- [ ] Enable GitHub push protection (Settings → Security → Secret scanning → Push protection → Enable) — this blocks pushes containing secrets before they land
- [ ] Verify `supabase/config.toml` does not contain project ref, API keys, or any credentials before first commit (see Supabase section below)
- [ ] Run `git log --all -p | grep -iE "(key|token|secret|password|bearer)" ` before first push to confirm clean history
- [ ] Store all four secrets in Supabase via `supabase secrets set` — never write them to any file that gets committed
- [ ] Confirm `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are not hardcoded anywhere in the Edge Function source — they are injected by the runtime
- [ ] Set `TELEGRAM_WEBHOOK_SECRET` to a value generated with `openssl rand -hex 32` — do not use a guessable string
- [ ] Set `MCP_ACCESS_KEY` to a value generated with `openssl rand -hex 32`
- [ ] After deploying, verify the webhook is registered with `getWebhookInfo` and that `has_custom_certificate` and `pending_update_count` look sane

---

## .gitignore (complete)

```gitignore
# Environment and secrets
.env
.env.local
.env.*.local
.env.production
.env.staging
*.pem
*.key
*.p12
*.pfx
secrets.json
secrets.*.json

# Supabase local dev (if ever used)
.supabase/

# Deno
.deno/
deno.lock

# Node (if any tooling is added)
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*
package-lock.json

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
```

---

## .env.example (complete)

```dotenv
# Copy this file to .env and fill in real values.
# NEVER commit .env. NEVER put real values in this file.

# From BotFather — keep this absolutely secret.
# Anyone with this token can send messages as your bot and read all messages it receives.
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Random secret you choose when registering the webhook.
# Generate with: openssl rand -hex 32
# Must match the secret_token parameter in the setWebhook call.
TELEGRAM_WEBHOOK_SECRET=your_webhook_secret_here

# From openrouter.ai — covers all LLM and embedding calls.
OPENROUTER_API_KEY=sk-or-v1-your_openrouter_key_here

# Secret for authenticating MCP client access (Phase 2).
# Generate with: openssl rand -hex 32
MCP_ACCESS_KEY=your_mcp_access_key_here

# Supabase auto-injects these in the Edge Function runtime — do NOT set them manually there.
# For local tooling (e.g. running smoke tests from your machine), set them here.
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Optional: Supabase anon key — only needed if you ever add client-side tooling.
# The Edge Functions must NEVER use this key for DB access.
# SUPABASE_ANON_KEY=your_anon_key_here
```

---

## Webhook security audit

### Is the brief's approach correct?

Mostly yes, but with one significant gap: the brief specifies that Telegram's `secret_token` is registered at webhook creation and passed back in the `X-Telegram-Bot-Api-Secret-Token` header, which is correct. Telegram's webhook signature scheme works by:

1. You register a `secret_token` string (1–256 chars, A-Z, a-z, 0-9, `_`, `-`) with `setWebhook`.
2. Telegram sends that exact string in the `X-Telegram-Bot-Api-Secret-Token` header on every webhook delivery.
3. Your function compares the header to the expected value.

The brief names this correctly (`TELEGRAM_WEBHOOK_SECRET` / `secret_token`) and the webhook registration URL is correct.

**The gap: the brief does not specify what the Edge Function does with the header.** It must be implemented explicitly or the protection is not active. The required implementation in the Edge Function is:

```typescript
const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token");
if (!incomingSecret || incomingSecret !== Deno.env.get("TELEGRAM_WEBHOOK_SECRET")) {
  return new Response("Unauthorized", { status: 403 });
}
```

This must be the very first check — before any body parsing, LLM calls, or DB writes. A timing-safe comparison (`crypto.subtle.timingSafeEqual`) is technically stronger but overkill here since the comparison value is a fixed string, not a HMAC.

**Is comparison sufficient vs. HMAC?** For Telegram's scheme, yes. Unlike Slack or GitHub webhooks (which use HMAC-SHA256 over the body), Telegram's `secret_token` is a bearer token on the header. The protection is: only Telegram knows what string you registered, so any request without it is not from Telegram. The entropy of a 64-character hex string (`openssl rand -hex 32`) makes brute-force infeasible.

### What happens if verification is skipped or wrong

If the check is absent or always passes: anyone who discovers the Edge Function URL can POST arbitrary payloads and trigger note insertions, LLM calls, and Supabase writes. Because the function URL follows a predictable pattern (`https://YOUR_REF.supabase.co/functions/v1/ingest-telegram`), the project ref is visible in any published README or tutorial — meaning the URL is effectively public. An attacker can flood the system with captures, exhaust the OpenRouter credit balance, and fill the database with garbage. Rate limiting at the function level would help but verification is the correct first line of defense.

If the check uses the wrong variable or a stale value: all legitimate Telegram messages return 403 and Telegram retries them until they expire (Telegram retries for up to 24 hours with exponential backoff). This manifests as duplicate processing when the bug is fixed.

### How to test that verification is working

```bash
# Should return 403
curl -X POST https://YOUR_REF.supabase.co/functions/v1/ingest-telegram \
  -H "Content-Type: application/json" \
  -d '{"test": true}'

# Should return 403
curl -X POST https://YOUR_REF.supabase.co/functions/v1/ingest-telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: wrong-value" \
  -d '{"test": true}'

# Should return 200 (or 400 if the body is not a valid Telegram update)
curl -X POST https://YOUR_REF.supabase.co/functions/v1/ingest-telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: YOUR_ACTUAL_SECRET" \
  -d '{"update_id": 1, "message": {"message_id": 1, "date": 1, "chat": {"id": 123, "type": "private"}, "text": "test"}}'
```

Include these three curl calls in the smoke test suite.

---

## RLS audit

### Are the RLS policies correct?

The brief's RLS policies are **syntactically valid but semantically incomplete for defense-in-depth.** Here is the issue:

```sql
create policy "service role only" on notes for all using (auth.role() = 'service_role');
```

`auth.role()` in Supabase RLS returns the role from the JWT. The service role key bypasses RLS entirely by default — it does not flow through `auth.role()` as `'service_role'` in the way the policy implies. In practice:

- Requests authenticated with the **service role key** bypass RLS completely (no policy check runs at all). The policies above are therefore never evaluated for service role access — the service role key already has unrestricted access.
- Requests authenticated with the **anon key** or a **user JWT** will have `auth.role()` return `'anon'` or `'authenticated'`, not `'service_role'`, so the policy will deny them. This is the correct outcome.

**Conclusion:** the policies work in practice — they block anon and authenticated access, and the service role bypasses them — but the rationale in the policy expression is misleading. The better and more explicit form is:

```sql
-- Deny all access except via service role (which bypasses RLS entirely).
-- This policy ensures that if someone accidentally uses the anon key,
-- they get an explicit denial rather than silently seeing no rows.
create policy "deny all non-service access" on notes
  for all
  using (false);
```

A `using (false)` policy means no non-service-role JWT can read or write rows, ever. This is cleaner and the intent is unambiguous. Apply the same pattern to `links` and `assets`.

The `match_notes` function is declared `language sql stable` with no `security definer`. This means it runs with the caller's privileges and is subject to RLS — correct behavior. If it were `security definer`, it would run as the function owner and bypass RLS, which would be a vulnerability.

### Key assignment: anon vs service role

| Context | Key to use | What goes wrong if swapped |
|---|---|---|
| Edge Functions (`ingest-telegram`, `contemplace-mcp`) | `SUPABASE_SERVICE_ROLE_KEY` | Using anon key: all DB writes fail silently (RLS denies them), no notes are stored, error surfaces to user |
| Client-side code (browser, mobile — not applicable here) | Anon key | Using service role key in client code: exposes the key in the browser, allows anyone who extracts it to bypass RLS and read/write all data directly |
| Smoke tests running from developer machine | `SUPABASE_SERVICE_ROLE_KEY` (via `.env`) | Same as Edge Function case |
| MCP server (`contemplace-mcp`) | `SUPABASE_SERVICE_ROLE_KEY` | Same as Edge Function case |

The brief's Hard Constraint 3 ("All DB access uses `SUPABASE_SERVICE_ROLE_KEY`, never the anon key") is correct. The anon key should not be committed anywhere and should not be set in Supabase secrets — there is no use case for it in this architecture.

**Critical: the service role key must never appear in client-side code or a public README.** Since `SUPABASE_SERVICE_ROLE_KEY` is injected by Supabase's runtime into Edge Functions automatically, it never needs to be in source code or `.env.example` with a real value. The only time a human handles it is when setting up smoke tests locally.

### MCP access key scheme

The `MCP_ACCESS_KEY` passed as `?key=` or `x-brain-key` header is a bearer token. This is sufficient for a single-user personal system, with these caveats:

1. The key should be generated with `openssl rand -hex 32` (256 bits entropy). Any weaker string is a risk.
2. The comparison in the Edge Function must happen before any processing, same as the Telegram secret check.
3. The MCP URL (`https://YOUR_REF.supabase.co/functions/v1/contemplace-mcp?key=YOUR_KEY`) will appear in AI agent configuration files (Claude Desktop `claude_desktop_config.json`, etc.). Those files must be in `.gitignore`. Add `claude_desktop_config.json` and any `*.mcp.json` patterns to `.gitignore` before Phase 2.
4. `?key=` in a query parameter means the key appears in server logs. The `x-brain-key` header is preferable and should be the documented default for Phase 2.

---

## Risks and mitigations

### R1 — Tutorial readers commit real secrets

**Risk:** The primary threat surface is tutorial replication. A reader follows the README, creates their `.env`, forgets `.gitignore`, and pushes secrets. This is the most likely real-world incident.

**Mitigations:**
- The `.gitignore` must be the very first file committed, before any `.env` is created. The README must say this explicitly and early.
- Add `gitleaks` as a pre-commit hook. Installation: `brew install gitleaks && gitleaks install` creates `.git/hooks/pre-commit`. The hook scans staged files before every commit. This is the strongest line of defense for tutorial followers.
- Alternatively, use Husky + `detect-secrets` for a project-local hook that works without a global install: add a `.pre-commit-config.yaml` or a `scripts/install-hooks.sh` that readers are instructed to run.
- GitHub secret scanning with push protection is the last line of defense for anything that slips through locally.

**Recommendation:** Use `gitleaks` via a committed `.gitleaks.toml` and a shell script `scripts/install-hooks.sh` that readers run once. This keeps the hook version-controlled and reproducible.

### R2 — `SUPABASE_SERVICE_ROLE_KEY` leaked via smoke tests

**Risk:** The smoke test suite runs against the live project using the service role key stored in `.env`. If a test file ever `console.log`s environment state or a CI configuration is added later, the key can leak.

**Mitigations:**
- Smoke tests must only read the key from `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` — never hardcode it or interpolate it into logged strings.
- If CI is added later, use GitHub Actions secrets (not repo variables) and ensure logs do not echo the key.

### R3 — Edge Function URL is public knowledge

**Risk:** Because the project ref and function name appear in the README and tutorial, the webhook URL is effectively public. Without webhook signature verification, this is an open endpoint.

**Mitigation:** Verification must be implemented and tested before the README is published. The smoke test must include a negative test (no header → 403). This is documented in the webhook section above.

### R4 — `supabase/config.toml` content

Supabase CLI generates `supabase/config.toml` locally. In cloud-only mode (no `supabase init` run locally), this file may not exist at all, which is fine. If `supabase init` is run to scaffold the project structure, the generated `config.toml` will contain the `project_id` (the project ref). This is not a secret — the project ref is visible in the Supabase dashboard URL and in any deployed function URL — but it does partially de-anonymize the project. It is safe to commit. What `config.toml` does not contain: API keys, service role key, JWT secret. Those never appear in any Supabase CLI-generated file.

**Action:** Verify after `supabase init` that `config.toml` contains only `project_id` and local dev port config. If any key-shaped strings appear (they should not), do not commit the file.

### R5 — GitHub Actions if added later

This project has no CI in Phase 1, but the tutorial will likely prompt readers to add it. The README should warn: if GitHub Actions are added, secrets must be stored in Settings → Secrets and variables → Actions, never in workflow YAML files or environment files committed to the repo.

### R6 — OpenRouter key scope

The `OPENROUTER_API_KEY` has access to all models on the account. If leaked, an attacker can run expensive models against the account balance. OpenRouter does not currently support scoped API keys (read-only, model-restricted, etc.).

**Mitigation:** Set a spending limit in the OpenRouter dashboard. The README should instruct readers to do this immediately after creating their key. A limit of $5–10/month is sufficient for this use case and bounds the blast radius of a leaked key.

### R7 — Telegram bot token scope

A leaked `TELEGRAM_BOT_TOKEN` gives an attacker full control of the bot: they can read all messages sent to it (past webhook deliveries are not replayed, but future ones are), send messages to any chat the bot is in, and change the webhook endpoint to redirect all traffic. Rotation requires deleting and recreating the bot via BotFather.

**Mitigation:** Keep this key in Supabase secrets only. If it is ever suspected leaked, revoke it immediately via BotFather (`/revoke` command) and re-register the webhook with the new token.

### R8 — README warnings required for tutorial readers

The README must include a dedicated "Security" section that states:

1. Run `scripts/install-hooks.sh` before your first commit — this installs the gitleaks pre-commit hook.
2. `.env` is in `.gitignore`. Never remove it from `.gitignore`. Never commit a file containing real keys.
3. The service role key has unrestricted database access. Treat it like a root password.
4. Set a spending limit on your OpenRouter account before adding credit.
5. If you suspect any secret was committed or pushed, rotate it immediately — do not just delete the commit. Git history can be recovered.
6. GitHub secret scanning is enabled on this repo. Enable it on any fork.
