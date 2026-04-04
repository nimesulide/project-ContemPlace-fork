# Quickstart: Multi-Tenant MVP

**Feature**: 002-multi-tenant-mvp
**Date**: 2026-03-29

## Prerequisites

- Existing ContemPlace deployment (all 4 Workers + Supabase DB)
- Supabase project with Auth enabled
- Google Cloud Console OAuth credentials (for Google sign-in)
- GitHub Developer OAuth App (for GitHub sign-in)
- Vercel account (for web app deployment)
- Node.js 18+, npm

## Implementation Order

### Step 1: DB Migration

Apply the multi-tenant migration:
1. Create `user_profiles`, `telegram_connections`, `telegram_link_tokens` tables.
2. Create founder user in `auth.users` (via Supabase SQL editor or Auth API).
3. Add `user_id` column to all 7 existing tables, backfill with founder user ID, set NOT NULL.
4. Update `match_notes` and `find_similar_pairs` RPC functions with `p_user_id` parameter.
5. Replace `deny all` RLS policies with `user_id = auth.uid()` policies.
6. Create `handle_new_user()` trigger.

**Validate**: Run existing unit tests — they should still pass (service_role bypasses RLS). Smoke tests may need `user_id` parameter updates.

### Step 2: MCP Worker — User Identity Threading

1. Add `jose` dependency for JWT validation.
2. Update `resolveExternalToken` to look up `cp_` prefixed keys in `user_profiles`.
3. Add `userId` parameter to all `db.ts` functions.
4. Add `.eq('user_id', userId)` to all Supabase queries.
5. Update `pipeline.ts` to accept and pass `userId`.
6. Update `CaptureService.capture()` to accept `userId` in options.

**Validate**: MCP smoke tests with a real API key. Verify cross-user isolation.

### Step 3: Gardener — Per-User

1. Update `find_similar_pairs` call to pass `p_user_id`.
2. Add user iteration loop: fetch distinct `user_id` from notes, process each.
3. Scope all cluster/entity operations per user.
4. Add error isolation: catch per-user errors, continue to next user.

**Validate**: Gardener integration test. Verify clusters don't mix users.

### Step 4: Dashboard API — JWT Auth

1. Add `jose` dependency.
2. Add `SUPABASE_JWT_SECRET` to Worker secrets.
3. Replace static `DASHBOARD_API_KEY` validation with JWT validation (keep static key as temporary fallback).
4. Extract `user_id` from JWT payload, pass to all DB queries.
5. Add `CAPTURE_SERVICE` Service Binding to MCP Worker in `dashboard-api/wrangler.toml`.
6. Add `POST /capture` endpoint: delegates to MCP Worker via Service Binding (`env.CAPTURE_SERVICE.capture()`).
7. Add new endpoints: `/export`, `/settings/*`.

**Validate**: Smoke tests with real JWT. Verify `POST /capture` returns structured note.

### Step 5: Telegram Worker — Multi-User

1. Replace `ALLOWED_CHAT_IDS` check with `telegram_connections` DB lookup.
2. Update `/start` command to handle deep link tokens.
3. Pass `userId` to `CaptureService.capture()`.

**Validate**: Connect a Telegram account via manual token insertion, send a message, verify capture.

### Step 6: Web App (Next.js)

1. Initialize Next.js project in `webapp/` directory.
2. Configure MUI theme (dark, minimalistic).
3. Implement auth pages (login, signup) with Supabase Auth.
4. Implement middleware for route protection.
5. Build capture form page.
6. Port dashboard panels (stats, clusters, recent) as React components.
7. Build settings page (MCP key, Telegram connection, export).

**Validate**: Full end-to-end: signup → capture → dashboard → MCP key → export.

### Step 7: Deploy

1. Run DB migration on production Supabase.
2. Deploy all 4 Workers with updated code.
3. Enable Google + GitHub OAuth in Supabase dashboard.
4. Deploy web app to Vercel.
5. Run full smoke test suite.

## New Environment Variables

| Worker | Variable | Source |
|--------|----------|--------|
| MCP Worker | `SUPABASE_JWT_SECRET` | Supabase Dashboard > Settings > API |
| Dashboard API | `SUPABASE_JWT_SECRET` | Same |
| Dashboard API | `CORS_ORIGIN` (updated) | Add Vercel URL |
| Web App (Vercel) | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| Web App (Vercel) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| Web App (Vercel) | `NEXT_PUBLIC_API_URL` | Dashboard API Worker URL |

## New Dependencies

| Package | Where | Purpose |
|---------|-------|---------|
| `jose` | MCP Worker, Dashboard API Worker | JWT validation |
| `next` | webapp/ | React framework |
| `react`, `react-dom` | webapp/ | UI library |
| `@mui/material` | webapp/ | Component library |
| `@emotion/react`, `@emotion/styled`, `@emotion/cache` | webapp/ | MUI styling engine |
| `@supabase/ssr`, `@supabase/supabase-js` | webapp/ | Auth client |
| `typescript` | webapp/ (dev) | Type safety |
