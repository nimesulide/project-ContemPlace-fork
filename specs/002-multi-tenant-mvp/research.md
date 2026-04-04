# Research: Multi-Tenant MVP

**Feature**: 002-multi-tenant-mvp
**Date**: 2026-03-29

## R1: Tenant Isolation Strategy

**Decision**: Row-level isolation via `user_id UUID` column on all 7 tables + RLS policies as defense-in-depth.

**Rationale**: Lowest migration complexity, shared DB billing, sufficient isolation for MVP. Schema-per-tenant is a clean upgrade path if zero-bleed guarantees are later required.

**Alternatives considered**:
- Schema-per-tenant: stronger isolation but medium complexity, unnecessary for MVP scale (~100 users).
- Supabase project per tenant: physical isolation but high complexity and per-project cost; only justified at enterprise tier.

**How it works**: Workers continue using `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). Every DB query adds explicit `WHERE user_id = $1`. RLS policies (`user_id = auth.uid()`) catch any query that accidentally omits the filter — defense-in-depth, not primary access control.

---

## R2: Authentication Provider

**Decision**: Supabase Auth (already in the stack) with email/password + Google + GitHub OAuth.

**Rationale**: Zero new infrastructure. Supabase Auth is built into every project. OAuth providers are dashboard-only configuration (enter Client ID/Secret, set redirect URI). The JWT issued by Supabase Auth carries `sub` (user UUID) used as `user_id` everywhere.

**Alternatives considered**:
- Custom auth: unnecessary complexity when Supabase Auth exists.
- Auth0/Clerk: external dependency, additional cost, integration overhead.

**Key details**:
- OAuth redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
- Frontend calls `supabase.auth.signInWithOAuth({ provider: 'google' })` — Supabase handles the entire flow.
- The trigger on `auth.users` insert fires for all sign-up methods (email, OAuth, magic link).

---

## R3: User Provisioning Trigger

**Decision**: Postgres trigger `AFTER INSERT ON auth.users` → `public.handle_new_user()` function (SECURITY DEFINER).

**Rationale**: Standard Supabase pattern. The trigger auto-provisions `user_profiles` + `capture_profiles` + generates MCP API key hash. No Worker code needed for provisioning — it happens at the DB level on every signup.

**Key details**:
- `SECURITY DEFINER` required so the function can write to `public` tables regardless of RLS.
- `NEW.id` is the UUID from `auth.users` → becomes `user_id` FK everywhere.
- `NEW.raw_user_meta_data` provides name/avatar from OAuth providers.
- The trigger must be idempotent — if it fails mid-execution, retrying must complete missing steps without duplicating existing rows.

**MCP API key generation within trigger**:
- Generate 32 random bytes via `gen_random_bytes(32)` → hex encode → prefix with `cp_`.
- Store SHA-256 hash in `user_profiles.mcp_api_key_hash`.
- The raw key must be returned to the user via the settings page (read once from a temporary store or generated on-demand via a separate endpoint).
- **Revised approach**: The trigger stores only the hash. The first-time key display happens via a one-time API call from the settings page that generates a new key, hashes it, stores the hash, and returns the raw key. This avoids storing raw keys anywhere.

---

## R4: JWT Validation in Cloudflare Workers

**Decision**: Use `jose` library for HS256 JWT verification with the Supabase JWT secret.

**Rationale**: Most Supabase projects default to HS256 (symmetric). `jose` uses Web Crypto API (no Node.js deps), runs natively in CF Workers. Avoids network call to JWKS endpoint on every request.

**Alternatives considered**:
- JWKS endpoint (`/.well-known/jwks.json`): requires caching logic and a network call; RS256 not the default.
- `@supabase/supabase-js` in Workers: too heavy; Workers already use service_role key, not the JS client.

**Implementation**:
```typescript
import { jwtVerify } from 'jose';
const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const { payload } = await jwtVerify(token, secret, {
  issuer: `https://<project-ref>.supabase.co/auth/v1`,
  audience: 'authenticated',
});
const userId = payload.sub; // UUID from auth.users
```

**New secret required**: `SUPABASE_JWT_SECRET` must be added to Dashboard API Worker and MCP Worker environments.

---

## R5: MCP API Key Pattern

**Decision**: Random hex string with prefix, SHA-256 hash stored in DB, raw key shown once.

**Rationale**: Industry-standard pattern (Stripe, GitHub, etc.). Simple, secure, revocable. No JWT revocation-list complexity.

**Alternatives considered**:
- JWT tokens: revocation-unfriendly for long-lived API keys.
- OAuth-only: too complex for MCP clients that just need a bearer token.

**Key details**:
- Format: `cp_<64 hex chars>` (32 bytes of randomness, prefixed for identifiability).
- Storage: SHA-256 hash in `user_profiles.mcp_api_key_hash`.
- Lookup: on request, `SHA-256(provided_key)` → DB lookup by hash → get `user_id`.
- Regeneration: new key generated, old hash replaced, old key invalidated immediately.
- Multiple keys per user deferred to post-MVP (single key sufficient for launch).

**Worker-side lookup flow**:
1. Extract Bearer token from Authorization header.
2. If token starts with `cp_`: SHA-256 hash it, look up `user_profiles` by `mcp_api_key_hash`.
3. If found: return `{ userId }` from the row.
4. If not `cp_` prefix: fall through to OAuth token resolution (existing flow).

---

## R6: Frontend Technology Stack

**Decision**: Next.js 14+ (App Router) + TypeScript + MUI v5 + Supabase Auth via `@supabase/ssr`. Deploy to Vercel.

**Rationale**: User explicitly requested React + TypeScript + MUI + minimalistic styling. Next.js provides routing and SSR. Vercel is the natural deployment target for Next.js (first-party support). The existing CF Pages dashboard is replaced entirely.

**Alternatives considered**:
- Extending existing vanilla JS SPA: incompatible with user's React/MUI requirement.
- Next.js on Cloudflare Pages: poor support (no SSR, no middleware, no API routes). Not viable.
- Vite + React Router: viable but loses SSR benefits and middleware-based auth protection.

**Minimal dependency list** (9 runtime + 3 dev):
- `next`, `react`, `react-dom`
- `@mui/material`, `@emotion/react`, `@emotion/styled`, `@emotion/cache`
- `@supabase/ssr`, `@supabase/supabase-js`
- Dev: `typescript`, `@types/react`, `@types/react-dom`

**Architecture**:
- Frontend on Vercel calls existing Dashboard API Worker on Cloudflare (no architectural change to API layer).
- Auth state managed by Supabase via cookies (middleware refreshes session on every request).
- Route protection via Next.js middleware: unauthenticated requests to `/app/*` redirect to `/login`.
- MUI ThemeProvider via a client-side `ThemeRegistry` component (MUI requires client components).
- Styling exclusively via MUI `sx` prop and theme — no CSS files, no Tailwind, no styled-components.

**Project location**: New `webapp/` directory at repo root (replaces `dashboard/` role but different tech).

---

## R7: Supabase Browser Client Role

**Decision**: Browser uses Supabase anon key for authentication only. All data access goes through Workers.

**Rationale**: Consistent with existing architecture — Workers are the single data access layer. Browser never touches DB directly. Anon key is safe to expose publicly.

**Flow**:
1. Browser: `createBrowserClient(url, anonKey)` for auth (signup, login, session).
2. Browser: gets user JWT from Supabase session.
3. Browser: sends JWT to Dashboard API Worker (or MCP Worker) in Authorization header.
4. Worker: validates JWT via `jose`, extracts `user_id`, queries DB with service_role key + `WHERE user_id`.

---

## R8: Dashboard API Auth Migration

**Decision**: Dashboard API Worker accepts Supabase Auth JWTs instead of static `DASHBOARD_API_KEY`. Keep static key as fallback for backward compatibility during migration.

**Rationale**: The web app sends the user's JWT. The Worker validates it and extracts `user_id`. Static key can be phased out after migration.

**New env vars**: `SUPABASE_JWT_SECRET` added to Dashboard API Worker.

**CORS update**: Add Vercel deployment URL to allowed origins alongside existing CF Pages origin.
