# Tasks: Multi-Tenant MVP

**Input**: Design documents from `/specs/002-multi-tenant-mvp/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. No test tasks are included (not requested in spec).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Add new dependencies and initialize the webapp project

- [x] T001 [P] Add `jose` dependency to MCP Worker in mcp/package.json
- [x] T002 [P] Add `jose` dependency to Dashboard API Worker in dashboard-api/package.json
- [x] T003 Initialize Next.js 14+ App Router project in webapp/ with TypeScript, React 18, MUI v5 (`@mui/material`, `@emotion/react`, `@emotion/styled`, `@emotion/cache`), `@supabase/ssr`, `@supabase/supabase-js`
- [x] T004 Configure MUI dark minimalistic theme in webapp/src/theme.ts and ThemeRegistry client component in webapp/src/components/ThemeRegistry.tsx
- [x] T005 Create Supabase client helpers: browser client in webapp/src/lib/supabase/client.ts, server client in webapp/src/lib/supabase/server.ts, middleware client in webapp/src/lib/supabase/middleware.ts
- [x] T006 Create Dashboard API fetch wrapper with JWT auth header in webapp/src/lib/api.ts
- [x] T007 Create webapp/.env.local template with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_URL

---

## Phase 2: Foundational (DB Migration + Provisioning)

**Purpose**: Multi-tenant schema, RLS, and provisioning trigger. MUST complete before any user story work.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T008 Create migration supabase/migrations/YYYYMMDDHHMMSS_user_tables.sql: create `user_profiles` table (user_id UUID PK FK→auth.users ON DELETE CASCADE, display_name TEXT NULL, mcp_api_key_hash TEXT NULL UNIQUE, plan TEXT NOT NULL DEFAULT 'free', created_at TIMESTAMPTZ), `telegram_connections` table (id UUID PK, user_id UUID FK, chat_id BIGINT NOT NULL UNIQUE, connected_at TIMESTAMPTZ), `telegram_link_tokens` table (token TEXT PK, user_id UUID FK, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ)
- [x] T009 Create migration supabase/migrations/YYYYMMDDHHMMSS_multi_tenant.sql: add `user_id UUID` (nullable) to all 7 existing tables (notes, links, clusters, enrichment_log, capture_profiles, processed_updates, entity_dictionary), backfill with founder user ID, set NOT NULL, add FK constraints ON DELETE CASCADE, add indexes (notes_user_created_idx, clusters_user_resolution_idx), change capture_profiles UNIQUE from (name) to (user_id, name), change entity_dictionary UNIQUE from (name, type) to (user_id, name, type)
- [x] T010 Create migration supabase/migrations/YYYYMMDDHHMMSS_rpc_user_scope.sql: update `match_notes` RPC to add `p_user_id UUID` parameter with `AND n.user_id = p_user_id` in WHERE clause; update `find_similar_pairs` RPC to add `p_user_id UUID` parameter with `WHERE a.user_id = p_user_id AND b.user_id = p_user_id`
- [x] T011 Create migration supabase/migrations/YYYYMMDDHHMMSS_rls_policies.sql: replace all deny-all RLS policies with `user_id = auth.uid()` policies for SELECT/INSERT/UPDATE/DELETE on all tables with user_id; add SELECT-only RLS for user_profiles
- [x] T012 Create migration supabase/migrations/YYYYMMDDHHMMSS_provisioning.sql: create `handle_new_user()` SECURITY DEFINER function that inserts into user_profiles (user_id, display_name from raw_user_meta_data) and capture_profiles (user_id, name='default', capture_voice=system default); create AFTER INSERT trigger on auth.users; make function idempotent (ON CONFLICT DO NOTHING)

**Checkpoint**: Database is multi-tenant. Existing data attributed to founder user. RLS active. Provisioning trigger functional.

---

## Phase 3: User Story 1 — New User Signs Up and Captures First Note (P1) 🎯 MVP

**Goal**: A new user signs up, captures a thought via the web form, and sees the structured note in their dashboard. Data is fully isolated.

**Independent Test**: Sign up with email → submit text in capture form → verify structured note (title, body, tags) appears in dashboard → sign up a second user → verify zero cross-user visibility.

### MCP Worker — User Identity Threading

- [x] T013 [US1] Update MCP Worker auth to support `cp_` prefixed API keys: SHA-256 hash the token, look up `user_profiles.mcp_api_key_hash`, return `{ userId }` in mcp/src/auth.ts
- [x] T014 [US1] Update `resolveExternalToken` in mcp/src/index.ts to return real `userId` from user session instead of hardcoded `'static-key'`
- [x] T015 [US1] Add `userId: string` parameter to all functions in mcp/src/db.ts and add `.eq('user_id', userId)` to every Supabase query; update `match_notes` RPC call to pass `p_user_id`
- [x] T016 [US1] Update `runCapturePipeline` in mcp/src/pipeline.ts to accept `userId` parameter and pass it to all db function calls
- [x] T017 [US1] Update `CaptureService.capture()` and `CaptureService.undoLatest()` in mcp/src/index.ts to accept `userId` in options and pass through to pipeline
- [x] T018 [US1] Update all tool handlers in mcp/src/tools.ts to receive `userId` from auth resolution and pass to all db calls
- [x] T019 [US1] Add `SUPABASE_JWT_SECRET` to MCP Worker config in mcp/src/config.ts; update mcp/src/types.ts with userId on CaptureOptions and all relevant interfaces
- [x] T020 [US1] Update existing MCP Worker unit tests in tests/mcp-*.test.ts to pass `userId` parameter to all db and tool handler calls

### Dashboard API — JWT Auth

- [x] T021 [US1] Create JWT validation module in dashboard-api/src/auth.ts: validate Supabase JWT via `jose` (HS256, SUPABASE_JWT_SECRET), extract userId from `payload.sub`, return 401/403 on failure
- [x] T022 [US1] Replace static `DASHBOARD_API_KEY` validation with JWT auth in dashboard-api/src/index.ts; add `SUPABASE_JWT_SECRET` to config; keep static key as temporary fallback
- [x] T023 [US1] Add `userId` parameter to all route handlers and DB queries in dashboard-api/src/routes.ts; add `.eq('user_id', userId)` to all Supabase queries; update stats/clusters/recent to be user-scoped
- [x] T024 [P] [US1] Update `CORS_ORIGIN` handling in dashboard-api/wrangler.toml to accept Vercel deployment URL alongside existing CF Pages origin; add `CAPTURE_SERVICE` Service Binding to MCP Worker in dashboard-api/wrangler.toml
- [x] T024a [US1] Add POST /capture route in dashboard-api/src/routes.ts: accept `{ text, source }` body, call `env.CAPTURE_SERVICE.capture(text, 'web', { userId })` via Service Binding, return structured note response; update dashboard-api/src/types.ts with CaptureServiceStub interface

### Web App — Auth & Capture

- [x] T025 [US1] Create Next.js middleware for route protection in webapp/middleware.ts: redirect unauthenticated requests to `/app/*` → `/login`; refresh Supabase session on every request
- [x] T026 [US1] Create root layout in webapp/src/app/layout.tsx with ThemeRegistry and metadata
- [x] T027 [US1] Create landing page in webapp/src/app/page.tsx with sign-in/sign-up links
- [x] T028 [P] [US1] Create login page in webapp/src/app/login/page.tsx with email/password form and Google/GitHub OAuth buttons using Supabase Auth
- [x] T029 [P] [US1] Create signup page in webapp/src/app/signup/page.tsx with email/password form and Google/GitHub OAuth buttons using Supabase Auth
- [x] T030 [US1] Create OAuth callback handler in webapp/src/app/auth/callback/route.ts to exchange auth code for session
- [x] T031 [US1] Create authenticated app shell in webapp/src/app/app/layout.tsx with AppShell component (nav bar, sidebar) in webapp/src/components/AppShell.tsx
- [x] T032 [US1] Create capture form page in webapp/src/app/app/capture/page.tsx and CaptureForm component in webapp/src/components/CaptureForm.tsx: textarea → POST to Dashboard API `/capture` endpoint (which delegates to MCP Worker via Service Binding, preserving Single Capture Path) → display returned title + body + tags; set source='web'; on 401 response, preserve textarea content and redirect to login
- [x] T033 [US1] Create dashboard page in webapp/src/app/app/dashboard/page.tsx with StatsPanel (webapp/src/components/StatsPanel.tsx) and RecentPanel (webapp/src/components/RecentPanel.tsx) showing user-scoped stats and recent notes

**Checkpoint**: Full signup → capture → dashboard flow works. Two users see only their own data. MVP is functional.

---

## Phase 4: User Story 2 — User Connects MCP Client with Personal API Key (P1)

**Goal**: A user views their MCP endpoint URL and API key in settings, copies them into an MCP client, and uses MCP tools scoped to their data.

**Independent Test**: Navigate to settings → generate API key → copy key + endpoint → configure MCP client → call `search_notes` → verify only own notes returned. Regenerate key → verify old key rejected.

- [x] T034 [US2] Add POST /settings/regenerate-key endpoint in dashboard-api/src/routes.ts: generate `cp_<64 hex>` key, SHA-256 hash it, store hash in user_profiles.mcp_api_key_hash, return raw key once
- [x] T035 [US2] Add GET /settings/profile endpoint in dashboard-api/src/routes.ts: return user_id, display_name, email, plan, has_api_key boolean, mcp_endpoint URL, telegram_connected status, created_at
- [x] T036 [US2] Create settings page in webapp/src/app/app/settings/page.tsx and SettingsPanel component in webapp/src/components/SettingsPanel.tsx: display MCP endpoint URL, masked API key with copy button, regenerate key button with confirmation dialog

**Checkpoint**: User can configure any MCP client with their personal endpoint and key. Key regeneration invalidates old key immediately.

---

## Phase 5: User Story 3 — User Views Personal Dashboard with Clusters (P2)

**Goal**: A user with captured notes sees topic clusters generated by the gardening pipeline running only on their data.

**Independent Test**: Capture 10+ notes on varied topics → trigger gardening → verify dashboard shows clusters with titles derived only from own notes. Second user's notes never appear.

### Gardener — Per-User

- [x] T037 [US3] Add `userId: string` parameter to all functions in gardener/src/db.ts; add `.eq('user_id', userId)` to all queries; update `find_similar_pairs` RPC call to pass `p_user_id`
- [x] T038 [US3] Update `runGardener()` in gardener/src/index.ts to iterate over active users: query distinct user_id from notes, process each user sequentially, wrap per-user execution in try/catch for error isolation
- [x] T039 [US3] Update gardener/src/clustering.ts to pass userId for all scoped cluster operations (delete/insert)
- [x] T040 [US3] Update GardenerService.trigger() in gardener/src/index.ts to accept optional userId parameter — when provided, run gardening for that user only; when omitted (cron), iterate all users
- [x] T041 [US3] Update existing gardener tests in tests/gardener-*.test.ts to pass userId parameter

### Web App — Clusters Panel

- [x] T042 [US3] Create ClustersPanel component in webapp/src/components/ClustersPanel.tsx: fetch clusters from Dashboard API GET /clusters, display cluster titles + note counts + top tags; add to dashboard page in webapp/src/app/app/dashboard/page.tsx

**Checkpoint**: Gardener runs per-user. Dashboard shows user-specific clusters. No cross-user cluster contamination.

---

## Phase 6: User Story 4 — Existing User Connects Telegram for Mobile Capture (P2)

**Goal**: A user connects their Telegram account from web app settings and captures notes via the Telegram bot, attributed to their account.

**Independent Test**: Click "Connect Telegram" in settings → open deep link → send `/start <token>` to bot → receive confirmation → send a message → verify note appears in web dashboard under own account.

### Telegram Worker — Multi-User

- [ ] T043 [US4] Add Supabase client and `telegram_connections` lookup function in src/db.ts: query by chat_id → return user_id or null
- [ ] T044 [US4] Replace `ALLOWED_CHAT_IDS` whitelist check with `telegram_connections` DB lookup in src/index.ts; if chat not found, reply with "Connect via web app settings" message
- [ ] T045 [US4] Update `/start` command handler in src/index.ts: parse deep link token from payload, validate against `telegram_link_tokens` table (check expiry), insert `telegram_connections` row, delete used token, reply with confirmation; handle expired/invalid tokens with error message
- [ ] T046 [US4] Pass `userId` from telegram_connections lookup to `env.CAPTURE_SERVICE.capture()` call in src/index.ts
- [ ] T047 [US4] Remove `ALLOWED_CHAT_IDS` parsing from src/config.ts and env var from wrangler.toml; update src/types.ts CaptureServiceStub with userId in options

### Dashboard API — Telegram Endpoints

- [ ] T048 [US4] Add POST /settings/telegram-link endpoint in dashboard-api/src/routes.ts: generate random token, insert into telegram_link_tokens with 15-min expiry, return deep link URL `https://t.me/ContemPlaceBot?start=<token>`
- [ ] T049 [US4] Add DELETE /settings/telegram endpoint in dashboard-api/src/routes.ts: delete telegram_connections row for authenticated user, return 204

### Web App — Telegram Settings

- [ ] T050 [US4] Add Telegram connection UI to SettingsPanel in webapp/src/components/SettingsPanel.tsx: "Connect Telegram" button (calls POST /settings/telegram-link, displays deep link), connection status, "Disconnect" button (calls DELETE /settings/telegram)

**Checkpoint**: Telegram bot resolves users from DB. Deep link connection flow works end-to-end. Messages from connected chats create notes under the correct user.

---

## Phase 7: User Story 5 — User Exports All Their Data (P3)

**Goal**: A user downloads all their notes and metadata as a portable JSON file.

**Independent Test**: Capture several notes → click "Export" in settings → verify downloaded JSON contains all notes with titles, bodies, tags, raw_input, creation dates, links, and clusters.

- [ ] T051 [US5] Add GET /export endpoint in dashboard-api/src/routes.ts: query all user-scoped notes with bodies, tags, raw_input, entities, links (joined), and clusters; return JSON per contract (exported_at, user_id, notes[], clusters[])
- [ ] T052 [US5] Add export button to SettingsPanel in webapp/src/components/SettingsPanel.tsx: call GET /export, trigger browser download of JSON file

**Checkpoint**: User can export their complete dataset as portable JSON at any time.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Hardening, documentation, and deployment updates

- [ ] T053 [P] Update docs/architecture.md with multi-tenant data flow, webapp architecture, and Vercel deployment
- [ ] T054 [P] Update docs/schema.md with new tables (user_profiles, telegram_connections, telegram_link_tokens), user_id columns, updated RPC signatures, and RLS policies
- [ ] T055 [P] Update docs/setup.md with new environment variables (SUPABASE_JWT_SECRET, webapp env vars), OAuth provider setup, and Vercel deployment instructions
- [ ] T056 Update scripts/deploy.sh to include webapp build/deploy step (Vercel) and new Worker secrets
- [ ] T057 Update docs/development.md with webapp dev commands, new test commands, and updated project layout
- [ ] T058 Add new ADR entry in docs/decisions.md for multi-tenant architecture choice (row-level isolation, Next.js frontend, Vercel deployment)
- [ ] T059 Remove static `DASHBOARD_API_KEY` fallback auth from dashboard-api/src/index.ts and dashboard-api/src/auth.ts; remove `DASHBOARD_API_KEY` from dashboard-api/wrangler.toml and Worker secrets
- [ ] T060 Run quickstart.md validation: execute each step's validation criteria against deployed system

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — delivers MVP
- **US2 (Phase 4)**: Depends on US1 (needs auth + settings page foundation)
- **US3 (Phase 5)**: Depends on Foundational (gardener changes); dashboard panels depend on US1 (webapp exists)
- **US4 (Phase 6)**: Depends on Foundational; Telegram settings UI depends on US2 (settings page exists)
- **US5 (Phase 7)**: Depends on Foundational; export UI depends on US2 (settings page exists)
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Foundational: DB Migration + Provisioning) ← US6 lives here
    ↓
Phase 3 (US1: Signup + Capture) ← MVP milestone
    ↓
Phase 4 (US2: MCP API Key) ← settings page created here
    ↓ ↘
    ↓   Phase 5 (US3: Dashboard + Clusters) ← can parallel with US4/US5
    ↓ ↗
Phase 6 (US4: Telegram) ← needs settings page from US2
Phase 7 (US5: Export) ← needs settings page from US2
    ↓
Phase 8 (Polish)
```

### Parallel Opportunities Within Phases

**Phase 1**: T001 ‖ T002 (jose deps are independent); T004-T007 can parallel after T003

**Phase 2**: T008-T012 are sequential (migration order matters)

**Phase 3**:
- MCP Worker tasks (T013-T020) can run in parallel with Dashboard API tasks (T021-T024)
- Web app auth tasks (T025-T031) can start once api.ts wrapper exists (T006)
- T028 ‖ T029 (login and signup pages are independent)
- T032-T033 depend on auth + shell being ready

**Phase 5**: Gardener tasks (T037-T041) can run in parallel with webapp panel (T042) if dashboard page exists

**Phase 6**: Telegram Worker tasks (T043-T047) can run in parallel with Dashboard API tasks (T048-T049)

**Phase 8**: T053 ‖ T054 ‖ T055 (independent doc updates)

---

## Parallel Example: Phase 3 (US1)

```bash
# Stream 1: MCP Worker identity threading
Task T013: "Update auth.ts with cp_ key lookup"
Task T014: "Update resolveExternalToken in index.ts"
Task T015: "Add userId to all db.ts functions"
Task T016: "Update pipeline.ts with userId"
Task T017: "Update CaptureService in index.ts"
Task T018: "Update tool handlers in tools.ts"

# Stream 2 (parallel with Stream 1): Dashboard API JWT
Task T021: "Create JWT auth module in auth.ts"
Task T022: "Replace static key auth in index.ts"
Task T023: "Add userId to route handlers"

# Stream 3 (parallel with Streams 1+2): Web App auth pages
Task T028: "Create login page"
Task T029: "Create signup page"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (DB migration + provisioning trigger)
3. Complete Phase 3: US1 (signup → capture → dashboard)
4. **STOP and VALIDATE**: Two users can sign up, capture notes, and see only their own data
5. Deploy and demo — this is the MVP

### Incremental Delivery

1. Setup + Foundational → Database is multi-tenant
2. US1 → Signup + capture works → Deploy (MVP!)
3. US2 → MCP key in settings → Deploy (MCP clients work)
4. US3 → Clusters in dashboard → Deploy (gardener is per-user)
5. US4 → Telegram connected → Deploy (existing users migrated)
6. US5 → Export available → Deploy (data portability promise fulfilled)
7. Polish → Docs + hardening → Final release

### Notes

- US6 (Automated Provisioning) is implemented in Phase 2 as the DB trigger — it has no standalone UI tasks
- The `dashboard/` vanilla JS SPA remains functional throughout — it can be decommissioned after webapp is fully deployed
- Static `DASHBOARD_API_KEY` fallback is kept during migration (T022) and removed in Polish phase
