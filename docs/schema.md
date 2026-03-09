# Schema

The v2 schema has 8 tables, 2 RPC functions, and indexes optimized for both vector similarity search and traditional filtering. All tables have RLS enabled with `deny all` policies — access is exclusively via the service role key.

## Tables

### notes

The core table. Each row is a captured note with both the user's raw input and the LLM's structured interpretation.

| Column | Type | Source | Notes |
|---|---|---|---|
| `id` | uuid (PK) | auto | `gen_random_uuid()` |
| `raw_input` | text | user | Exact user input, never modified |
| `created_at` | timestamptz | auto | |
| `updated_at` | timestamptz | trigger | Via `update_updated_at()` trigger |
| `title` | text | LLM | Claim or descriptive phrase |
| `body` | text | LLM | 1–5 sentences, atomic |
| `type` | text | LLM | `idea`, `reflection`, `source`, `lookup` |
| `tags` | text[] | LLM | Free-form tags from input |
| `source_ref` | text | LLM | URL if present |
| `source` | text | system | Always set. Currently `telegram`. |
| `corrections` | text[] | LLM | Voice dictation fixes |
| `intent` | text | LLM | `reflect`, `plan`, `create`, `remember`, `reference`, `log` |
| `modality` | text | LLM | `text`, `link`, `list`, `mixed` |
| `entities` | jsonb | LLM | `[{name, type}]` — proper nouns |
| `summary` | text | gardener | Phase 2 — auto-generated summary |
| `refined_tags` | text[] | gardener | Phase 2 — normalized via SKOS |
| `categories` | text[] | gardener | Phase 2 — broad categories |
| `metadata` | jsonb | gardener | Phase 2 — extensible metadata |
| `importance_score` | float | gardener | Phase 2 — computed from links/recency |
| `maturity` | text | gardener | `seedling` → `budding` → `evergreen` |
| `archived_at` | timestamptz | user | Soft delete |
| `embedding` | vector(1536) | system | Metadata-augmented embedding |
| `embedded_at` | timestamptz | system | When embedding was computed |
| `content_tsv` | tsvector | generated | `to_tsvector('english', title || ' ' || body)` — raw_input excluded because it contains uncorrected dictation artifacts |

**Indexes:**

| Index | Type | Purpose |
|---|---|---|
| `notes_embedding_idx` | HNSW (cosine) | Vector similarity search. Partial: excludes unembedded rows. `m=16, ef_construction=128`. |
| `notes_content_tsv_idx` | GIN | Full-text search on title + body |
| `notes_tags_idx` | GIN | Tag containment queries |
| `notes_created_idx` | B-tree (desc) | Recency ordering |
| `notes_active_idx` | B-tree (desc) | Active notes only (where `archived_at is null`) |
| `notes_null_embedding_idx` | B-tree | Find notes missing embeddings for retry |
| `notes_intent_idx` | B-tree | Filter by intent (partial: non-null only) |
| `notes_entities_idx` | GIN (jsonb_path_ops) | Entity containment queries with smaller index |

### links

Typed edges between notes. Capture-time links are created by the LLM; gardening-time links will be auto-generated in Phase 2.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `from_id` | uuid (FK → notes) | The newer note |
| `to_id` | uuid (FK → notes) | The related note |
| `link_type` | text | 8 allowed values (see below) |
| `context` | text | Why the link exists |
| `confidence` | float | 1.0 for LLM/human links, <1.0 for auto-similarity |
| `created_by` | text | `capture`, `gardener`, or `user` |
| `created_at` | timestamptz | |

**Link types:**
- Capture-time: `extends`, `contradicts`, `supports`, `is-example-of`
- Gardening-time: `is-similar-to`, `is-part-of`, `follows`, `is-derived-from`

**Unique constraint:** `(from_id, to_id, link_type)` — prevents duplicate links of the same type between the same pair.

### concepts

SKOS-inspired controlled vocabulary. Solves tag drift — "bike", "bicycle", and "cycling" all map to the same concept.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `scheme` | text | Namespace: `domains`, `intents`, etc. |
| `pref_label` | text | Canonical name |
| `alt_labels` | text[] | Synonyms |
| `broader_id` | uuid (FK → concepts) | Hierarchical parent |
| `definition` | text | Human-readable definition |
| `embedding` | vector(1536) | For semantic matching (Phase 2) |

**Unique constraint:** `(scheme, pref_label)`

Seeded with 10 domain concepts: creativity, technology, spirituality, design, bookbinding, music, cooking, reading, productivity, relationships.

### note_concepts

Junction table linking notes to concepts. Populated by the gardening pipeline in Phase 2.

### note_chunks

RAG preparation for long notes. Phase 2 will split notes exceeding ~500 tokens into overlapping ~300-token chunks, each independently embedded.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `note_id` | uuid (FK → notes) | Parent note |
| `chunk_index` | integer | Order within the note |
| `content` | text | Chunk text |
| `embedding` | vector(1536) | Chunk-level embedding |

**Unique constraint:** `(note_id, chunk_index)`

Has its own HNSW index for chunk-level similarity search via `match_chunks()`.

### enrichment_log

Audit trail tracking what processing has been applied to each note. Currently records two entries per capture: one for the LLM structuring (`capture` type) and one for the embedding (`embedding` type).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `note_id` | uuid (FK → notes) | |
| `enrichment_type` | text | `capture`, `embedding`, `augmented_embed_fallback`, etc. |
| `model_used` | text | Model string used |
| `completed_at` | timestamptz | |

**Index:** `(note_id, enrichment_type)` for idempotency checks.

### capture_profiles

Stores the stylistic prompt rules (the "capture voice") fetched at runtime by any capture interface.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `name` | text (unique) | Profile name. `default` is seeded. |
| `capture_voice` | text | The full stylistic prompt text |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Via trigger |

Edit the `default` row to tune capture behavior without redeploying.

### processed_updates

Telegram deduplication. Stores each `update_id` to prevent reprocessing.

| Column | Type | Notes |
|---|---|---|
| `update_id` | bigint (PK) | From Telegram webhook payload |
| `processed_at` | timestamptz | |

## RPC functions

Both functions are in the `public` schema (required for PostgREST visibility) with `set search_path = 'public, extensions'` (required for pgvector operator resolution). They use `LANGUAGE PLPGSQL` for compatibility with the Supabase CLI's connection pooler pipeline.

### match_notes

Hybrid vector + full-text search with filtering.

```sql
match_notes(
  query_embedding  vector(1536),
  match_threshold  float    DEFAULT 0.5,
  match_count      int      DEFAULT 10,
  filter_type      text     DEFAULT NULL,
  filter_source    text     DEFAULT NULL,
  filter_tags      text[]   DEFAULT NULL,
  filter_intent    text     DEFAULT NULL,
  search_text      text     DEFAULT NULL
)
```

Returns: `id`, `title`, `body`, `raw_input`, `type`, `tags`, `source_ref`, `source`, `intent`, `modality`, `entities`, `created_at`, `similarity`.

Filters are composable — any combination of type, source, tags, intent, and full-text search can be applied. All filters are optional; passing NULL skips the filter.

Excludes archived notes and notes without embeddings.

### match_chunks

Chunk-level vector search for RAG retrieval (Phase 2).

```sql
match_chunks(
  query_embedding  vector(1536),
  match_threshold  float    DEFAULT 0.5,
  match_count      int      DEFAULT 20
)
```

Returns: `chunk_id`, `note_id`, `chunk_index`, `content`, `note_title`, `similarity`.

## Row Level Security

All 8 tables have RLS enabled with a single `deny all` policy. This means:

- The **anon key** has zero access to any table
- The **service role key** bypasses RLS entirely (by design)
- If the anon key is ever leaked, no data is exposed

This is defense in depth. The Worker only ever uses the service role key.
