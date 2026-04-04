# Implementation Plan: Multi-Tenant MVP

**Branch**: `002-multi-tenant-mvp` | **Date**: 2026-03-29 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-multi-tenant-mvp/spec.md`

## Summary

Transform ContemPlace from a single-tenant system to a multi-tenant platform using row-level isolation (`user_id` + RLS). Add Supabase Auth (email/password + Google + GitHub OAuth), thread user identity through all 4 Workers, scope the gardening pipeline per-user, replace the vanilla JS dashboard with a Next.js + MUI web app (deployed to Vercel), and convert the Telegram bot from static chat ID whitelist to DB-backed multi-user lookup.

## Technical Context

**Language/Version**: TypeScript 5.x (Workers), TypeScript 5.x + React 18 (webapp)
**Primary Dependencies**: Cloudflare Workers SDK, `openai` (OpenRouter), `jose` (JWT), Next.js 14+, MUI v5, `@supabase/ssr`
**Storage**: Supabase (Postgres 16 + pgvector), Cloudflare R2 (images)
**Testing**: Vitest (unit + integration + smoke), manual E2E
**Target Platform**: Cloudflare Workers (API), Vercel (webapp)
**Project Type**: Web service (API) + web application (frontend)
**Performance Goals**: 100 concurrent users, capture < 5s, search < 2s
**Constraints**: CF Worker CPU limits (50 subrequests/invocation), 1536-dim embeddings (fixed), all AI via OpenRouter
**Scale/Scope**: ~100 users MVP, 7 tables migrated, 4 Workers updated, 1 new frontend app

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Pre-Phase 0 | Post-Phase 1 | Notes |
|-----------|-------------|--------------|-------|
| I. Faithful Mirror | PASS | PASS | Capture pipeline behavior unchanged; only user scoping added |
| II. Single Capture Path | PASS | PASS | Web capture uses same `pipeline.ts` via MCP Worker; no parallel paths |
| III. Async-First & Service Bindings | PASS | PASS | Telegram Worker still returns 200 first; Service Bindings preserved |
| IV. Configuration Over Hardcoding | PASS | PASS | No new hardcoded values; auth config via env vars |
| V. Validate Against Reality | PASS | PASS | Quickstart includes live validation at each step |
| VI. Schema Stability | PASS | PASS | Embedding dimension unchanged; cosine operator unchanged; additive schema changes only |

No violations. No complexity justification needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-multi-tenant-mvp/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: technical research
├── data-model.md        # Phase 1: schema changes
├── quickstart.md        # Phase 1: implementation guide
├── contracts/
│   ├── dashboard-api.md # Dashboard API contract changes
│   ├── mcp-worker.md    # MCP Worker contract changes
│   └── telegram-worker.md # Telegram Worker contract changes
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
# Existing (modified)
src/
├── index.ts             # Telegram Worker — replace ALLOWED_CHAT_IDS with DB lookup
├── config.ts            # Remove ALLOWED_CHAT_IDS parsing
├── db.ts                # Add telegram_connections lookup
└── types.ts             # Update CaptureServiceStub with userId

mcp/
├── src/
│   ├── index.ts         # Update CaptureService with userId, update resolveExternalToken
│   ├── pipeline.ts      # Add userId parameter, pass to all DB calls
│   ├── auth.ts          # Add per-user API key lookup (SHA-256 hash → user_profiles)
│   ├── tools.ts         # Add userId to all handler signatures and DB calls
│   ├── db.ts            # Add userId parameter to all functions, add .eq('user_id', userId)
│   ├── config.ts        # Add SUPABASE_JWT_SECRET
│   └── types.ts         # Update interfaces with userId
└── wrangler.toml        # No changes (secrets added via wrangler secret put)

gardener/
├── src/
│   ├── index.ts         # Add per-user iteration loop in runGardener()
│   ├── db.ts            # Add userId to all functions, scope queries
│   ├── clustering.ts    # Pass userId for scoped cluster operations
│   ├── cluster-titles.ts # No changes (receives pre-scoped data)
│   ├── entities.ts      # No changes (receives pre-scoped data)
│   └── config.ts        # No changes
└── wrangler.toml        # No changes

dashboard-api/
├── src/
│   ├── index.ts         # Replace static key auth with JWT validation
│   ├── auth.ts          # Add JWT validation via jose, extract userId
│   ├── routes.ts        # Add userId to all queries; add /capture, /export, /settings/* routes
│   └── types.ts         # Update with userId, new response types
└── wrangler.toml        # Add CORS_ORIGIN for Vercel, add CAPTURE_SERVICE Service Binding to MCP Worker

supabase/
└── migrations/
    ├── YYYYMMDDHHMMSS_multi_tenant.sql    # user_id columns, backfill, indexes
    ├── YYYYMMDDHHMMSS_user_tables.sql     # user_profiles, telegram_connections, link_tokens
    ├── YYYYMMDDHHMMSS_rpc_user_scope.sql  # Update match_notes, find_similar_pairs
    ├── YYYYMMDDHHMMSS_rls_policies.sql    # Replace deny-all with user-scoped policies
    └── YYYYMMDDHHMMSS_provisioning.sql    # handle_new_user() trigger

tests/
├── # Existing tests updated with userId parameters
└── # New tests for multi-tenant isolation, JWT auth, Telegram connection flow

# New
webapp/
├── next.config.ts
├── package.json
├── tsconfig.json
├── middleware.ts                    # Route protection (Supabase auth)
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root: ThemeRegistry, metadata
│   │   ├── page.tsx                # Landing page (/)
│   │   ├── login/
│   │   │   └── page.tsx
│   │   ├── signup/
│   │   │   └── page.tsx
│   │   ├── auth/
│   │   │   └── callback/
│   │   │       └── route.ts        # OAuth callback
│   │   └── app/
│   │       ├── layout.tsx          # Authenticated shell (nav, sidebar)
│   │       ├── dashboard/
│   │       │   └── page.tsx        # Stats, clusters, recent
│   │       ├── capture/
│   │       │   └── page.tsx        # Capture form
│   │       └── settings/
│   │           └── page.tsx        # MCP key, Telegram, export
│   ├── components/
│   │   ├── ThemeRegistry.tsx       # MUI + Emotion provider
│   │   ├── AppShell.tsx            # Nav bar, sidebar
│   │   ├── CaptureForm.tsx
│   │   ├── StatsPanel.tsx
│   │   ├── ClustersPanel.tsx
│   │   ├── RecentPanel.tsx
│   │   └── SettingsPanel.tsx
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts           # Browser Supabase client
│   │   │   ├── server.ts           # Server Supabase client
│   │   │   └── middleware.ts       # Middleware Supabase client
│   │   └── api.ts                  # Dashboard API fetch wrapper
│   └── theme.ts                    # MUI dark theme, minimalistic
└── .env.local                      # NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_URL
```

**Structure Decision**: The existing multi-Worker architecture is preserved. A new `webapp/` directory is added at repo root for the Next.js frontend (replacing the `dashboard/` vanilla JS SPA's role). The `dashboard/` directory remains for backward compatibility until the webapp is fully deployed.

## Complexity Tracking

No constitution violations to justify.
