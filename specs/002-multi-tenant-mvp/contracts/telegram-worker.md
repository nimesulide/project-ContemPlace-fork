# API Contract: Telegram Worker (Multi-Tenant)

**Feature**: 002-multi-tenant-mvp
**Date**: 2026-03-29

## User Resolution Change

### Current
- Extract `chatId` from `message.chat.id`.
- Check against `ALLOWED_CHAT_IDS` env var whitelist.
- If allowed → capture via Service Binding (no user identity passed).

### New
- Extract `chatId` from `message.chat.id`.
- Look up `telegram_connections` table by `chat_id` → get `user_id`.
- If found → capture via Service Binding with `userId` in options.
- If not found → reply with connection instructions.

### Removed
- `ALLOWED_CHAT_IDS` env var removed entirely.
- Direct Supabase client needed in Telegram Worker for `telegram_connections` lookup (already has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`).

---

## /start Command Change

### Current
- Replies with a welcome message.

### New
- `/start` (no payload): Reply with connection instructions (visit web app settings).
- `/start <token>`: Look up `telegram_link_tokens` by token → validate not expired → insert `telegram_connections` row → delete token → reply with confirmation.
- `/start <token>` with expired/invalid token: Reply with error and instructions to generate a new link.

---

## Message Flow (Updated)

```
Incoming message
  → Verify webhook secret
  → Extract chatId
  → DB lookup: telegram_connections WHERE chat_id = chatId
  → If not found: reply "Connect via web app settings"
  → If found: get userId
  → Dedup check (tryClaimUpdate)
  → Return 200
  → ctx.waitUntil():
      → typing indicator
      → if photo: download → R2 upload → get URL
      → env.CAPTURE_SERVICE.capture(text, 'telegram', { userId, imageUrl? })
      → format reply
      → send Telegram reply
```
