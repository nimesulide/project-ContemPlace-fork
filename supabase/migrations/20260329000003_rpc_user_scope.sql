-- ============================================================
-- RPC USER SCOPE
-- Update match_notes and find_similar_pairs to require p_user_id.
-- refs #002-multi-tenant-mvp
-- ============================================================

-- ── match_notes: add p_user_id parameter ───────────────────

DROP FUNCTION IF EXISTS match_notes;

CREATE FUNCTION match_notes(
  query_embedding  extensions.vector(1536),
  p_user_id        uuid,
  match_threshold  float   DEFAULT 0.5,
  match_count      int     DEFAULT 10,
  filter_source    text    DEFAULT NULL,
  filter_tags      text[]  DEFAULT NULL,
  search_text      text    DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  title       text,
  body        text,
  raw_input   text,
  tags        text[],
  source_ref  text,
  source      text,
  entities    jsonb,
  image_url   text,
  created_at  timestamptz,
  similarity  float
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    n.id,
    n.title,
    n.body,
    n.raw_input,
    n.tags,
    n.source_ref,
    n.source,
    n.entities,
    n.image_url,
    n.created_at,
    (1 - (n.embedding OPERATOR(extensions.<=>) query_embedding))::float AS similarity
  FROM public.notes n
  WHERE
    n.user_id = p_user_id
    AND n.embedding IS NOT NULL
    AND n.archived_at IS NULL
    AND 1 - (n.embedding OPERATOR(extensions.<=>) query_embedding) > match_threshold
    AND (filter_source IS NULL OR n.source = filter_source)
    AND (filter_tags   IS NULL OR n.tags   @> filter_tags)
    AND (search_text   IS NULL OR n.content_tsv @@ plainto_tsquery('english', search_text))
  ORDER BY n.embedding OPERATOR(extensions.<=>) query_embedding
  LIMIT match_count;
END;
$$;

-- ── find_similar_pairs: add p_user_id parameter ────────────

DROP FUNCTION IF EXISTS find_similar_pairs;

CREATE FUNCTION find_similar_pairs(
  p_user_id            uuid,
  similarity_threshold float DEFAULT 0.70,
  max_pairs            int   DEFAULT 10000
)
RETURNS TABLE (
  note_a     uuid,
  note_b     uuid,
  similarity float
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id AS note_a,
    b.id AS note_b,
    (1 - (a.embedding OPERATOR(extensions.<=>) b.embedding))::float AS similarity
  FROM public.notes a
  JOIN public.notes b ON a.id < b.id
  WHERE
    a.user_id = p_user_id
    AND b.user_id = p_user_id
    AND a.embedding IS NOT NULL
    AND b.embedding IS NOT NULL
    AND a.archived_at IS NULL
    AND b.archived_at IS NULL
    AND 1 - (a.embedding OPERATOR(extensions.<=>) b.embedding) > similarity_threshold
  ORDER BY similarity DESC
  LIMIT max_pairs;
END;
$$;
