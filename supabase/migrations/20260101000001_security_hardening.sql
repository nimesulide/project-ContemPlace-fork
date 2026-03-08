-- ============================================================
-- SECURITY HARDENING
-- Addresses three Supabase linter warnings:
--   1. extension_in_public     — move vector to extensions schema
--   2. function_search_path_mutable — pin search_path on both functions
-- ============================================================

-- 1. Move pgvector out of public schema
--    Supabase's default search_path includes "extensions", so existing
--    column definitions (embedding vector(1536)) continue to resolve
--    via the search_path; no table rewrites required.
create schema if not exists extensions;
alter extension vector set schema extensions;

-- 2. Pin search_path on update_updated_at
--    Trigger functions have no object references that need qualifying.
create or replace function public.update_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 3. Pin search_path on match_notes
--    search_path = '' breaks operator lookup for the <=> vector operator,
--    so we pin to explicit schemas instead — this still closes the mutable
--    search_path vulnerability (the risk is an unpinned/user-writable path).
create or replace function public.match_notes(
  query_embedding  extensions.vector(1536),
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
language sql stable
set search_path = extensions, public, pg_catalog
as $$
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
  from public.notes n
  where
    n.embedding is not null
    and n.archived_at is null
    and 1 - (n.embedding <=> query_embedding) > match_threshold
    and (filter_type   is null or n.type   = filter_type)
    and (filter_source is null or n.source = filter_source)
    and (filter_tags   is null or n.tags   @> filter_tags)
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
