# API Contract: Dashboard API Worker (Multi-Tenant)

**Feature**: 002-multi-tenant-mvp
**Date**: 2026-03-29

## Authentication

**Current**: Static `DASHBOARD_API_KEY` bearer token.

**New**: Supabase Auth JWT in Authorization header. Static key retained as fallback during migration.

```
Authorization: Bearer <supabase-jwt>
```

The Worker validates the JWT using `jose` + `SUPABASE_JWT_SECRET`, extracts `user_id` from `payload.sub`.

### Error Responses (auth)

| Status | Condition |
|--------|-----------|
| 401 | Missing or malformed Authorization header |
| 403 | Invalid/expired JWT, or user not found |

---

## Endpoints

All existing endpoints unchanged in structure. New behavior: all queries scoped to authenticated user.

### GET /stats

**Response** (unchanged shape, user-scoped data):
```json
{
  "total_notes": 42,
  "total_links": 18,
  "total_clusters": 5,
  "unclustered_count": 3,
  "image_count": 2,
  "capture_rate_7d": 3.5,
  "oldest_note": "2025-06-01T00:00:00Z",
  "newest_note": "2026-03-29T12:00:00Z",
  "orphan_count": 7,
  "avg_links_per_note": 0.43,
  "gardener_last_run": "2026-03-29T02:00:00Z",
  "backup_last_commit": "2026-03-29T04:00:00Z"
}
```

All counts filtered by `WHERE user_id = <authenticated user>`.

### GET /clusters?resolution=1.0

**Response** (unchanged shape, user-scoped):
```json
{
  "resolution": 1.0,
  "available_resolutions": [1.0, 1.5, 2.0],
  "clusters": [
    {
      "label": "Cluster title",
      "top_tags": ["tag1", "tag2"],
      "note_count": 8,
      "gravity": 4.2,
      "note_ids": ["uuid1", "uuid2"],
      "hub_notes": [{ "id": "uuid1", "title": "Hub note", "link_count": 3 }]
    }
  ]
}
```

### GET /clusters/detail?note_ids=uuid1,uuid2

**Response** (unchanged shape, user-scoped):
```json
{
  "notes": [
    { "id": "uuid1", "title": "Note title", "tags": ["t1"], "image_url": null, "created_at": "..." }
  ],
  "links": [
    { "from_id": "uuid1", "to_id": "uuid2", "link_type": "related", "confidence": 1.0, "created_by": "capture" }
  ]
}
```

**Security**: Only returns notes/links where `user_id` matches the authenticated user. If a `note_id` belongs to another user, it is silently excluded.

### GET /recent?limit=15

**Response** (unchanged shape, user-scoped):
```json
[
  { "id": "uuid1", "title": "Recent note", "tags": ["t1"], "source": "web", "image_url": null, "created_at": "..." }
]
```

---

## New Endpoints

### POST /capture

Capture a note via the existing pipeline. Dashboard API delegates to the MCP Worker via Service Binding (`env.CAPTURE_SERVICE.capture()`), following the same pattern as the Telegram Worker. This preserves the Single Capture Path principle — all capture flows through `mcp/src/pipeline.ts`.

**Request**:
```json
{
  "text": "raw user input",
  "source": "web"
}
```

**Response** (200):
```json
{
  "id": "uuid",
  "title": "Structured title",
  "body": "Structured body...",
  "tags": ["tag1", "tag2"],
  "source": "web",
  "corrections": null,
  "links": []
}
```

**Error Responses**:

| Status | Condition |
|--------|-----------|
| 400 | Missing or empty `text` field |
| 401 | Missing or invalid JWT |

---

### GET /export

Export all user data as JSON.

**Response**:
```json
{
  "exported_at": "2026-03-29T12:00:00Z",
  "user_id": "uuid",
  "notes": [
    {
      "id": "uuid",
      "title": "...",
      "body": "...",
      "raw_input": "...",
      "tags": ["..."],
      "source": "telegram",
      "source_ref": null,
      "corrections": null,
      "entities": [],
      "image_url": null,
      "created_at": "...",
      "links": [
        { "to_id": "uuid", "link_type": "related", "context": "...", "confidence": 1.0, "created_by": "capture" }
      ]
    }
  ],
  "clusters": [
    { "resolution": 1.0, "label": "...", "note_ids": ["..."], "top_tags": ["..."] }
  ]
}
```

### POST /settings/regenerate-key

Generate a new MCP API key for the authenticated user.

**Response**:
```json
{
  "api_key": "cp_abc123...",
  "message": "This key will only be shown once. Store it securely."
}
```

The raw key is returned once. The SHA-256 hash replaces the previous hash in `user_profiles`. The old key is immediately invalidated.

### GET /settings/profile

Return user profile and connection status.

**Response**:
```json
{
  "user_id": "uuid",
  "display_name": "...",
  "email": "...",
  "plan": "free",
  "has_api_key": true,
  "mcp_endpoint": "https://mcp.contemplace.app/",
  "telegram_connected": true,
  "telegram_chat_id": 123456,
  "created_at": "..."
}
```

### POST /settings/telegram-link

Generate a one-time Telegram deep link token. Calling this endpoint always invalidates (deletes) any existing tokens for the authenticated user before generating a new one — the user receives a fresh deep link each time.

**Response**:
```json
{
  "deep_link": "https://t.me/ContemPlaceBot?start=<token>",
  "expires_in_minutes": 15
}
```

### DELETE /settings/telegram

Disconnect Telegram.

**Response**: `204 No Content`
