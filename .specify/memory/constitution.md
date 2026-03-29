<!--
SYNC IMPACT REPORT
==================
Version change: (unversioned template) → 1.0.0
This is the initial fill of the constitution from the blank template.

Modified principles: N/A (initial population)

Added sections:
  - Core Principles (I–VI)
  - Hard Technical Constraints
  - Development Workflow
  - Governance

Removed sections: N/A

Templates requiring updates:
  ✅ .specify/templates/plan-template.md — "Constitution Check" section already
     contains a generic gate placeholder; no ContemPlace-specific changes needed
     (gates are filled per-feature by /speckit.plan).
  ✅ .specify/templates/spec-template.md — structure is generic and compatible;
     no updates required.
  ✅ .specify/templates/tasks-template.md — task phases and conventions are
     compatible; no updates required.
  ✅ .specify/templates/agent-file-template.md — placeholder-only file; no
     ContemPlace-specific content needed at template level.

Follow-up TODOs:
  - None. All placeholders resolved from CLAUDE.md and project docs.
-->

# ContemPlace Constitution

## Core Principles

### I. Faithful Mirror (NON-NEGOTIABLE)

The capture agent is a transcriptionist, not a co-author. It MUST preserve the
user's meaning exactly as expressed — no hallucination, no contamination, no
inferred conclusions, no creative expansion.

- `notes.raw_input` MUST always be stored alongside LLM-generated fields; it is
  the irreplaceable source of truth.
- The `body` field is transcription, not synthesis. It MUST NOT add conclusions
  the user did not express.
- Traceability from every structured field back to raw input is non-negotiable.
- The system MUST NOT put inferred statements in the user's voice.

**Rationale**: Users trust ContemPlace as a faithful mirror of their thinking.
Any contamination of the knowledge graph with model-generated meaning breaks
the trust contract and corrupts the corpus permanently.

### II. Single Capture Path

All capture logic MUST live in `mcp/src/pipeline.ts`. This is the single source
of truth for every gateway — Telegram, MCP tool calls, and any future interface.

- The Telegram Worker MUST NOT implement independent capture logic; it delegates
  to the MCP Worker via Cloudflare Service Binding RPC.
- The `capture_note` MCP tool MUST call `pipeline.ts` directly.
- No parallel capture implementations are permitted.

**Rationale**: Diverging capture paths produce inconsistent enrichment, tags, and
embeddings. One path means one place to audit, fix, and improve quality.

### III. Async-First & Service Bindings

- The Telegram Worker MUST return HTTP 200 to Telegram before any processing.
  All capture work MUST run inside `ctx.waitUntil()`.
- Worker-to-Worker communication on the same Cloudflare zone MUST use Service
  Bindings (in-process RPC). HTTP calls between Workers on the same zone are
  forbidden (CF error 1042).
- The gardening pipeline MUST be triggered via `env.GARDENER_SERVICE.trigger()`
  — not via HTTP or scheduled-only paths.

**Rationale**: Telegram webhooks time out quickly. Blocking the response on
capture processing risks missed messages. Service Bindings are the only
reliable Worker-to-Worker communication mechanism within a zone.

### IV. Configuration Over Hardcoding (NON-NEGOTIABLE)

- Model identifiers (e.g., capture LLM, embedding model) MUST be read from env
  vars via the config modules. They MUST NOT be hardcoded at call sites.
- Similarity and clustering thresholds MUST be env vars, documented in the
  respective `wrangler.toml [vars]` sections.
- Stylistic and voice rules for the capture agent MUST be stored in the
  `capture_profiles` DB table, never in source code.
- The `SYSTEM_FRAME` constant in `mcp/src/capture.ts` is the only permitted
  hardcoded prompt content — it encodes structural contract only (JSON schema,
  field enums, link rules), not style.

**Rationale**: Behavioral changes (model upgrades, threshold tuning, voice
refinements) MUST be possible without code deployment. Hardcoded values make
A/B testing and incident recovery impossible at runtime.

### V. Validate Against Reality

- Unit tests are necessary but not sufficient to declare a feature done.
- Every non-trivial change MUST be deployed to the live stack and validated
  end-to-end (smoke tests + manual verification) before the PR is merged.
- The `scripts/deploy.sh` pipeline — schema → typecheck → unit tests → deploy
  all Workers → smoke tests — is the minimum validation gate.
- Live integration tests (`tests/smoke.test.ts`, `tests/mcp-smoke.test.ts`,
  `tests/gardener-integration.test.ts`) MUST pass before shipping.

**Rationale**: The V8 runtime, Service Binding RPC, and Cloudflare-specific
APIs produce failure modes that only manifest in real deployments. Mock-only
validation has repeatedly hidden production bugs.

### VI. Schema Stability

- The embedding dimension is fixed at **1536** — the default output of
  `text-embedding-3-small` with no `dimensions` parameter. This MUST NOT be
  changed without a full table rewrite and corpus re-embed plan.
- `<=>` (cosine distance) MUST be used for all pgvector similarity operations.
  `<->` (L2 distance) is forbidden. In RPC functions, use
  `OPERATOR(extensions.<=>)`.
- All RPC functions MUST be in the `public` schema with
  `set search_path = 'public, extensions'` and use explicit `public.table_name`
  references.
- The `source` field MUST always be set at insert; it MUST NOT be null.
- JSONB columns containing LLM-generated content MUST NOT be interpolated into
  raw SQL strings.

**Rationale**: The embedding dimension is a physical constraint of the pgvector
column. Changing it after data exists requires a destructive migration. The
operator and schema rules prevent silent correctness bugs in distance queries.

## Hard Technical Constraints

These constraints are architectural facts, not preferences. Violations require
an Architecture Decision Record in `docs/decisions.md` and a migration plan.

- **All AI calls** MUST route through OpenRouter at `https://openrouter.ai/api/v1`
  using the `openai` npm package with `baseURL` override. Direct calls to
  OpenAI, Anthropic, or other provider APIs are forbidden.
- **All DB access** MUST use `SUPABASE_SERVICE_ROLE_KEY`. The anon key MUST
  NOT be used in any Worker. All three Workers MUST validate at startup that
  the key is a service_role JWT.
- **Two-pass embedding**: The first embed uses raw text (for finding related
  notes); the second uses `buildEmbeddingInput()` with the LLM-generated body
  and tags (for storage). If the second embed fails, fall back to the raw
  embedding — a note MUST never be lost due to an embedding failure.
- **Supabase is database only** — no Edge Functions. All compute runs in
  Cloudflare Workers.
- **Object storage** for photo attachments uses Cloudflare R2 only.

## Development Workflow

- Open a GitHub Issue before starting significant work. Reference it with
  `refs #<n>` in commits.
- `main` MUST always be stable and deployable. Feature branches use
  `feat/<name>`, hotfixes `fix/<name>`, investigations `investigate/<name>`.
- Every non-trivial change MUST go through a PR with a test plan checklist.
- Commits MUST follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`.
- **Documentation is part of the deliverable.** A feature is not done until
  `docs/` reflects it. Architecture changes MUST update `docs/architecture.md`.
  Schema changes MUST update `docs/schema.md`. Decision rationale MUST be
  appended to `docs/decisions.md` (ADRs are immutable — append only).
- Before implementing non-trivial features, use Plan agents to evaluate design,
  surface edge cases, and flag architectural concerns.
- Semantic version tags are applied on `main` after meaningful milestones.

## Governance

This constitution supersedes all other development practices. When a practice
conflicts with a principle here, the principle wins — or an ADR is filed to
amend the constitution.

**Amendment procedure**:
1. Propose the change in a GitHub Issue or PR description.
2. Bump the version: MAJOR for principle removals/redefinitions, MINOR for new
   principles or materially expanded guidance, PATCH for clarifications.
3. Update `LAST_AMENDED_DATE` to the amendment date.
4. Run the consistency propagation checklist (templates + dependent docs).
5. File an ADR entry in `docs/decisions.md` if the change affects architecture
   or hard constraints.

**Compliance review**: All PRs must be checked against this constitution.
Complexity beyond what the task requires MUST be justified in the PR description.
Use `CLAUDE.md` for runtime development guidance in Claude Code sessions.

**Version**: 1.0.0 | **Ratified**: 2026-03-29 | **Last Amended**: 2026-03-29
