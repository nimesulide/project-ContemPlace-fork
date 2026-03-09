-- ============================================================
-- PRE-STEP: DROP v1 OBJECTS
-- Functions must be dropped before tables (trigger dependency).
-- Dropping with CASCADE handles triggers and dependent objects.
-- IF EXISTS is safe on a fresh database (no-ops).
-- ============================================================
DROP FUNCTION IF EXISTS match_notes CASCADE;
DROP FUNCTION IF EXISTS match_chunks CASCADE;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;

DROP TABLE IF EXISTS trail_steps CASCADE;
DROP TABLE IF EXISTS trails CASCADE;
DROP TABLE IF EXISTS capture_profiles CASCADE;
DROP TABLE IF EXISTS enrichment_log CASCADE;
DROP TABLE IF EXISTS note_chunks CASCADE;
DROP TABLE IF EXISTS note_concepts CASCADE;
DROP TABLE IF EXISTS concepts CASCADE;
DROP TABLE IF EXISTS links CASCADE;
DROP TABLE IF EXISTS notes CASCADE;
DROP TABLE IF EXISTS note_types CASCADE;
DROP TABLE IF EXISTS processed_updates CASCADE;

-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists vector schema extensions;

-- ============================================================
-- NOTES
-- ============================================================
create table notes (
  id              uuid        primary key default gen_random_uuid(),

  -- CAPTURE-TIME (required: only raw_input + timestamp)
  raw_input       text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- CAPTURE-TIME (from LLM, single-pass)
  title           text        not null,
  body            text        not null,
  type            text        not null check (type in ('idea', 'reflection', 'source', 'lookup')),
  tags            text[]      not null default '{}',
  source_ref      text,
  source          text        not null default 'telegram',
  corrections     text[],

  -- CAPTURE-TIME (LLM-classified, zero user friction)
  intent          text        check (intent in ('reflect', 'plan', 'create', 'remember', 'reference', 'log')),
  modality        text        check (modality in ('text', 'link', 'list', 'mixed')),
  entities        jsonb       default '[]',

  -- GARDENING-TIME (auto-populated by enrichment pipeline)
  summary         text,
  refined_tags    text[]      default '{}',
  categories      text[]      default '{}',
  metadata        jsonb       default '{}',
  importance_score float,
  maturity        text        default 'seedling' check (maturity in ('seedling', 'budding', 'evergreen')),

  -- Soft delete
  archived_at     timestamptz,

  -- Embeddings
  embedding       extensions.vector(1536),
  embedded_at     timestamptz,

  -- Full-text search (hybrid with vector)
  -- NOTE: raw_input intentionally excluded — it contains uncorrected dictation
  -- artifacts that the capture agent already cleaned up. [Review fix 07-§1a]
  content_tsv     tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || body)
  ) stored
);

-- Semantic search (cosine distance, partial: excludes unembedded rows)
create index notes_embedding_idx on notes
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;

-- Full-text search
create index notes_content_tsv_idx on notes using gin (content_tsv);

-- Tag filtering
create index notes_tags_idx on notes using gin (tags);

-- Recency ordering
create index notes_created_idx on notes (created_at desc);

-- Active notes only
create index notes_active_idx on notes (created_at desc)
  where archived_at is null;

-- Orphaned embeddings (for retry jobs)
create index notes_null_embedding_idx on notes (id)
  where embedding is null and archived_at is null;

-- Intent filtering (for MCP queries like "show me all my plans")
create index notes_intent_idx on notes (intent)
  where intent is not null;

-- Entities — jsonb_path_ops for smaller index and faster @> queries [Review fix 11-§6]
create index notes_entities_idx on notes using gin (entities jsonb_path_ops);

-- ============================================================
-- LINKS
-- Expanded from 4 types to 8. Added context, confidence, created_by
-- for gardening-time auto-generated links.
-- ============================================================
create table links (
  id          uuid        primary key default gen_random_uuid(),
  from_id     uuid        not null references notes(id) on delete cascade,
  to_id       uuid        not null references notes(id) on delete cascade,
  link_type   text        not null check (link_type in (
    -- Capture-time (LLM-assigned)
    'extends', 'contradicts', 'supports', 'is-example-of',
    -- Gardening-time (auto-generated)
    'is-similar-to', 'is-part-of', 'follows', 'is-derived-from'
  )),
  context     text,                           -- surrounding text or reason for the link
  confidence  float       default 1.0,        -- 1.0 for human/LLM links, <1.0 for auto-similarity
  created_by  text        default 'capture' check (created_by in ('capture', 'gardener', 'user')),
  created_at  timestamptz not null default now(),
  unique(from_id, to_id, link_type)
);

create index links_to_id_idx on links (to_id);
create index links_from_id_idx on links (from_id);

-- ============================================================
-- SKOS-INSPIRED CONTROLLED VOCABULARY
-- Solves tag drift: "bike" vs "bicycle" vs "cycling"
-- ============================================================
create table concepts (
  id          uuid        primary key default gen_random_uuid(),
  scheme      text        not null,           -- 'domains', 'intents', 'modalities', etc.
  pref_label  text        not null,           -- canonical name
  alt_labels  text[]      default '{}',       -- synonyms
  broader_id  uuid        references concepts(id),
  definition  text,
  embedding   extensions.vector(1536),
  unique(scheme, pref_label)
);

create table note_concepts (
  note_id     uuid        references notes(id) on delete cascade,
  concept_id  uuid        references concepts(id) on delete cascade,
  primary key (note_id, concept_id)
);

-- ============================================================
-- NOTE CHUNKS (for RAG — long notes split for precise retrieval)
-- ============================================================
create table note_chunks (
  id          uuid        primary key default gen_random_uuid(),
  note_id     uuid        not null references notes(id) on delete cascade,
  chunk_index integer     not null,
  content     text        not null,
  embedding   extensions.vector(1536),
  unique(note_id, chunk_index)
);

create index note_chunks_embedding_idx on note_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;

-- ============================================================
-- ENRICHMENT AUDIT LOG
-- Tracks what enrichment ran on which note, for retry and debugging.
-- ============================================================
create table enrichment_log (
  id              uuid        primary key default gen_random_uuid(),
  note_id         uuid        not null references notes(id) on delete cascade,
  enrichment_type text        not null,
  model_used      text,
  completed_at    timestamptz default now()
);

-- Composite index for idempotency checks ("has this enrichment run?") [Review fix 07-§2d]
create index enrichment_log_note_type_idx on enrichment_log (note_id, enrichment_type);

-- ============================================================
-- CAPTURE PROFILES
-- The capture voice (stylistic prompt rules for title/body) lives here,
-- not in code. Any capture interface (Telegram, MCP, Slack, CLI) fetches
-- the same profile, ensuring uniform note style regardless of entry point.
-- ============================================================
create table capture_profiles (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null unique,
  capture_voice text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- UPDATED_AT TRIGGER
-- search_path pinned for consistency with RPC functions [Review fix 08-§6.4]
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_updated_at
  before update on notes
  for each row execute function update_updated_at();

create trigger capture_profiles_updated_at
  before update on capture_profiles
  for each row execute function update_updated_at();

-- Seed the default capture voice
insert into capture_profiles (name, capture_voice) values ('default', '## Your capture style

**Title**: A claim or insight when one is present. If the input doesn''t contain a claim, use a descriptive phrase that captures what the note is about — still specific, not a generic topic label.
- Good: "Constraints make creative work stronger" (claim)
- Good: "Painting pebbles with Aztec-inspired patterns" (descriptive, no claim in input)
- Bad: "Creativity" or "Note about constraints" (vague topic labels)

**Body**: 1–5 sentences. Atomic — one idea, standing alone. Exception: when modality is `list`, preserve all items — the list itself is the idea.

**Traceability rule (bright line):** Every sentence in the body must be traceable to something the user actually said. You may clean up grammar, remove filler, and lightly restructure — but you must not add information, conclusions, elaborations, or descriptions that the user did not express. If the input is short, the body is short. One sentence is fine.

Preserve first-person voice when the user writes in first person. Do not shift to third-person narration. Where corrections apply, use the corrected words in the body — the corrections field records what changed.

Wrong:
- Input: "i like to paint pebbles in various colors maybe use aztec patterns for inspiration"
- Body: "Likes painting pebbles in various colors. The geometric and symbolic motifs from Aztec design could translate well onto the curved surfaces of stones."
- Why wrong: person shifted to third (user said "I like"), and the second sentence is fabricated.

Right:
- Input: "i like to paint pebbles in various colors maybe use aztec patterns for inspiration"
- Body: "I like painting pebbles in various colors. Aztec patterns could be good inspiration."

Use the user''s own words and phrasing wherever possible — rewrite only enough to fix grammar and remove filler. Do not paraphrase their metaphors into neutral descriptions. Do not add a concluding sentence that synthesizes or names what their words already showed. Do not add benefits, follow-ons, or observations the user did not make. Shorter is better than padded.');

-- ============================================================
-- TELEGRAM DEDUPLICATION (unchanged from v1)
-- ============================================================
create table processed_updates (
  update_id    bigint      primary key,
  processed_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table notes             enable row level security;
alter table links             enable row level security;
alter table concepts          enable row level security;
alter table note_concepts     enable row level security;
alter table note_chunks       enable row level security;
alter table enrichment_log    enable row level security;
alter table capture_profiles  enable row level security;
alter table processed_updates enable row level security;

create policy "deny all" on notes             for all using (false);
create policy "deny all" on links             for all using (false);
create policy "deny all" on concepts          for all using (false);
create policy "deny all" on note_concepts     for all using (false);
create policy "deny all" on note_chunks       for all using (false);
create policy "deny all" on enrichment_log    for all using (false);
create policy "deny all" on capture_profiles  for all using (false);
create policy "deny all" on processed_updates for all using (false);

-- ============================================================
-- SEMANTIC SEARCH FUNCTION (v2 — hybrid vector + full-text)
--
-- Created in PUBLIC schema so Supabase PostgREST can find it via .rpc()
-- [Review fix 07-§1b, 09-§3b]
--
-- search_path includes 'extensions' so the <=> operator resolves
-- [Review fix 07-§1c]
-- ============================================================
create or replace function match_notes(
  query_embedding  extensions.vector(1536),
  match_threshold  float   default 0.5,
  match_count      int     default 10,
  filter_type      text    default null,
  filter_source    text    default null,
  filter_tags      text[]  default null,
  filter_intent    text    default null,
  search_text      text    default null
)
returns table (
  id          uuid,
  title       text,
  body        text,
  raw_input   text,
  type        text,
  tags        text[],
  source_ref  text,
  source      text,
  intent      text,
  modality    text,
  entities    jsonb,
  created_at  timestamptz,
  similarity  float
)
language plpgsql stable
set search_path = 'public, extensions'
as $$
begin
  return query
  select
    n.id,
    n.title,
    n.body,
    n.raw_input,
    n.type,
    n.tags,
    n.source_ref,
    n.source,
    n.intent,
    n.modality,
    n.entities,
    n.created_at,
    (1 - (n.embedding <=> query_embedding))::float as similarity
  from notes n
  where
    n.embedding is not null
    and n.archived_at is null
    and 1 - (n.embedding <=> query_embedding) > match_threshold
    and (filter_type   is null or n.type   = filter_type)
    and (filter_source is null or n.source = filter_source)
    and (filter_tags   is null or n.tags   @> filter_tags)
    and (filter_intent is null or n.intent = filter_intent)
    and (search_text   is null or n.content_tsv @@ plainto_tsquery('english', search_text))
  order by n.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ============================================================
-- CHUNK SEARCH FUNCTION (for RAG retrieval in Phase 2)
-- ============================================================
create or replace function match_chunks(
  query_embedding  extensions.vector(1536),
  match_threshold  float   default 0.5,
  match_count      int     default 20
)
returns table (
  chunk_id    uuid,
  note_id     uuid,
  chunk_index integer,
  content     text,
  note_title  text,
  similarity  float
)
language plpgsql stable
set search_path = 'public, extensions'
as $$
begin
  return query
  select
    c.id as chunk_id,
    c.note_id,
    c.chunk_index,
    c.content,
    n.title as note_title,
    (1 - (c.embedding <=> query_embedding))::float as similarity
  from note_chunks c
  join notes n on n.id = c.note_id
  where
    c.embedding is not null
    and n.archived_at is null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ============================================================
-- SEED: SKOS DOMAIN CONCEPTS
-- Initial controlled vocabulary. Embeddings populated later by gardening pipeline.
-- ============================================================
insert into concepts (scheme, pref_label, alt_labels, definition) values
  ('domains', 'creativity', '{"creative process", "making"}', 'Creative thinking, artistic practice, and the act of making'),
  ('domains', 'technology', '{"tech", "software", "programming", "code"}', 'Software, hardware, tools, and digital systems'),
  ('domains', 'spirituality', '{"inner life", "mindfulness", "contemplation"}', 'Inner life, contemplative practice, meaning-making'),
  ('domains', 'design', '{"visual design", "UX", "UI"}', 'Visual, interaction, and systems design'),
  ('domains', 'bookbinding', '{"book arts", "binding"}', 'Book arts, binding techniques, paper craft'),
  ('domains', 'music', '{"audio", "sound", "instruments"}', 'Music creation, instruments, audio production'),
  ('domains', 'cooking', '{"food", "recipes", "kitchen"}', 'Food preparation, recipes, kitchen projects'),
  ('domains', 'reading', '{"books", "literature"}', 'Books, articles, reading notes'),
  ('domains', 'productivity', '{"workflow", "tools", "systems"}', 'Personal systems, workflows, and tools'),
  ('domains', 'relationships', '{"people", "family", "friends"}', 'People, social connections, gifts');
