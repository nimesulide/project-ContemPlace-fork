# Schema Review

## Issues found

**1. [Critical] `match_notes` crashes or silently drops rows when `embedding` is null**

If an embedding call fails and a note is inserted with `embedding = null`, the expression `1 - (n.embedding <=> query_embedding)` evaluates to `null`. In Postgres, `null > match_threshold` evaluates to `null`, which is not `true`, so the row is silently excluded from results — the function does not crash. But there is a second, harder problem: the `WHERE` clause re-evaluates the `<=>` expression, and the `ORDER BY` does too. Three evaluations of a null distance per row, all producing null. Postgres handles this without crashing, but the HNSW index cannot index null vectors — those rows are invisible to index scans entirely and only appear (as excluded nulls) in sequential scans.

The net result: a note with a failed embedding is a ghost — it exists in the table, is never returned by `match_notes`, and there is no signal in the schema that it is broken. The fix is a partial index that makes null-embedding notes visible and a `WHERE n.embedding IS NOT NULL` guard in the function to make the query planner's intent explicit.

**2. [Critical] No `processed_updates` table for Telegram deduplication**

The integration review (03-integrations.md) identifies this as critical. Thoughtful capture regularly exceeds Telegram's 5-second delivery timeout. Without a `processed_updates` table with a unique constraint on `update_id`, every retry produces a duplicate note. This table belongs in the schema, not the application layer alone, because the deduplication guarantee comes from the unique constraint — a race between two concurrent retry deliveries must resolve at the database level, not in application code.

**3. [Advisory] `unique(from_id, to_id, link_type)` constraint is correct, but the semantics allow a note to both `extends` and `supports` the same target simultaneously**

The constraint as written allows `(A, B, 'extends')` and `(A, B, 'supports')` to coexist. This is intentional in the Evergreen Notes methodology — two different typed relationships between the same pair of notes are semantically distinct — but it is worth being explicit about this decision. The constraint is correct. The advisory is: consider whether `(A, B, 'supports')` and `(B, A, 'supports')` (the reverse direction) should also be allowed. They can coexist with the current schema, and that is fine — directed links in both directions between two notes are meaningful. No change required.

**4. [Advisory] `updated_at` trigger on `notes` only — `links` does not have one**

The `links` table has no `updated_at` column and no trigger. This is acceptable if links are treated as immutable (create and delete only, never update in place). Given the schema has no `updated_at` on `links` at all, the question is moot for now. If link metadata is ever added (e.g. a `weight` or `note` field on the link itself), `updated_at` will need to be added then. Advisory: document the intent (links are immutable) as a comment in the schema.

**5. [Advisory] HNSW `ef_construction=64` is the default and on the low end for a recall-sensitive use case**

The integration review flags this. For a personal memory system, missing a conceptually related note is a meaningful failure. `ef_construction=128` doubles build time (irrelevant at this scale — thousands of notes, not millions) in exchange for meaningfully better recall quality. The corrected schema uses 128.

**6. [Advisory] No partial index to filter out null-embedding rows from the HNSW index**

The HNSW index `notes_embedding_idx` is created on `embedding` without a `WHERE embedding IS NOT NULL` condition. pgvector silently skips null values during index builds, so this does not cause an error — but it also means there is no index-level signal that a row has a missing embedding. Adding a separate `notes_null_embedding_idx` (a plain btree on `id WHERE embedding IS NULL`) makes orphaned notes queryable for a cleanup job. This is advisory.

**7. [Advisory] No `archived_at` column (soft delete)**

There is no soft delete mechanism. Once a note is deleted, it is gone. For a personal memory system, accidental deletes during development or via the MCP interface are a real risk. Adding `archived_at timestamptz` now costs one column and one index. Adding it later requires an `ALTER TABLE` that will not break anything, but it will require updating the `match_notes` function and the RLS policy. Adding it now is the lower-friction choice. The corrected schema includes it, and `match_notes` filters it out.

**8. [Advisory] `match_notes` does not filter out archived notes**

Consequent to issue 7: if `archived_at` is added, `match_notes` must filter `WHERE n.archived_at IS NULL`. Included in the corrected schema.

**9. [Advisory] No `pending_captures` table — but the schema is ready for it**

Phase 2 defers a clarification loop (bot asks for more context before storing). If that loop is implemented, it needs to persist the in-flight state somewhere between the user's original message and their clarification reply. The current schema has no `pending_captures` table. Nothing in the Phase 1 schema blocks adding it later — a `pending_captures` table with columns `(id, chat_id, original_text, embedding, created_at, expires_at)` can be added as a standalone migration with no changes to existing tables. The schema is ready for it. No action needed now.

**10. [Advisory] `assets.note_id` uses `on delete set null` — orphaned assets have no retrieval path**

If a note is deleted (hard delete), its associated assets lose their `note_id` reference. They remain in the `assets` table with `note_id = null` but there is no other identifier linking them to the note's content. If soft delete (`archived_at`) is adopted, this is less of an issue because notes are rarely hard-deleted. If soft delete is not adopted, consider `on delete cascade` for assets instead, unless preserving orphaned assets is intentional (e.g. for recovery).

**11. Embedding dimension: `vector(1536)` — which model**

The brief specifies `voyage/voyage-3` at 1024 dimensions. The integration review confirms voyage-3 is not on OpenRouter. The two options:

- **Option A — `mistral/mistral-embed` via OpenRouter:** outputs 1024-dimensional vectors. Schema dimension is correct. One API key, one base URL. This is the more conservative choice if the model might change again later, because 1024 is also the native dimension of voyage-3 and several other embedding models — the schema stays compatible without migration.
- **Option B — `voyage-3` direct via Voyage AI:** outputs 1024-dimensional vectors. Schema dimension is correct. Requires a separate `VOYAGE_API_KEY` and second SDK client. Better embedding quality than mistral-embed for English prose.

`vector(1536)` is correct for both options. The dimension does not need to change regardless of which model is chosen. Option A is the more conservative choice because it keeps all AI calls under one API key and one base URL — fewer moving parts means fewer things to break. The corrected schema keeps `vector(1536)`.

---

## Corrected schema

```sql
-- Enable pgvector
create extension if not exists vector;

-- ============================================================
-- NOTES
-- ============================================================
create table notes (
  id          uuid        primary key default gen_random_uuid(),
  title       text        not null,
  body        text        not null,
  raw_input   text        not null,              -- user's original message, never discarded
  type        text        not null check (type in ('idea', 'reflection', 'source', 'lookup')),
  tags        text[]      not null default '{}',
  source_ref  text,
  source      text        not null default 'telegram',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,                         -- soft delete; null = active
  embedding   vector(1536)                         -- null until embedding succeeds
);

-- Semantic search index (cosine distance)
-- Partial: excludes unembedded rows so the index only covers searchable notes.
-- ef_construction=128 (raised from default 64) for better recall on a memory system.
create index notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;

-- Tag filtering
create index notes_tags_idx on notes using gin (tags);

-- Recency ordering
create index notes_created_idx on notes (created_at desc);

-- Active notes only (used by most application queries)
create index notes_active_idx on notes (created_at desc)
  where archived_at is null;

-- Diagnostic: find notes that failed embedding (for cleanup / retry jobs)
create index notes_null_embedding_idx on notes (id)
  where embedding is null and archived_at is null;

-- ============================================================
-- LINKS
-- Treated as immutable: create and delete only, no in-place updates.
-- The unique constraint allows (A→B, 'extends') and (A→B, 'supports')
-- to coexist — two distinct typed relationships between the same pair
-- of notes are semantically valid in the Evergreen Notes model.
-- ============================================================
create table links (
  id         uuid        primary key default gen_random_uuid(),
  from_id    uuid        not null references notes(id) on delete cascade,
  to_id      uuid        not null references notes(id) on delete cascade,
  link_type  text        not null check (link_type in ('extends', 'contradicts', 'supports', 'is-example-of')),
  created_at timestamptz not null default now(),
  unique(from_id, to_id, link_type)
);

-- Lookup links by target (for "what links to this note?" queries)
create index links_to_id_idx on links (to_id);

-- ============================================================
-- ASSETS — deferred to Phase 2 (image handling).
-- Add via a standalone migration when needed. Schema is forward-compatible.
-- ============================================================

-- ============================================================
-- TELEGRAM DEDUPLICATION
-- Unique constraint on update_id is the deduplication guarantee.
-- Two concurrent retry deliveries race to insert; only one wins
-- (23505 unique_violation). The loser returns 200 immediately.
-- Rows can be pruned after ~24 hours — Telegram stops retrying well
-- before that — but a simple cron or manual cleanup is sufficient.
-- ============================================================
create table processed_updates (
  update_id    bigint      primary key,
  processed_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- All tables deny non-service-role access. The service role key
-- bypasses RLS entirely at the Postgres level, so using(false)
-- is the unambiguous way to block anon/authenticated access.
-- ============================================================
alter table notes             enable row level security;
alter table links             enable row level security;
alter table processed_updates enable row level security;

create policy "deny all non-service access" on notes             for all using (false);
create policy "deny all non-service access" on links             for all using (false);
create policy "deny all non-service access" on processed_updates for all using (false);

-- ============================================================
-- UPDATED_AT TRIGGER (notes only — links are immutable)
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_updated_at
  before update on notes
  for each row execute function update_updated_at();

-- ============================================================
-- SEMANTIC SEARCH FUNCTION
--
-- Changes from the original:
--   1. Filters out archived notes (archived_at is null).
--   2. Guards against null embeddings explicitly: the WHERE clause
--      includes "n.embedding is not null" so null-embedding rows are
--      excluded cleanly, the query planner can use the partial HNSW
--      index, and the intent is readable without relying on the
--      implicit null-comparison behaviour of Postgres.
--   3. The <=> operator and 1 - (embedding <=> query) similarity
--      calculation are unchanged — they were correct.
-- ============================================================
create or replace function match_notes(
  query_embedding  vector(1536),
  match_threshold  float   default 0.5,
  match_count      int     default 10,
  filter_type      text    default null,
  filter_source    text    default null,
  filter_tags      text[]  default null
)
returns table (
  id          uuid,
  title       text,
  body        text,
  type        text,
  tags        text[],
  source_ref  text,
  source      text,
  created_at  timestamptz,
  similarity  float
)
language sql stable as $$
  select
    n.id,
    n.title,
    n.body,
    n.type,
    n.tags,
    n.source_ref,
    n.source,
    n.created_at,
    1 - (n.embedding <=> query_embedding) as similarity
  from notes n
  where
    n.embedding is not null                                   -- exclude unembedded notes
    and n.archived_at is null                                 -- exclude archived notes
    and 1 - (n.embedding <=> query_embedding) > match_threshold
    and (filter_type   is null or n.type   = filter_type)
    and (filter_source is null or n.source = filter_source)
    and (filter_tags   is null or n.tags   @> filter_tags)
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
```

---

## Migration notes

**Schema versioning approach.** Supabase does not enforce a migration runner by default, but use one from the start. Create a `supabase/migrations/` folder. Name files `YYYYMMDDHHMMSS_description.sql`. Run `supabase db push` to apply. Never edit production SQL directly after first deploy — always write a new migration file.

**Adding columns later is cheap.** `ALTER TABLE notes ADD COLUMN` with a default is a near-instant metadata operation in Postgres 11+ (the default is stored in the catalog, not written to every row). Adding nullable columns or columns with `default` expressions is safe on a live table. The one exception: adding a `NOT NULL` column without a default requires rewriting the table — always add with a default first, backfill, then add the constraint.

**`archived_at` already included.** The corrected schema adds `archived_at` now. The `match_notes` function filters it out. The `notes_active_idx` partial index covers the common query path. No migration needed for this.

**`processed_updates` pruning.** The table grows at one row per Telegram update. For a personal bot (tens of messages per day), this is negligible. If you want to prune, a Supabase `pg_cron` job deleting rows older than 24 hours is sufficient:

```sql
select cron.schedule(
  'prune-processed-updates',
  '0 4 * * *',  -- daily at 04:00 UTC
  $$ delete from processed_updates where processed_at < now() - interval '24 hours' $$
);
```

This requires the `pg_cron` extension, available on Supabase. Add it as a migration when needed, not upfront.

**Changing the `link_type` enum later.** The `link_type` check constraint is a list of literals in a `CHECK`. To add a new type:

```sql
alter table links drop constraint links_link_type_check;
alter table links add constraint links_link_type_check
  check (link_type in ('extends', 'contradicts', 'supports', 'is-example-of', 'new-type'));
```

Dropping and re-adding a check constraint is fast (no table rewrite) and safe on a live table. This is preferable to a Postgres `ENUM` type, which requires `ALTER TYPE ... ADD VALUE` and has restrictions on rollback. Plain text with a check constraint is easier to evolve.

**Changing the HNSW parameters later.** HNSW index parameters (`m`, `ef_construction`) are baked in at index creation and cannot be changed in place. To change them:

```sql
drop index concurrently notes_embedding_idx;
create index concurrently notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;
```

`CREATE INDEX CONCURRENTLY` builds the index without locking the table for reads or writes. Safe on a live table. The `DROP ... CONCURRENTLY` likewise does not lock. Both operations take time proportional to table size.

**Changing the vector dimension later is not possible without a table rewrite.** `vector(1536)` is fixed at column creation. Changing to `vector(1536)` would require creating a new column, re-embedding every note with the new model, and dropping the old column. This is expensive and disruptive. Get the dimension right before first deploy. Both `mistral/mistral-embed` (Option A) and `voyage-3` (Option B) produce 1024-dimensional vectors — `vector(1536)` is correct for both and does not need to change.

**Adding `pending_captures` for Phase 2.** This is a standalone new table — no changes to existing tables required. A migration at Phase 2 start:

```sql
create table pending_captures (
  id            uuid        primary key default gen_random_uuid(),
  chat_id       bigint      not null,
  original_text text        not null,
  embedding     vector(1536),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '1 hour'
);

alter table pending_captures enable row level security;
create policy "service role only" on pending_captures for all using (auth.role() = 'service_role');
create index pending_captures_chat_idx on pending_captures (chat_id, expires_at);
```

No existing tables or functions need to change. Phase 1 schema is forward-compatible.
