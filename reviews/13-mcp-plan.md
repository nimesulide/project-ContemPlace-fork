# Phase 2a Implementation Plan — MCP Server

## What This Phase Does

Phase 2a adds a Model Context Protocol (MCP) server to ContemPlace. It exposes the note database to AI agents via five tools: semantic search, note retrieval, recent notes listing, relationship traversal, and note creation. Agents running in Claude Desktop, Cursor, or custom pipelines can query and write to the note store without going through Telegram.

The capture pipeline (Telegram → Worker → Supabase) is **unchanged**. This phase adds a new access layer on top of the existing database.

## What This Phase Does NOT Include

- **Gardening pipeline** — nightly similarity links, tag normalization, maturity scoring. That is Phase 2b.
- **`search_chunks` / `match_chunks`** — the `note_chunks` table exists in the schema but is not populated until gardening runs. The `match_chunks` RPC is present but the `search_chunks` MCP tool is deferred to Phase 2b.
- **OAuth or multi-user auth** — single API key, personal system.
- **Claude.ai web integration** — not supported by the platform as of 2025.
- **Date range filtering** — deferred to Phase 3.
- **Pagination** — `limit` param is sufficient for personal note volumes.

---

## Architecture Decisions

### Remote HTTP vs Local stdio

**Decision: Remote HTTP (Cloudflare Worker), with stdio as a future thin wrapper.**

MCP supports two transport types: local stdio (subprocess on the same machine) and remote HTTP (network endpoint). The goal is to connect from "various environments" — Claude Desktop, Cursor, custom cloud agents, future tools. stdio works only when the client and server are on the same machine. A remote HTTP Worker is accessible from anywhere with the API key.

Streamable HTTP (the 2025 MCP transport spec) uses a single POST endpoint. It supports both synchronous JSON responses and streaming SSE responses. All five tools in this phase return simple JSON — no streaming needed.

A stdio wrapper can be added later as a thin shim that calls the HTTP endpoint locally. That avoids duplicating business logic.

**Open question for user:** What are the primary MCP clients at launch? (Claude Desktop on Mac? Cursor? Custom agent scripts?) This affects how to document the client configuration step. The implementation is transport-agnostic but the setup instructions differ.

### Synchronous vs Async Capture

The Telegram Worker uses `ctx.waitUntil()` and returns 200 immediately — Telegram requires fast acknowledgment. MCP clients are blocking: they call a tool and wait for the result. The `capture_note` tool runs the full pipeline synchronously and returns the created note. Typical pipeline latency is 2–4 seconds. This is acceptable for an agent workflow.

### Separate Worker

The MCP server lives in `mcp/` as a separate Cloudflare Worker (`mcp-contemplace.<subdomain>.workers.dev`). It shares the same Supabase database and OpenRouter key. Keeping it separate:

- Avoids coupling the Telegram webhook path with MCP request handling
- Allows independent deployment and scaling
- Keeps `src/index.ts` (the capture worker) clean

Shared code (Supabase client setup, embed helper, capture pipeline) will be duplicated or extracted. For Phase 2a, duplication is acceptable. If it grows unwieldy, a shared internal package can be introduced in Phase 3.

---

## Step-by-Step Implementation

### Step 1 — Scaffold `mcp/` directory

Create the following structure:

```
mcp/
  wrangler.toml
  package.json         # can reuse root package.json deps or be standalone
  tsconfig.json
  src/
    index.ts           # Worker entry point — handles /mcp endpoint
    tools.ts           # Tool definitions and handlers
    auth.ts            # Bearer token middleware
    capture.ts         # Capture pipeline (copied/adapted from src/capture.ts)
    embed.ts           # Embed helpers (copied/adapted from src/embed.ts)
    db.ts              # Supabase client + DB reads (adapted from src/db.ts)
    types.ts           # Shared types (can import from root or duplicate)
```

`mcp/wrangler.toml` should define `name = "mcp-contemplace"` and declare all required env vars (non-secret ones only — secrets go via `wrangler secret put`).

### Step 2 — Implement Bearer auth middleware (`mcp/src/auth.ts`)

```typescript
export function validateAuth(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = authHeader.slice(7);
  if (token !== env.MCP_API_KEY) {
    return new Response("Forbidden", { status: 403 });
  }
  return null; // auth passed
}
```

Call `validateAuth` before any MCP message processing. Return the error response immediately if non-null.

### Step 3 — Implement the `/mcp` endpoint (`mcp/src/index.ts`)

The Worker must handle:

1. `OPTIONS` — return CORS preflight headers (for future browser/agent compatibility)
2. `POST /mcp` — MCP Streamable HTTP transport

All MCP communication is JSON-RPC 2.0 over POST. The server responds with `Content-Type: application/json` for all tool calls in this phase.

Required JSON-RPC methods:

| Method | Description |
|---|---|
| `initialize` | Negotiate protocol version, return server info and capabilities |
| `tools/list` | Return array of tool definitions |
| `tools/call` | Execute a named tool with given arguments |

Unrecognized methods return `{ error: { code: -32601, message: "Method not found" } }`.

**`initialize` response shape:**

```json
{
  "protocolVersion": "2025-03-26",
  "serverInfo": { "name": "contemplace-mcp", "version": "1.0.0" },
  "capabilities": { "tools": {} }
}
```

**`tools/list` response:** return the array of tool definitions from `tools.ts`.

**`tools/call` response:** `{ content: [{ type: "text", text: "<JSON string of result>" }] }` for success, or `{ content: [...], isError: true }` for tool-level errors.

### Step 4 — Implement tool handlers (`mcp/src/tools.ts`)

See `reviews/16-mcp-api-design.md` for the full input/output contract for each tool. Implement:

1. **`search_notes`** — embed query → `match_notes()` RPC → return ranked array
2. **`get_note`** — validate UUID → fetch note + joined links → return full note
3. **`list_recent`** — query `notes` ordered by `created_at DESC` with optional filters
4. **`get_related`** — query `links` for both directions (from_id = id OR to_id = id), join note titles
5. **`capture_note`** — full pipeline: embed → match_notes → LLM (system frame + capture voice) → insert note + links → return created note

For `capture_note`, the pipeline is identical to `src/capture.ts` + `src/index.ts` capture flow. The `source` field is set to the caller-provided `source` param (default `"mcp"`). The capture voice is fetched from `capture_profiles` at runtime.

### Step 5 — Tool definitions

Each tool definition follows this schema:

```typescript
{
  name: string,
  description: string,       // written for an LLM reading it, not for API docs
  inputSchema: {
    type: "object",
    properties: { ... },
    required: [...]
  }
}
```

Write descriptions as if explaining the tool to a smart assistant. Example for `search_notes`:

> "Search your personal notes by semantic similarity. Provide a natural language query — it will be embedded and matched against stored notes. Use filter_type or filter_intent to narrow results. Returns ranked results with similarity scores."

### Step 6 — Error handling

Tool-level errors (note not found, invalid UUID, DB error) return:

```json
{
  "content": [{ "type": "text", "text": "Note not found: <id>" }],
  "isError": true
}
```

Protocol-level errors (bad JSON, unknown method, missing params) return standard JSON-RPC error objects.

Log full error details to console. Never expose stack traces or internal DB errors in the response.

### Step 7 — New env vars

| Var | Where | Notes |
|---|---|---|
| `MCP_API_KEY` | `wrangler secret put` + `.dev.vars` | `openssl rand -hex 32`. Never in wrangler.toml. |
| `SUPABASE_URL` | wrangler.toml (non-secret) or secret | Same value as capture worker |
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put` + `.dev.vars` | Same value as capture worker |
| `OPENROUTER_API_KEY` | `wrangler secret put` + `.dev.vars` | Same value as capture worker |
| `CAPTURE_MODEL` | wrangler.toml | Default `anthropic/claude-haiku-4-5` |
| `EMBED_MODEL` | wrangler.toml | Default `openai/text-embedding-3-small` |
| `MATCH_THRESHOLD` | wrangler.toml | Default `0.60` |

Add `MCP_API_KEY` to `.dev.vars.example` with a placeholder value.

### Step 8 — Deploy

```bash
# Set secrets for the MCP worker
wrangler secret put MCP_API_KEY -c mcp/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c mcp/wrangler.toml
wrangler secret put OPENROUTER_API_KEY -c mcp/wrangler.toml

# Deploy
wrangler deploy -c mcp/wrangler.toml
```

No schema migrations are needed. All required tables and RPC functions are in the v2 schema.

### Step 9 — Register with Claude Code (primary client)

The primary client is **Claude Code** (the CLI). Claude Code supports remote HTTP MCP servers via a project-level or global config file.

**Project-level** (`.mcp.json` in the repo root — checked in, no secrets):
```json
{
  "mcpServers": {
    "contemplace": {
      "type": "url",
      "url": "https://mcp-contemplace.<subdomain>.workers.dev/mcp"
    }
  }
}
```

The API key is added at the session level via the `/mcp` command in Claude Code, or set as an environment variable. Do not put the key in `.mcp.json` (it would be committed).

**Alternative: global config** (`~/.claude/mcp.json`) — same shape, but applies to all projects. Preferred for a personal tool so it's available everywhere without checking in config.

**Claude on the web** — does not support custom MCP servers as of 2025. The web dashboard (separate project, deferred) covers the browser-based interaction use case instead.

**Other HTTP clients** (future web agents, Perplexity integrations): use the same HTTP endpoint with `Authorization: Bearer <key>` header.

---

## New Files

| Path | Purpose |
|---|---|
| `mcp/wrangler.toml` | MCP Worker config |
| `mcp/src/index.ts` | Worker entry: route requests, auth, JSON-RPC dispatch |
| `mcp/src/tools.ts` | Tool definitions and handler implementations |
| `mcp/src/auth.ts` | Bearer token validation |
| `mcp/src/capture.ts` | Capture pipeline (adapted from `src/capture.ts`) |
| `mcp/src/embed.ts` | Embed helpers (adapted from `src/embed.ts`) |
| `mcp/src/db.ts` | Supabase reads + insertNote (adapted from `src/db.ts`) |
| `mcp/src/types.ts` | TypeScript types for MCP layer |

The capture worker (`src/`) is not modified.

---

## Test Plan

**Manual curl tests (each tool):**

```bash
BASE="https://mcp-contemplace.<subdomain>.workers.dev/mcp"
AUTH="Authorization: Bearer <key>"

# initialize
curl -X POST $BASE -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"}}}'

# tools/list
curl -X POST $BASE -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# search_notes
curl -X POST $BASE -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"ideas about product design"}}}'

# list_recent
curl -X POST $BASE -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_recent","arguments":{"limit":5}}}'

# get_note (use a real UUID from list_recent output)
curl -X POST $BASE -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_note","arguments":{"id":"<uuid>"}}}'

# capture_note
curl -X POST $BASE -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"capture_note","arguments":{"text":"Test note from MCP smoke test","source":"mcp-test"}}}'
```

**Integration test:** Open Claude Desktop after registering the server. Ask: "Search my notes for anything about product design." Verify tool call appears, results are returned, and content looks correct.

**Auth rejection test:** Call with wrong key → expect 403. Call with no header → expect 401.

**Cleanup:** After smoke testing, delete any notes with `source = 'mcp-test'` via Supabase SQL Editor.

---

## Bulk Import Use Cases

The `capture_note` tool is the entry point for importing notes from other systems. Two concrete sources are planned:

### ChatGPT memory export
ChatGPT allows exporting your memory as a JSON/HTML file. The export contains a list of stored memories — flat strings, not structured notes. An import script reads the export, iterates over memories, and calls `capture_note` for each with `source = "chatgpt-memory"`. The LLM enrichment step classifies and links each memory as if it were a new capture.

**Cost consideration:** Each `capture_note` call makes one embedding call and one LLM call. At `text-embedding-3-small` + `claude-haiku-4-5` pricing via OpenRouter, the cost per note is approximately $0.001–0.002. A few hundred memories ≈ less than $1. Worth doing; just don't run it twice.

**Import script:** A standalone Node.js script (not part of the Worker) that reads the export file and posts to the MCP endpoint in a loop with a small delay between calls. Lives in `scripts/import-chatgpt.ts`. Deferred to after the MCP server is live and tested.

### Obsidian vault
Obsidian files are markdown with optional YAML frontmatter. An import script reads each `.md` file, strips frontmatter, and calls `capture_note` with `source = "obsidian"`. Existing Obsidian tags can optionally be included in the text passed to the LLM so the capture agent can consider them.

The vault is already semantically organized, making it a good starter corpus — it will immediately produce a populated note graph with meaningful similarity relationships for when Phase 2b (gardening) runs.

**Import script:** `scripts/import-obsidian.ts`. Same pattern as the ChatGPT importer. Deferred to after MCP server is live.

### Web dashboard
A browser-based view of the note database is a separate future project. It would connect directly to Supabase (not via MCP) and display semantic clusters, maturity distribution, tag graphs, and recent notes. Not in scope for Phase 2a or 2b — it's a distinct frontend project.

---

## Resolved Questions

- **Primary client:** Claude Code (CLI), using remote HTTP MCP.
- **Import sources:** ChatGPT memory export + Obsidian vault. Import scripts are standalone, written after the MCP server is live.
- **Web dashboard:** Separate future project, not MCP-dependent.
