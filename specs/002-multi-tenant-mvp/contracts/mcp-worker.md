# API Contract: MCP Worker (Multi-Tenant)

**Feature**: 002-multi-tenant-mvp
**Date**: 2026-03-29

## Authentication Changes

### Current Flow
1. Bearer token → check against static `MCP_API_KEY` (constant-time compare).
2. OAuth 2.1 flow → token stored in KV → `resolveExternalToken` returns `{ userId: 'static-key' }`.

### New Flow
1. Bearer token with `cp_` prefix → SHA-256 hash → DB lookup in `user_profiles.mcp_api_key_hash` → return `{ userId: <user_id> }`.
2. Bearer token without `cp_` prefix → OAuth token resolution (existing flow, but now returns real `userId` from user session).
3. OAuth 2.1 flow → consent page associates user identity → `resolveExternalToken` returns `{ userId: <real_user_id> }`.

### Identity Threading

Every tool handler receives `userId` from auth resolution. This flows to every `db.ts` function.

**Before**: `handleSearchNotes(args, db, openai, config)`
**After**: `handleSearchNotes(args, db, openai, config, userId)`

Every Supabase query adds `.eq('user_id', userId)`.

---

## MCP Tool Changes

All existing tools unchanged in their external interface (parameters and response shape). Internal change: all queries scoped by `userId`.

### capture_note

No parameter changes. `source` field now includes `'web'` as a valid value (in addition to `'telegram'` and `'mcp'`).

### search_notes

No changes. Results scoped to user.

### get_note

No changes. Returns 404 if note belongs to another user.

### list_recent

No changes. Returns only user's notes.

### get_related

No changes. Related notes scoped to user.

### remove_note

No changes. Can only archive user's own notes.

### list_clusters

No changes. Returns only user's clusters.

### trigger_gardening

Now triggers gardening for the authenticated user only (passes `userId` to gardener).

---

## CaptureService RPC Changes

### capture(text, source, options)

**New parameter added to options**:
```typescript
interface CaptureOptions {
  imageUrl?: string;
  userId: string;  // NEW — required
}
```

The Telegram Worker must resolve `userId` from `telegram_connections` lookup before calling `env.CAPTURE_SERVICE.capture()`.

### undoLatest(source)

**New parameter**:
```typescript
undoLatest(source: string, userId: string): Promise<UndoResult>
```

Only undoes the most recent note from the specified source for the specified user.
