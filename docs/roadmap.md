# Roadmap

## Phase 1 — Capture pipeline (complete)

The foundation: a Telegram bot backed by a Cloudflare Worker that captures messages into Supabase with pgvector embeddings and semantic linking.

Delivered:
- Telegram webhook handler with async background processing
- Chat ID whitelist and webhook secret verification
- Deduplication via `processed_updates` table
- LLM-generated structured notes (title, body, type, tags, source_ref)
- Semantic search via `match_notes()` RPC with cosine similarity
- Typed links between notes (`extends`, `contradicts`, `supports`, `is-example-of`)
- HTML-formatted Telegram confirmation replies
- Smoke tests against the live Worker

## Phase 1.5 — Enriched capture (complete)

Expanded the data model and capture logic. The schema was rebuilt from scratch (v2) with all Phase 2 infrastructure pre-created.

Delivered:
- **Schema v2:** 8 tables (notes, links, concepts, note_concepts, note_chunks, enrichment_log, capture_profiles, processed_updates) with RLS, HNSW indexes, and seeded data
- **Classification taxonomy:** `intent` (6 values), `modality` (4 values), `entities` (proper nouns with typed categories)
- **Two-pass embedding:** Raw text for lookup, metadata-augmented for storage, with fallback
- **System prompt split:** Structural contract in code (`SYSTEM_FRAME`), stylistic rules in database (`capture_profiles`)
- **Enrichment log:** Audit trail per note per enrichment type, batched inserts
- **Hybrid search:** `match_notes()` with 8 parameters including intent filter and full-text search
- **SKOS concepts:** 10 seeded domain concepts for future tag normalization
- **Parser hardening:** 17 unit tests covering all fallback paths
- **Automated deploy:** `scripts/deploy.sh` runs schema → typecheck → unit tests → Worker deploy → smoke tests
- **Voice correction:** LLM detects and silently fixes transcription errors, reports in Telegram reply

## Phase 2 — Gardening pipeline and MCP server (next)

The capture pipeline stores notes. The gardening pipeline improves them over time. The MCP server makes them accessible to AI agents.

### Gardening pipeline

A scheduled process (likely a Cloudflare Cron Trigger) that runs nightly to:

**Similarity linking** — Compute pairwise cosine similarity across all notes. Insert `is-similar-to` links for pairs above a threshold (~0.80), with `created_by = 'gardener'` and `confidence` set to the similarity score. This surfaces connections the capture-time LLM missed because the related note didn't exist yet.

**Tag normalization via SKOS** — Embed each concept's `pref_label + definition`. For each note's tags, find the nearest concept by cosine similarity. Insert into `note_concepts` and populate `refined_tags`. This collapses "bike", "bicycle", and "cycling" into a single concept while preserving the user's original tags.

**Chunk generation** — For notes with raw_input exceeding ~500 tokens, split into overlapping ~300-token chunks. Embed each chunk independently and insert into `note_chunks`. This enables fine-grained RAG retrieval — a long note about three topics can be matched on any one of them.

**Maturity scoring** — Compute `importance_score` from inbound link count, recency, and type weighting. Update `maturity` from `seedling` to `budding` to `evergreen` based on thresholds. This gives downstream agents a signal about which notes are well-connected hubs versus isolated observations.

### MCP server

An MCP (Model Context Protocol) server that exposes the note database to AI agents as tools:

- **Search by similarity** — wraps `match_notes()` and `match_chunks()` with natural-language query embedding
- **Filter by facets** — type, intent, tags, date range, maturity
- **Retrieve full notes** — with linked notes and entity graph

The MCP server runs as a separate process (not in the Worker). It connects to the same Supabase database using the service role key.

The intended use case: an AI coding assistant, writing partner, or thinking companion that can retrieve relevant prior thinking without the user manually copying notes into prompts.

### Schema infrastructure already in place

The v2 schema was designed with Phase 2 in mind. These columns and tables exist but are currently unpopulated:

- `notes.summary`, `notes.refined_tags`, `notes.categories`, `notes.metadata`
- `notes.importance_score`, `notes.maturity` (defaults to `seedling`)
- `note_chunks` table with HNSW index
- `note_concepts` junction table
- `concepts` table with seeded vocabulary
- `match_chunks()` RPC function
- `links` table supports gardening-time types (`is-similar-to`, `is-part-of`, `follows`, `is-derived-from`) with `created_by = 'gardener'`
- `enrichment_log` supports any enrichment type string

No schema migration will be needed for Phase 2.

## Phase 3 — Associative trails and beyond (deferred)

**Associative trails** — Curated or auto-generated sequences of notes that tell a story or trace a line of thinking. The `trails` and `trail_steps` tables were designed but not created in v2.

**Type inheritance** — A `note_types` table that defines custom types with inheritance, allowing user-defined specializations beyond the four base types.

**Location extraction** — For input channels that support geotags (future mobile app), extract and store location data.

**Additional input channels** — The capture pipeline is channel-agnostic by design. Adding Slack, email, voice, or a web interface means writing a new entry point that calls the same embed → LLM → store flow. The `source` field records provenance.
