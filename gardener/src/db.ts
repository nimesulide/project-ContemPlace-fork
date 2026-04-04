import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { NoteForSimilarity, SimilarityLink, NoteForEntityExtraction, DictionaryEntry, RawExtraction, ExtractedEntity } from './types';

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

// ── User discovery ───────────────────────────────────────────────────────────

// Fetch distinct user_ids from active notes — used by the cron orchestrator
// to iterate over all users that have data worth gardening.
export async function fetchActiveUserIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from('notes')
    .select('user_id')
    .is('archived_at', null);

  if (error) {
    throw new Error(`Failed to fetch active user IDs: ${error.message}`);
  }

  const ids = new Set((data as Array<{ user_id: string }> | null)?.map(r => r.user_id) ?? []);
  return [...ids];
}

// ── Similarity ───────────────────────────────────────────────────────────────

// Delete all gardener-created is-similar-to links for a user. Returns the count deleted.
// This is always the first operation of a gardener run — the clean-slate strategy
// ensures idempotency and keeps the link set consistent with the current threshold.
export async function deleteGardenerSimilarityLinks(db: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await db
    .from('links')
    .delete()
    .eq('link_type', 'is-similar-to')
    .eq('created_by', 'gardener')
    .eq('user_id', userId)
    .select('id');

  if (error) {
    throw new Error(`Failed to delete gardener similarity links: ${error.message}`);
  }

  return (data as Array<{ id: string }> | null)?.length ?? 0;
}

// Fetch all active notes with tags and created_at for a user.
// Embeddings are not fetched — similarity is computed by the find_similar_pairs RPC.
export async function fetchNotesForSimilarity(db: SupabaseClient, userId: string): Promise<NoteForSimilarity[]> {
  const { data, error } = await db
    .from('notes')
    .select('id, title, tags, created_at')
    .eq('user_id', userId)
    .is('archived_at', null)
    .not('embedding', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch notes for similarity: ${error.message}`);
  }

  const rows = (data as Array<{
    id: string;
    title: string;
    tags: string[] | null;
    created_at: string;
  }> | null) ?? [];

  return rows.map(row => ({
    id: row.id,
    title: row.title,
    tags: row.tags ?? [],
    created_at: row.created_at,
  }));
}

// Find all note pairs above a similarity threshold for a user in a single round-trip.
// Uses the find_similar_pairs RPC (self-join with a.id < b.id ordering).
// Replaces per-note findSimilarNotes calls — 1 subrequest instead of N.
export async function findSimilarPairs(
  db: SupabaseClient,
  threshold: number,
  maxPairs: number = 10000,
  userId: string,
): Promise<Array<{ note_a: string; note_b: string; similarity: number }>> {
  const { data, error } = await db.rpc('find_similar_pairs', {
    similarity_threshold: threshold,
    max_pairs: maxPairs,
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`find_similar_pairs RPC failed: ${error.message}`);
  }

  return ((data as Array<{
    note_a: string;
    note_b: string;
    similarity: number;
  }>) ?? []);
}

// Bulk insert similarity links for a user.
// ON CONFLICT DO NOTHING is a safety net — the clean-slate DELETE at run start
// means conflicts should not occur in normal operation.
export async function insertSimilarityLinks(
  db: SupabaseClient,
  links: SimilarityLink[],
  userId: string,
): Promise<void> {
  if (links.length === 0) return;

  const rows = links.map(l => ({
    from_id: l.fromId,
    to_id: l.toId,
    link_type: 'is-similar-to',
    confidence: l.confidence,
    context: l.context,
    created_by: 'gardener',
    user_id: userId,
  }));

  const { error } = await db.from('links').insert(rows);
  if (error) {
    throw new Error(`Failed to insert similarity links: ${error.message}`);
  }
}

// Delete all cluster rows for a user. Clean-slate before inserting fresh results.
export async function deleteAllClusters(db: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await db
    .from('clusters')
    .delete()
    .eq('user_id', userId)
    .select('id');

  if (error) {
    throw new Error(`Failed to delete clusters: ${error.message}`);
  }

  return (data as Array<{ id: string }> | null)?.length ?? 0;
}

// Insert cluster rows in bulk for a user.
export async function insertClusters(
  db: SupabaseClient,
  clusters: Array<{
    resolution: number;
    label: string;
    note_ids: string[];
    top_tags: string[];
    gravity: number;
    modularity: number | null;
  }>,
  userId: string,
): Promise<void> {
  if (clusters.length === 0) return;

  const rows = clusters.map(c => ({ ...c, user_id: userId }));
  const { error } = await db.from('clusters').insert(rows);
  if (error) {
    throw new Error(`Failed to insert clusters: ${error.message}`);
  }
}

// Log one enrichment_log row per note that received at least one new outbound link.
// Non-fatal: a logging failure does not roll back the links already inserted.
export async function logEnrichments(
  db: SupabaseClient,
  noteIds: string[],
  userId: string,
): Promise<void> {
  if (noteIds.length === 0) return;

  const rows = noteIds.map(id => ({
    note_id: id,
    enrichment_type: 'similarity_link',
    model_used: null,
    user_id: userId,
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'enrichment_log_error',
      error: error.message,
      noteCount: noteIds.length,
    }));
  }
}

// ── Entity extraction DB functions ────────────────────────────────────────────

// Fetch active notes that have NOT been entity-extracted yet for a user.
// Uses a left join on enrichment_log to find notes without 'entity_extraction' entries.
// Limited by batchSize (0 = unlimited).
export async function fetchNotesForEntityExtraction(
  db: SupabaseClient,
  batchSize: number,
  userId: string,
): Promise<NoteForEntityExtraction[]> {
  // Fetch all active notes for this user
  const { data: allNotes, error: notesErr } = await db
    .from('notes')
    .select('id, title, body, tags, created_at')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  if (notesErr) {
    throw new Error(`Failed to fetch notes for entity extraction: ${notesErr.message}`);
  }
  if (!allNotes || allNotes.length === 0) return [];

  // Fetch note IDs that already have entity_extraction in enrichment_log
  const { data: extractedRows, error: logErr } = await db
    .from('enrichment_log')
    .select('note_id')
    .eq('enrichment_type', 'entity_extraction')
    .eq('user_id', userId);

  if (logErr) {
    throw new Error(`Failed to fetch enrichment_log: ${logErr.message}`);
  }

  const extractedIds = new Set(
    (extractedRows as Array<{ note_id: string }> | null)?.map(r => r.note_id) ?? [],
  );

  // Filter to unprocessed notes
  const unprocessed = (allNotes as Array<{
    id: string;
    title: string;
    body: string;
    tags: string[] | null;
    created_at: string;
  }>)
    .filter(n => !extractedIds.has(n.id))
    .map(n => ({
      id: n.id,
      title: n.title,
      body: n.body,
      tags: n.tags ?? [],
      created_at: n.created_at,
    }));

  if (batchSize > 0) {
    return unprocessed.slice(0, batchSize);
  }
  return unprocessed;
}

// Fetch all raw extractions from enrichment_log for active notes of a user.
// Returns the per-note entity lists stored in metadata during previous runs.
export async function fetchAllRawExtractions(
  db: SupabaseClient,
  userId: string,
): Promise<RawExtraction[]> {
  // Get all entity_extraction enrichment entries for this user
  const { data: logRows, error: logErr } = await db
    .from('enrichment_log')
    .select('note_id, metadata')
    .eq('enrichment_type', 'entity_extraction')
    .eq('user_id', userId);

  if (logErr) {
    throw new Error(`Failed to fetch entity extraction log: ${logErr.message}`);
  }
  if (!logRows || logRows.length === 0) return [];

  // Get active note IDs to filter out archived notes
  const { data: activeRows, error: activeErr } = await db
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .is('archived_at', null);

  if (activeErr) {
    throw new Error(`Failed to fetch active notes: ${activeErr.message}`);
  }

  const activeIds = new Set(
    (activeRows as Array<{ id: string }> | null)?.map(r => r.id) ?? [],
  );

  const extractions: RawExtraction[] = [];
  for (const row of logRows as Array<{ note_id: string; metadata: unknown }>) {
    if (!activeIds.has(row.note_id)) continue;
    const metadata = row.metadata as { entities?: unknown } | null;
    if (!metadata || !Array.isArray(metadata.entities)) continue;

    const entities = (metadata.entities as unknown[]).filter(
      (e): e is ExtractedEntity =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as Record<string, unknown>)['name'] === 'string' &&
        typeof (e as Record<string, unknown>)['type'] === 'string',
    );

    if (entities.length > 0) {
      extractions.push({ noteId: row.note_id, entities });
    }
  }

  return extractions;
}

// Fetch all active note created_at timestamps for a user — needed for first_seen/last_seen.
export async function fetchNoteCreatedAts(
  db: SupabaseClient,
  userId: string,
): Promise<Map<string, string>> {
  const { data, error } = await db
    .from('notes')
    .select('id, created_at')
    .eq('user_id', userId)
    .is('archived_at', null);

  if (error) {
    throw new Error(`Failed to fetch note timestamps: ${error.message}`);
  }

  const map = new Map<string, string>();
  for (const row of (data as Array<{ id: string; created_at: string }>) ?? []) {
    map.set(row.id, row.created_at);
  }
  return map;
}

// Log entity extraction results in enrichment_log with raw entities in metadata.
export async function logEntityExtractions(
  db: SupabaseClient,
  extractions: RawExtraction[],
  modelUsed: string,
  userId: string,
): Promise<void> {
  if (extractions.length === 0) return;

  const rows = extractions.map(e => ({
    note_id: e.noteId,
    enrichment_type: 'entity_extraction',
    model_used: modelUsed,
    metadata: { entities: e.entities },
    user_id: userId,
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    throw new Error(`Failed to log entity extractions: ${error.message}`);
  }
}

// Clean-slate delete + insert for the entity dictionary for a user.
export async function rebuildEntityDictionary(
  db: SupabaseClient,
  entries: DictionaryEntry[],
  userId: string,
): Promise<{ deleted: number; inserted: number }> {
  // Delete all existing entries for this user
  const { data: deletedRows, error: delErr } = await db
    .from('entity_dictionary')
    .delete()
    .eq('user_id', userId)
    .select('id');

  if (delErr) {
    throw new Error(`Failed to delete entity dictionary: ${delErr.message}`);
  }
  const deleted = (deletedRows as Array<{ id: string }> | null)?.length ?? 0;

  if (entries.length === 0) return { deleted, inserted: 0 };

  // Insert new entries
  const rows = entries.map(e => ({
    name: e.name,
    type: e.type,
    aliases: e.aliases,
    note_count: e.note_count,
    note_ids: e.note_ids,
    first_seen: e.first_seen,
    last_seen: e.last_seen,
    user_id: userId,
  }));

  const { error: insErr } = await db.from('entity_dictionary').insert(rows);
  if (insErr) {
    throw new Error(`Failed to insert entity dictionary: ${insErr.message}`);
  }

  return { deleted, inserted: entries.length };
}

// Batch update notes.entities for multiple notes of a user.
export async function batchUpdateNoteEntities(
  db: SupabaseClient,
  updates: Map<string, ExtractedEntity[]>,
  userId: string,
): Promise<number> {
  let updated = 0;
  for (const [noteId, entities] of updates) {
    const { error } = await db
      .from('notes')
      .update({ entities })
      .eq('id', noteId)
      .eq('user_id', userId);

    if (error) {
      console.error(JSON.stringify({
        event: 'note_entities_update_error',
        noteId,
        error: error.message,
      }));
    } else {
      updated++;
    }
  }
  return updated;
}

// Fetch the current entity dictionary for a user (for passing to extraction prompt).
export async function fetchEntityDictionary(
  db: SupabaseClient,
  userId: string,
): Promise<Array<{ name: string; type: string }>> {
  const { data, error } = await db
    .from('entity_dictionary')
    .select('name, type')
    .eq('user_id', userId)
    .order('note_count', { ascending: false });

  if (error) {
    console.warn(JSON.stringify({
      event: 'entity_dictionary_fetch_error',
      error: error.message,
    }));
    return [];
  }

  return (data as Array<{ name: string; type: string }>) ?? [];
}
