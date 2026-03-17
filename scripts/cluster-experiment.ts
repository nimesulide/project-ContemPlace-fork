// READ-ONLY SCRIPT — never writes to the database.
// Clustering experiment for issue #152: validate weighted graph clustering
// against the live corpus before building gardener infrastructure (#144).
//
// Usage: npx tsx scripts/cluster-experiment.ts
//        npx tsx scripts/cluster-experiment.ts --floor=0.25
//
// Reads credentials from .dev.vars at runtime. Never logs secrets.

import { readFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

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
  tags: string[];
  embedding: number[];
  created_at: string;
}

interface Link {
  from_id: string;
  to_id: string;
  link_type: string;
  created_by: string;
}

interface WeightConfig {
  name: string;
  alpha: number; // cosine similarity
  beta: number;  // tag jaccard
  gamma: number; // explicit links (capture-time only)
  delta: number; // is-similar-to links (gardener)
}

interface ClusterResult {
  config: WeightConfig;
  resolution: number;
  communities: Map<string, string[]>; // communityId → noteIds
  modularity: number;
  assignment: Record<string, string>; // noteId → communityId
}

// ── Math ────────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  // text-embedding-3-small produces L2-normalized vectors, so cosine = dot product
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a.map(t => t.toLowerCase()));
  const setB = new Set(b.map(t => t.toLowerCase()));
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Data fetching (read-only) ───────────────────────────────────────────────

async function fetchNotes(supabaseUrl: string, serviceRoleKey: string): Promise<Note[]> {
  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await db
    .from('notes')
    .select('id, title, tags, embedding, created_at')
    .is('archived_at', null)
    .not('embedding', 'is', null);

  if (error) throw new Error(`Failed to fetch notes: ${error.message}`);

  return ((data as Array<{
    id: string;
    title: string;
    tags: string[] | null;
    embedding: number[] | string;
    created_at: string;
  }>) ?? []).map(row => ({
    id: row.id,
    title: row.title,
    tags: row.tags ?? [],
    embedding: typeof row.embedding === 'string'
      ? (JSON.parse(row.embedding) as number[])
      : row.embedding,
    created_at: row.created_at,
  }));
}

async function fetchLinks(supabaseUrl: string, serviceRoleKey: string): Promise<Link[]> {
  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await db
    .from('links')
    .select('from_id, to_id, link_type, created_by');

  if (error) throw new Error(`Failed to fetch links: ${error.message}`);
  return (data as Link[]) ?? [];
}

// ── Graph building ──────────────────────────────────────────────────────────

function buildGraph(
  notes: Note[],
  links: Link[],
  config: WeightConfig,
  cosineFloor: number,
): Graph {
  const graph = new Graph({ type: 'undirected' });

  // Add all notes as nodes
  for (const note of notes) {
    graph.addNode(note.id, { title: note.title, tags: note.tags });
  }

  // Index links for fast lookup: "id1:id2" → { capture: bool, gardener: bool }
  const linkIndex = new Map<string, { capture: boolean; gardener: boolean }>();
  for (const link of links) {
    const key = [link.from_id, link.to_id].sort().join(':');
    const existing = linkIndex.get(key) ?? { capture: false, gardener: false };
    if (link.created_by === 'gardener') {
      existing.gardener = true;
    } else {
      existing.capture = true;
    }
    linkIndex.set(key, existing);
  }

  // All-pairs: compute combined weight
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i]!;
      const b = notes[j]!;

      const cosine = cosineSimilarity(a.embedding, b.embedding);
      if (cosine < cosineFloor && config.beta === 0 && config.gamma === 0 && config.delta === 0) {
        continue; // Skip if only cosine matters and it's below floor
      }

      const cosineWeight = cosine >= cosineFloor ? cosine : 0;
      const jaccard = jaccardSimilarity(a.tags, b.tags);

      const pairKey = [a.id, b.id].sort().join(':');
      const linkInfo = linkIndex.get(pairKey);
      const captureLink = linkInfo?.capture ? 1.0 : 0;
      const gardenerLink = linkInfo?.gardener ? 1.0 : 0;

      const weight =
        config.alpha * cosineWeight +
        config.beta * jaccard +
        config.gamma * captureLink +
        config.delta * gardenerLink;

      if (weight > 0) {
        graph.addEdge(a.id, b.id, { weight });
      }
    }
  }

  return graph;
}

// ── Clustering ──────────────────────────────────────────────────────────────

function runClustering(
  graph: Graph,
  config: WeightConfig,
  resolution: number,
): ClusterResult {
  // graphology-communities-louvain returns { nodeId: communityIndex }
  // and can return modularity via getModularity option
  const assignment = louvain(graph, {
    resolution,
    getEdgeWeight: 'weight',
  }) as Record<string, string>;

  // Group by community
  const communities = new Map<string, string[]>();
  for (const [nodeId, communityId] of Object.entries(assignment)) {
    const comm = String(communityId);
    if (!communities.has(comm)) communities.set(comm, []);
    communities.get(comm)!.push(nodeId);
  }

  // Compute modularity manually
  const modularity = louvain.detailed(graph, {
    resolution,
    getEdgeWeight: 'weight',
  }).modularity;

  return { config, resolution, communities, modularity, assignment };
}

// ── Boundary analysis ───────────────────────────────────────────────────────

interface BoundaryNode {
  noteId: string;
  title: string;
  ownCommunity: string;
  internalWeight: number;
  externalWeight: number;
  externalRatio: number;
  strongestPull: string; // community with most external weight
  strongestPullWeight: number;
}

function findBoundaryNodes(
  graph: Graph,
  assignment: Record<string, string>,
  noteMap: Map<string, Note>,
  threshold: number = 0.3,
): BoundaryNode[] {
  const boundaries: BoundaryNode[] = [];

  for (const nodeId of graph.nodes()) {
    const ownComm = assignment[nodeId]!;
    let internalWeight = 0;
    let externalWeight = 0;
    const externalByCommunity = new Map<string, number>();

    graph.forEachEdge(nodeId, (_edge, attrs, source, target) => {
      // For undirected graphs, source/target order varies — pick the other node
      const neighbor = source === nodeId ? target : source;
      const neighborComm = assignment[neighbor]!;
      const w = (attrs as { weight: number }).weight;
      if (neighborComm === ownComm) {
        internalWeight += w;
      } else {
        externalWeight += w;
        externalByCommunity.set(
          neighborComm,
          (externalByCommunity.get(neighborComm) ?? 0) + w,
        );
      }
    });

    const totalWeight = internalWeight + externalWeight;
    if (totalWeight === 0) continue;

    const externalRatio = externalWeight / totalWeight;
    if (externalRatio < threshold) continue;

    let strongestPull = '';
    let strongestPullWeight = 0;
    for (const [comm, w] of externalByCommunity) {
      if (w > strongestPullWeight) {
        strongestPull = comm;
        strongestPullWeight = w;
      }
    }

    const note = noteMap.get(nodeId);
    boundaries.push({
      noteId: nodeId,
      title: note?.title ?? nodeId,
      ownCommunity: ownComm,
      internalWeight,
      externalWeight,
      externalRatio,
      strongestPull,
      strongestPullWeight,
    });
  }

  return boundaries.sort((a, b) => b.externalRatio - a.externalRatio);
}

// ── Report formatting ───────────────────────────────────────────────────────

function printHeader(text: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` ${text}`);
  console.log('═'.repeat(60));
}

function printSubheader(text: string): void {
  console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 55 - text.length))}`);
}

function printClusterResult(
  result: ClusterResult,
  noteMap: Map<string, Note>,
): void {
  const sorted = [...result.communities.entries()]
    .sort((a, b) => b[1].length - a[1].length);

  const singletons = sorted.filter(([, members]) => members.length === 1);
  const clusters = sorted.filter(([, members]) => members.length > 1);

  console.log(`Clusters: ${clusters.length}  |  Singletons: ${singletons.length}  |  Modularity: ${result.modularity.toFixed(3)}`);

  for (const [commId, members] of clusters) {
    // Aggregate tags
    const tagCounts = new Map<string, number>();
    for (const id of members) {
      const note = noteMap.get(id);
      if (!note) continue;
      for (const tag of note.tags) {
        const t = tag.toLowerCase();
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => `${tag}(${count})`);

    console.log(`\n  Cluster ${commId} (${members.length} notes) [${topTags.join(', ')}]`);
    for (const id of members) {
      const note = noteMap.get(id);
      if (note) {
        console.log(`    - ${note.title}`);
      }
    }
  }

  if (singletons.length > 0) {
    console.log(`\n  Unclustered (${singletons.length} singletons):`);
    for (const [, members] of singletons) {
      const note = noteMap.get(members[0]!);
      if (note) console.log(`    - ${note.title}`);
    }
  }
}

function printTagStats(notes: Note[]): void {
  printSubheader('Tag Statistics');
  const allTags = new Map<string, number>();
  let totalTags = 0;
  for (const note of notes) {
    for (const tag of note.tags) {
      const t = tag.toLowerCase();
      allTags.set(t, (allTags.get(t) ?? 0) + 1);
      totalTags++;
    }
  }

  // Pairs sharing at least one tag
  let pairsWithSharedTag = 0;
  const totalPairs = (notes.length * (notes.length - 1)) / 2;
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      if (jaccardSimilarity(notes[i]!.tags, notes[j]!.tags) > 0) {
        pairsWithSharedTag++;
      }
    }
  }

  console.log(`Unique tags: ${allTags.size}`);
  console.log(`Total tag assignments: ${totalTags}`);
  console.log(`Avg tags/note: ${(totalTags / notes.length).toFixed(1)}`);
  console.log(`Pairs sharing >= 1 tag: ${pairsWithSharedTag} / ${totalPairs} (${(100 * pairsWithSharedTag / totalPairs).toFixed(1)}%)`);

  // Most common tags
  const sorted = [...allTags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`Top tags: ${sorted.map(([t, c]) => `${t}(${c})`).join(', ')}`);
}

function printEdgeStats(
  notes: Note[],
  links: Link[],
  cosineFloor: number,
): void {
  printSubheader('Edge Statistics');

  // Cosine edges
  let cosineEdges = 0;
  let cosineSum = 0;
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const sim = cosineSimilarity(notes[i]!.embedding, notes[j]!.embedding);
      if (sim >= cosineFloor) {
        cosineEdges++;
        cosineSum += sim;
      }
    }
  }

  const captureLinks = links.filter(l => l.created_by !== 'gardener');
  const gardenerLinks = links.filter(l => l.created_by === 'gardener');

  const totalPairs = (notes.length * (notes.length - 1)) / 2;
  console.log(`Total possible pairs: ${totalPairs}`);
  console.log(`Cosine edges (>= ${cosineFloor}): ${cosineEdges} (avg sim: ${cosineEdges > 0 ? (cosineSum / cosineEdges).toFixed(3) : 'n/a'})`);
  console.log(`Capture-time links (related/contradicts): ${captureLinks.length}`);
  console.log(`Gardener links (is-similar-to): ${gardenerLinks.length}`);
}

// ── Overlap analysis across resolutions ─────────────────────────────────────

function printOverlapAnalysis(
  results: ClusterResult[],
  noteMap: Map<string, Note>,
): void {
  printSubheader('Resolution Overlap Analysis');

  // For each note, collect community assignments at each resolution
  const noteResolutions = new Map<string, Map<number, string>>();
  for (const result of results) {
    for (const [noteId, comm] of Object.entries(result.assignment)) {
      if (!noteResolutions.has(noteId)) noteResolutions.set(noteId, new Map());
      noteResolutions.get(noteId)!.set(result.resolution, comm);
    }
  }

  // Find notes that change communities
  const movers: Array<{ title: string; assignments: string }> = [];
  for (const [noteId, resMap] of noteResolutions) {
    const communities = new Set(resMap.values());
    if (communities.size > 1) {
      const note = noteMap.get(noteId);
      const assignments = [...resMap.entries()]
        .map(([res, comm]) => `res=${res}→C${comm}`)
        .join(', ');
      movers.push({ title: note?.title ?? noteId, assignments });
    }
  }

  console.log(`Notes that change clusters across resolutions: ${movers.length} / ${noteResolutions.size}`);
  if (movers.length > 0) {
    for (const m of movers.slice(0, 20)) {
      console.log(`  "${m.title}" — ${m.assignments}`);
    }
    if (movers.length > 20) console.log(`  ... and ${movers.length - 20} more`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const WEIGHT_CONFIGS: WeightConfig[] = [
  { name: 'A: cosine-only',      alpha: 1.0, beta: 0.0, gamma: 0.0, delta: 0.0 },
  { name: 'B: embedding-heavy',  alpha: 0.7, beta: 0.2, gamma: 0.1, delta: 0.0 },
  { name: 'C: tag-heavy',        alpha: 0.4, beta: 0.5, gamma: 0.1, delta: 0.0 },
  { name: 'D: link-boosted',     alpha: 0.5, beta: 0.2, gamma: 0.3, delta: 0.0 },
  { name: 'E: balanced',         alpha: 0.4, beta: 0.3, gamma: 0.3, delta: 0.0 },
  { name: 'F: all-signals',      alpha: 0.5, beta: 0.2, gamma: 0.1, delta: 0.2 },
];

const RESOLUTIONS = [0.5, 1.0, 1.5, 2.0];

async function main(): Promise<void> {
  // Parse CLI args
  const args = process.argv.slice(2);
  let cosineFloor = 0.30;
  for (const arg of args) {
    const match = arg.match(/^--floor=([\d.]+)$/);
    if (match) cosineFloor = parseFloat(match[1]!);
  }

  const env = loadEnv();
  const supabaseUrl = env['SUPABASE_URL'];
  const serviceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .dev.vars');
  }

  // Fetch data (read-only)
  const [notes, links] = await Promise.all([
    fetchNotes(supabaseUrl, serviceRoleKey),
    fetchLinks(supabaseUrl, serviceRoleKey),
  ]);

  const noteMap = new Map(notes.map(n => [n.id, n]));

  printHeader('Clustering Experiment (#152)');
  console.log(`Notes: ${notes.length} active with embeddings`);
  console.log(`Cosine floor: ${cosineFloor}`);
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`);

  // Stats
  printTagStats(notes);
  printEdgeStats(notes, links, cosineFloor);

  // Run each weight config at resolution 1.0 first for sensitivity comparison
  printHeader('Weight Sensitivity (resolution = 1.0)');
  for (const config of WEIGHT_CONFIGS) {
    const graph = buildGraph(notes, links, config, cosineFloor);
    const result = runClustering(graph, config, 1.0);
    const clusterSizes = [...result.communities.values()]
      .map(m => m.length)
      .sort((a, b) => b - a);
    const realClusters = clusterSizes.filter(s => s > 1);
    console.log(
      `${config.name.padEnd(25)} → ${realClusters.length} clusters ` +
      `(sizes: ${realClusters.join(', ') || 'none'}) ` +
      `+ ${clusterSizes.filter(s => s === 1).length} singletons | ` +
      `modularity: ${result.modularity.toFixed(3)} | ` +
      `edges: ${graph.size}`,
    );
  }

  // Detailed run: Config A (cosine-only) at all resolutions
  printHeader('Detailed: Config A (cosine-only) — all resolutions');
  const configAResults: ClusterResult[] = [];
  for (const res of RESOLUTIONS) {
    const graph = buildGraph(notes, links, WEIGHT_CONFIGS[0]!, cosineFloor);
    const result = runClustering(graph, WEIGHT_CONFIGS[0]!, res);
    configAResults.push(result);
    printSubheader(`Resolution ${res}`);
    printClusterResult(result, noteMap);
  }
  printOverlapAnalysis(configAResults, noteMap);

  // Boundary analysis at resolution 1.0
  {
    const graph = buildGraph(notes, links, WEIGHT_CONFIGS[0]!, cosineFloor);
    const result = runClustering(graph, WEIGHT_CONFIGS[0]!, 1.0);
    const boundaries = findBoundaryNodes(graph, result.assignment, noteMap);
    printSubheader('Boundary Nodes (>30% external weight, Config A, res=1.0)');
    if (boundaries.length === 0) {
      console.log('No boundary nodes found.');
    } else {
      for (const b of boundaries) {
        console.log(
          `  "${b.title}" — ${(b.externalRatio * 100).toFixed(0)}% external ` +
          `(own: C${b.ownCommunity}, pull: C${b.strongestPull})`,
        );
      }
    }
  }

  // Detailed run: Config B (embedding-heavy) at all resolutions
  printHeader('Detailed: Config B (embedding-heavy) — all resolutions');
  const configBResults: ClusterResult[] = [];
  for (const res of RESOLUTIONS) {
    const graph = buildGraph(notes, links, WEIGHT_CONFIGS[1]!, cosineFloor);
    const result = runClustering(graph, WEIGHT_CONFIGS[1]!, res);
    configBResults.push(result);
    printSubheader(`Resolution ${res}`);
    printClusterResult(result, noteMap);
  }
  printOverlapAnalysis(configBResults, noteMap);

  // Detailed run: Config F (all-signals including gardener links)
  printHeader('Detailed: Config F (all-signals incl. gardener) — res 1.0');
  {
    const graph = buildGraph(notes, links, WEIGHT_CONFIGS[5]!, cosineFloor);
    const result = runClustering(graph, WEIGHT_CONFIGS[5]!, 1.0);
    printClusterResult(result, noteMap);

    // Compare with Config A to see if gardener links change anything
    const graphA = buildGraph(notes, links, WEIGHT_CONFIGS[0]!, cosineFloor);
    const resultA = runClustering(graphA, WEIGHT_CONFIGS[0]!, 1.0);
    const moved: string[] = [];
    for (const noteId of Object.keys(result.assignment)) {
      if (result.assignment[noteId] !== resultA.assignment[noteId]) {
        const note = noteMap.get(noteId);
        moved.push(note?.title ?? noteId);
      }
    }
    console.log(`\nNotes that moved vs Config A: ${moved.length}`);
    for (const t of moved.slice(0, 10)) console.log(`  - ${t}`);
  }

  printHeader('Experiment Complete');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
