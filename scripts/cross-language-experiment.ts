// READ-ONLY SCRIPT — never writes to the database.
// Cross-language embedding experiment: tests whether Hungarian raw_input
// degrades retrieval of related English corpus notes.
//
// Usage: npx tsx scripts/cross-language-experiment.ts
//
// Reads credentials from .dev.vars at runtime. Never logs secrets.
// Requires scripts/hungarian-translations.json mapping note UUIDs to Hungarian text.

import { readFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ── Env loading (secrets stay in-process, never logged) ─────────────────────

function loadEnv(): Record<string, string> {
  const path = '.dev.vars';
  if (!existsSync(path)) {
    throw new Error('.dev.vars not found — run from project root');
  }
  const content = readFileSync(path, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    vars[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return vars;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface Note {
  id: string;
  title: string;
  raw_input: string;
  body: string;
  tags: string[];
  source: string;
  embedding: number[];
}

interface Link {
  id: string;
  from_id: string;
  to_id: string;
  link_type: string;
  created_by: string;
}

interface ConditionResult {
  label: string;
  embedding: number[];
  scores: Map<string, number>;       // noteId → cosine similarity
  top5: Array<{ id: string; title: string; score: number }>;
  relatedRanks: Map<string, number>;  // relatedNoteId → rank (1-based)
  relatedScores: Map<string, number>; // relatedNoteId → score
}

interface SampleReport {
  noteId: string;
  title: string;
  relatedIds: string[];
  conditions: ConditionResult[];
}

// ── Math ────────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  // text-embedding-3-small produces L2-normalized vectors, so cosine = dot product
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

// ── Data fetching (read-only) ───────────────────────────────────────────────

async function fetchNotes(supabaseUrl: string, serviceRoleKey: string): Promise<Note[]> {
  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await db
    .from('notes')
    .select('id, title, raw_input, body, tags, source, embedding, archived_at')
    .is('archived_at', null)
    .not('embedding', 'is', null);

  if (error) throw new Error(`Failed to fetch notes: ${error.message}`);

  return ((data as Array<{
    id: string;
    title: string;
    raw_input: string | null;
    body: string | null;
    tags: string[] | null;
    source: string;
    embedding: number[] | string;
  }>) ?? []).map(row => ({
    id: row.id,
    title: row.title,
    raw_input: row.raw_input ?? '',
    body: row.body ?? '',
    tags: row.tags ?? [],
    source: row.source,
    embedding: typeof row.embedding === 'string'
      ? (JSON.parse(row.embedding) as number[])
      : row.embedding,
  }));
}

async function fetchCaptureLinks(supabaseUrl: string, serviceRoleKey: string): Promise<Link[]> {
  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await db
    .from('links')
    .select('id, from_id, to_id, link_type, created_by')
    .neq('created_by', 'gardener');

  if (error) throw new Error(`Failed to fetch links: ${error.message}`);

  return (data as Link[]) ?? [];
}

// ── Embedding ───────────────────────────────────────────────────────────────

async function embedText(
  client: OpenAI,
  model: string,
  text: string,
): Promise<number[]> {
  const response = await client.embeddings.create({
    model,
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('Embedding API returned no data');
  }
  return embedding;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Formatting ──────────────────────────────────────────────────────────────

function printHeader(text: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` ${text}`);
  console.log('═'.repeat(70));
}

function printSubheader(text: string): void {
  console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 65 - text.length))}`);
}

// ── Core analysis ───────────────────────────────────────────────────────────

function findRelatedNotes(noteId: string, links: Link[]): string[] {
  const related = new Set<string>();
  for (const link of links) {
    if (link.from_id === noteId) related.add(link.to_id);
    if (link.to_id === noteId) related.add(link.from_id);
  }
  return [...related];
}

function rankAllNotes(
  embedding: number[],
  corpusNotes: Note[],
  excludeId: string,
): Array<{ id: string; title: string; score: number }> {
  const scored = corpusNotes
    .filter(n => n.id !== excludeId)
    .map(n => ({
      id: n.id,
      title: n.title,
      score: cosineSimilarity(embedding, n.embedding),
    }))
    .sort((a, b) => b.score - a.score);
  return scored;
}

async function analyzeOneSample(
  sampleNote: Note,
  hungarianText: string,
  relatedIds: string[],
  corpusNotes: Note[],
  client: OpenAI,
  embedModel: string,
): Promise<SampleReport> {
  const conditionDefs = [
    { label: 'EN raw_input (bare)', text: sampleNote.raw_input },
    { label: 'HU raw_input (bare)', text: hungarianText },
    { label: 'EN body', text: sampleNote.body },
    {
      label: 'EN augmented',
      text: sampleNote.tags.length > 0
        ? `[Tags: ${sampleNote.tags.join(', ')}] ${sampleNote.raw_input}`
        : sampleNote.raw_input,
    },
    {
      label: 'HU augmented',
      text: sampleNote.tags.length > 0
        ? `[Tags: ${sampleNote.tags.join(', ')}] ${hungarianText}`
        : hungarianText,
    },
  ];

  const conditions: ConditionResult[] = [];

  for (const def of conditionDefs) {
    process.stdout.write(`    ${def.label}...`);
    const emb = await embedText(client, embedModel, def.text);
    await sleep(100); // rate limit courtesy

    const ranked = rankAllNotes(emb, corpusNotes, sampleNote.id);
    const top5 = ranked.slice(0, 5);

    const scores = new Map<string, number>();
    for (const r of ranked) scores.set(r.id, r.score);

    const relatedRanks = new Map<string, number>();
    const relatedScores = new Map<string, number>();
    for (const relId of relatedIds) {
      const idx = ranked.findIndex(r => r.id === relId);
      if (idx >= 0) {
        relatedRanks.set(relId, idx + 1);
        relatedScores.set(relId, ranked[idx]!.score);
      }
    }

    conditions.push({
      label: def.label,
      embedding: emb,
      scores,
      top5,
      relatedRanks,
      relatedScores,
    });

    console.log(` done`);
  }

  return {
    noteId: sampleNote.id,
    title: sampleNote.title,
    relatedIds,
    conditions,
  };
}

// ── Per-sample report ───────────────────────────────────────────────────────

function printSampleReport(report: SampleReport, noteMap: Map<string, Note>): void {
  printSubheader(`"${report.title}" (${report.noteId.slice(0, 8)}…)`);

  if (report.relatedIds.length === 0) {
    console.log('  No capture-time links found for this note.');
  } else {
    console.log(`  Known related notes (${report.relatedIds.length}):`);
    for (const relId of report.relatedIds) {
      const relNote = noteMap.get(relId);
      console.log(`    ${relId.slice(0, 8)}… "${relNote?.title ?? '(unknown)'}"`);
    }
  }

  const GARDENER_THRESHOLD = 0.65;
  const CAPTURE_THRESHOLD = 0.35;

  for (const cond of report.conditions) {
    console.log(`\n  [${cond.label}]`);

    if (report.relatedIds.length > 0) {
      console.log('    Related note scores:');
      for (const relId of report.relatedIds) {
        const score = cond.relatedScores.get(relId);
        const rank = cond.relatedRanks.get(relId);
        const relNote = noteMap.get(relId);
        if (score !== undefined && rank !== undefined) {
          const aboveGardener = score >= GARDENER_THRESHOLD ? '✓' : '✗';
          const aboveCapture = score >= CAPTURE_THRESHOLD ? '✓' : '✗';
          console.log(
            `      ${score.toFixed(4)}  rank #${rank}  ` +
            `≥0.65:${aboveGardener}  ≥0.35:${aboveCapture}  ` +
            `"${relNote?.title ?? relId.slice(0, 8)}"`,
          );
        } else {
          console.log(`      (not found in corpus) ${relId.slice(0, 8)}…`);
        }
      }
    }

    console.log('    Top-5:');
    for (let i = 0; i < cond.top5.length; i++) {
      const r = cond.top5[i]!;
      const isRelated = report.relatedIds.includes(r.id) ? ' ← RELATED' : '';
      console.log(`      ${i + 1}. ${r.score.toFixed(4)}  "${r.title}"${isRelated}`);
    }
  }
}

// ── Aggregate metrics ───────────────────────────────────────────────────────

function computeAggregates(reports: SampleReport[], noteMap: Map<string, Note>): void {
  printHeader('AGGREGATE METRICS');

  // Condition indices: 0=EN bare, 1=HU bare, 2=EN body, 3=EN augmented, 4=HU augmented

  // Collect all (sample, related) pairs that have scores across all conditions
  const pairs: Array<{
    sampleId: string;
    relatedId: string;
    scores: number[]; // indexed by condition
    ranks: number[];  // indexed by condition
  }> = [];

  for (const report of reports) {
    for (const relId of report.relatedIds) {
      const scores: number[] = [];
      const ranks: number[] = [];
      let allPresent = true;

      for (const cond of report.conditions) {
        const s = cond.relatedScores.get(relId);
        const r = cond.relatedRanks.get(relId);
        if (s !== undefined && r !== undefined) {
          scores.push(s);
          ranks.push(r);
        } else {
          allPresent = false;
          break;
        }
      }

      if (allPresent && scores.length === 5) {
        pairs.push({ sampleId: report.noteId, relatedId: relId, scores, ranks });
      }
    }
  }

  console.log(`\nAnalyzed ${reports.length} sample notes, ${pairs.length} known-related pairs with scores across all 5 conditions.`);

  if (pairs.length === 0) {
    console.log('No pairs with complete data — cannot compute aggregates.');
    return;
  }

  const condLabels = ['EN bare', 'HU bare', 'EN body', 'EN augmented', 'HU augmented'];

  // ── Mean score per condition ──────────────────────────────────────────────
  printSubheader('Mean score for known-related pairs by condition');
  for (let c = 0; c < 5; c++) {
    const mean = pairs.reduce((sum, p) => sum + p.scores[c]!, 0) / pairs.length;
    console.log(`  ${condLabels[c]!.padEnd(16)} ${mean.toFixed(4)}`);
  }

  // ── Score deltas ──────────────────────────────────────────────────────────
  printSubheader('Score deltas (known-related pairs)');

  const enBareVsHuBare = pairs.map(p => p.scores[0]! - p.scores[1]!);
  const meanDeltaBareEnHu = enBareVsHuBare.reduce((s, d) => s + d, 0) / enBareVsHuBare.length;
  console.log(`  EN bare − HU bare:           mean Δ = ${meanDeltaBareEnHu.toFixed(4)}  (${meanDeltaBareEnHu > 0 ? 'EN higher' : 'HU higher'})`);

  const enAugVsHuAug = pairs.map(p => p.scores[3]! - p.scores[4]!);
  const meanDeltaAugEnHu = enAugVsHuAug.reduce((s, d) => s + d, 0) / enAugVsHuAug.length;
  console.log(`  EN aug  − HU aug:            mean Δ = ${meanDeltaAugEnHu.toFixed(4)}  (${meanDeltaAugEnHu > 0 ? 'EN higher' : 'HU higher'})`);

  const tagAnchoringEffect = pairs.map(p => p.scores[4]! - p.scores[1]!);
  const meanTagAnchoring = tagAnchoringEffect.reduce((s, d) => s + d, 0) / tagAnchoringEffect.length;
  console.log(`  HU aug  − HU bare (tag fx):  mean Δ = ${meanTagAnchoring.toFixed(4)}  (${meanTagAnchoring > 0 ? 'tags help' : 'tags hurt'})`);

  const bodyVsRaw = pairs.map(p => p.scores[2]! - p.scores[0]!);
  const meanBodyVsRaw = bodyVsRaw.reduce((s, d) => s + d, 0) / bodyVsRaw.length;
  console.log(`  EN body − EN bare:           mean Δ = ${meanBodyVsRaw.toFixed(4)}  (${meanBodyVsRaw > 0 ? 'body higher' : 'raw higher'})`);

  // ── Recall@5 ──────────────────────────────────────────────────────────────
  printSubheader('Recall@5 (fraction of known-related notes in top-5)');
  for (let c = 0; c < 5; c++) {
    const inTop5 = pairs.filter(p => p.ranks[c]! <= 5).length;
    const recall = inTop5 / pairs.length;
    console.log(`  ${condLabels[c]!.padEnd(16)} ${recall.toFixed(3)}  (${inTop5}/${pairs.length})`);
  }

  // ── MRR ───────────────────────────────────────────────────────────────────
  printSubheader('MRR (mean reciprocal rank of known-related notes)');
  for (let c = 0; c < 5; c++) {
    const mrr = pairs.reduce((sum, p) => sum + 1.0 / p.ranks[c]!, 0) / pairs.length;
    console.log(`  ${condLabels[c]!.padEnd(16)} ${mrr.toFixed(4)}`);
  }

  // ── Threshold crossings ───────────────────────────────────────────────────
  printSubheader('Threshold crossings (gardener ≥0.65)');
  const crossingsBareHu = pairs.filter(p => p.scores[0]! >= 0.65 && p.scores[1]! < 0.65).length;
  const crossingsAugHu = pairs.filter(p => p.scores[3]! >= 0.65 && p.scores[4]! < 0.65).length;
  console.log(`  Above 0.65 in EN bare but below in HU bare: ${crossingsBareHu}/${pairs.length}`);
  console.log(`  Above 0.65 in EN aug  but below in HU aug:  ${crossingsAugHu}/${pairs.length}`);

  // ── Top-5 Jaccard ─────────────────────────────────────────────────────────
  printSubheader('Top-5 Jaccard similarity (overlap between EN and HU result sets)');

  function jaccard(setA: Set<string>, setB: Set<string>): number {
    let intersection = 0;
    for (const item of setA) if (setB.has(item)) intersection++;
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }

  let jaccardBareSum = 0;
  let jaccardAugSum = 0;
  let jaccardCount = 0;

  for (const report of reports) {
    const enBareTop5 = new Set(report.conditions[0]!.top5.map(r => r.id));
    const huBareTop5 = new Set(report.conditions[1]!.top5.map(r => r.id));
    const enAugTop5 = new Set(report.conditions[3]!.top5.map(r => r.id));
    const huAugTop5 = new Set(report.conditions[4]!.top5.map(r => r.id));

    jaccardBareSum += jaccard(enBareTop5, huBareTop5);
    jaccardAugSum += jaccard(enAugTop5, huAugTop5);
    jaccardCount++;
  }

  const meanJaccardBare = jaccardBareSum / jaccardCount;
  const meanJaccardAug = jaccardAugSum / jaccardCount;
  console.log(`  EN bare vs HU bare:  mean Jaccard = ${meanJaccardBare.toFixed(3)}`);
  console.log(`  EN aug  vs HU aug:   mean Jaccard = ${meanJaccardAug.toFixed(3)}`);

  // ── EN body vs EN raw_input ───────────────────────────────────────────────
  printSubheader('EN body vs EN raw_input as embedding source');
  const bodyWins = pairs.filter(p => p.scores[2]! > p.scores[0]!).length;
  const rawWins = pairs.filter(p => p.scores[0]! > p.scores[2]!).length;
  const ties = pairs.filter(p => Math.abs(p.scores[0]! - p.scores[2]!) < 0.001).length;
  console.log(`  Body wins: ${bodyWins}  |  Raw wins: ${rawWins}  |  Ties (<0.001): ${ties}`);
  console.log(`  Verdict: ${meanBodyVsRaw > 0.005 ? 'Body is better' : meanBodyVsRaw < -0.005 ? 'Raw input is better' : 'Essentially equivalent'} (mean Δ = ${meanBodyVsRaw.toFixed(4)})`);

  // ── Decision summary ──────────────────────────────────────────────────────
  printHeader('DECISION SUMMARY');

  const primaryDelta = Math.abs(meanDeltaBareEnHu);
  const primaryCrossings = crossingsBareHu;
  const primaryJaccard = meanJaccardBare;

  console.log(`\n  Primary metrics (EN bare vs HU bare):`);
  console.log(`    Mean |Δ|:              ${primaryDelta.toFixed(4)}  ${primaryDelta < 0.05 ? '(< 0.05 ✓)' : primaryDelta <= 0.10 ? '(0.05–0.10 ⚠)' : '(> 0.10 ✗)'}`);
  console.log(`    Threshold crossings:   ${primaryCrossings}  ${primaryCrossings <= 1 ? '(≤ 1 ✓)' : primaryCrossings <= 5 ? '(2–5 ⚠)' : '(> 5 ✗)'}`);
  console.log(`    Top-5 Jaccard:         ${primaryJaccard.toFixed(3)}  ${primaryJaccard >= 0.80 ? '(≥ 0.80 ✓)' : primaryJaccard >= 0.60 ? '(0.60–0.80 ⚠)' : '(< 0.60 ✗)'}`);

  // Determine verdict
  let verdict: string;
  if (primaryDelta < 0.05 && primaryCrossings <= 1 && primaryJaccard >= 0.80) {
    verdict = 'NO ACTION NEEDED — Hungarian input does not meaningfully degrade retrieval.';
  } else if (primaryDelta > 0.10 || primaryCrossings > 5 || primaryJaccard < 0.60) {
    verdict = 'CHANGE EMBEDDING SOURCE — Hungarian input significantly degrades retrieval. Consider pre-translation or augmented embedding.';
  } else {
    verdict = 'INVESTIGATE MITIGATION — moderate degradation detected. Tag augmentation or bilingual embedding may help.';
  }

  console.log(`\n  → ${verdict}`);

  // Secondary metrics for context
  console.log(`\n  Secondary (augmented conditions):`);
  console.log(`    Mean |Δ| (aug):        ${Math.abs(meanDeltaAugEnHu).toFixed(4)}`);
  console.log(`    Crossings (aug):       ${crossingsAugHu}`);
  console.log(`    Jaccard (aug):         ${meanJaccardAug.toFixed(3)}`);
  console.log(`    Tag anchoring effect:  ${meanTagAnchoring.toFixed(4)} (${meanTagAnchoring > 0 ? 'tags help recover HU scores' : 'tags do not help'})`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadEnv();
  const supabaseUrl = env['SUPABASE_URL'];
  const serviceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY'];
  const openrouterKey = env['OPENROUTER_API_KEY'];

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .dev.vars');
  }
  if (!openrouterKey) {
    throw new Error('OPENROUTER_API_KEY required in .dev.vars');
  }

  const embedModel = env['EMBED_MODEL'] || 'openai/text-embedding-3-small';

  const client = new OpenAI({
    apiKey: openrouterKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/freegyes/project-ContemPlace',
      'X-Title': 'ContemPlace',
    },
  });

  // Load Hungarian translations
  const translationsPath = 'scripts/hungarian-translations.json';
  if (!existsSync(translationsPath)) {
    throw new Error('scripts/hungarian-translations.json not found — run from project root');
  }
  const translations: Record<string, string> = JSON.parse(readFileSync(translationsPath, 'utf-8'));
  const sampleIds = Object.keys(translations);

  console.log(`\nCross-Language Embedding Experiment`);
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Model: ${embedModel}`);
  console.log(`Samples: ${sampleIds.length} notes with Hungarian translations`);

  // Fetch all active notes with embeddings
  console.log('\nFetching corpus notes...');
  const notes = await fetchNotes(supabaseUrl, serviceRoleKey);
  console.log(`  ${notes.length} active notes with embeddings`);

  const noteMap = new Map(notes.map(n => [n.id, n]));

  // Fetch capture-time links
  console.log('Fetching capture-time links...');
  const links = await fetchCaptureLinks(supabaseUrl, serviceRoleKey);
  console.log(`  ${links.length} capture-time links`);

  // Validate sample notes exist in corpus
  const missingSamples = sampleIds.filter(id => !noteMap.has(id));
  if (missingSamples.length > 0) {
    console.log(`\nWarning: ${missingSamples.length} sample note(s) not found in corpus (archived or missing):`);
    for (const id of missingSamples) console.log(`  ${id}`);
  }

  const validSamples = sampleIds.filter(id => noteMap.has(id));
  console.log(`\nProcessing ${validSamples.length} sample notes (5 embedding calls each = ${validSamples.length * 5} total API calls)...\n`);

  // Analyze each sample
  printHeader('PER-SAMPLE RESULTS');

  const reports: SampleReport[] = [];
  for (let i = 0; i < validSamples.length; i++) {
    const noteId = validSamples[i]!;
    const sampleNote = noteMap.get(noteId)!;
    const hungarianText = translations[noteId]!;
    const relatedIds = findRelatedNotes(noteId, links);

    console.log(`\n  [${i + 1}/${validSamples.length}] "${sampleNote.title}" (${relatedIds.length} related notes)`);

    const report = await analyzeOneSample(
      sampleNote,
      hungarianText,
      relatedIds,
      notes,
      client,
      embedModel,
    );
    reports.push(report);
    printSampleReport(report, noteMap);
  }

  // Aggregate metrics
  computeAggregates(reports, noteMap);

  printHeader('Experiment Complete');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
