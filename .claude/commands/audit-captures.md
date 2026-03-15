# Audit captures

Analyze recent real-world captures against the product's design philosophy. Surface gaps between what the system promises and what it delivers, then recommend concrete improvements.

## Arguments

$ARGUMENTS — number of recent fragments to analyze (default: 10). Can also be a keyword like "all" (caps at 30) or a tag filter like "tag:bookbinding" (fetches up to 15 matching notes).

## Workflow

### Phase 1: Load the ethos

Read the product's design contract — these are the standards the audit measures against:

1. **Read `docs/philosophy.md`** — the 10 core principles (fragments not atoms, trust contract, user voice sacred, emergent structure, etc.)
2. **Read `docs/capture-agent.md`** — capture pipeline behavior, title model, linking logic, traceability rule, voice correction
3. **Read `mcp/src/capture.ts`** — the live SYSTEM_FRAME (structural contract the LLM actually receives)
4. **Fetch the live capture voice** — call `search_notes` with a dummy query is not the way; instead, note that the capture voice is fetched from `capture_profiles` at runtime. Read the seed in the v3 migration or check CLAUDE.md for the current version. The important thing is knowing what rules the LLM was given.
5. **Read `docs/decisions.md`** — recent ADRs that set constraints (link type simplification, entity extraction removal, etc.)

Do all reads in parallel.

### Phase 2: Fetch the fragments

Use MCP tools to pull real captured data:

1. **`list_recent`** with the requested limit to get the sample set.
2. For each note in the sample, call **`get_note`** (for full record: raw_input, body, title, tags, corrections, source) and **`get_related`** (for all links: capture-time and gardener-time). Run these in parallel batches.
3. Build a working dataset: for each fragment, you now have:
   - `raw_input` (what the user actually said)
   - `title`, `body`, `tags`, `corrections` (what the capture LLM produced)
   - `source` (where it came from — telegram, mcp, claude-code, etc.)
   - Capture-time links (`related`, `contradicts`) with target note titles
   - Gardener-time links (`is-similar-to`) with confidence scores and shared tags
   - `created_at` (when it was captured)

If the argument is a tag filter (e.g., "tag:bookbinding"), use `search_notes` with `filter_tags` instead of `list_recent`.

### Phase 3: Per-fragment analysis

For each fragment, evaluate against the design contract. Do the analysis internally — do NOT report per-fragment results unless there's a finding. Only surface fragments where something is wrong or noteworthy.

Check each fragment for:

#### 3a. Capture fidelity (trust contract)

- **Voice preservation**: Compare `raw_input` to `body`. Is the body a faithful presentation of the user's words, or did the LLM compress, interpret, or add meaning? Flag any sentence in the body that isn't traceable to the raw input.
- **No contamination**: Does the body contain conclusions, inferences, or synthesized statements the user didn't express?
- **Question preservation**: If the raw input contains questions, are they preserved as questions in the body? Or were they reframed as statements or answered?
- **Correction quality**: If `corrections` is present, are they plausible voice-dictation fixes? Any false corrections (changing a word the user meant)?

#### 3b. Structural quality

- **Title model**: Is the title a claim or question (good) or a topic label (bad)? Does the claim actually come from the user's words, or was it editorialized?
- **Tag quality**: Are tags specific enough (e.g., `cimbalom` not just `music`)? Is there a mix of specific subjects and broader categories? Any redundant or vague tags?
- **Body length**: Is the body appropriately sized for the input? Too padded? Too compressed? Does it land the idea?

#### 3c. Linking quality (capture-time)

- **Link relevance**: For each capture-time link, assess: does this link add retrieval value? Would following this link help the user find related thinking?
- **Link type accuracy**: Are `contradicts` links actually contradictions? Are `related` links meaningful connections or noise?
- **Missed links**: Based on the fragment's content and tags, are there obvious connections the capture LLM missed? (Use `search_notes` with the fragment's key concepts to check.)
- **Over-linking**: Are there links that add no value — connecting notes just because they share a topic word?

#### 3d. Gardening outcomes

- **Similarity links**: How many `is-similar-to` links did the gardener create for this note? Are the linked notes genuinely similar or just topically adjacent?
- **Cluster membership**: Does this fragment belong to an emerging cluster? How many gardener links connect it to other fragments?
- **Isolation**: Is this fragment an orphan (no links at all)? If so, is that expected given its content, or does it suggest a gap in the corpus?

### Phase 4: Cross-fragment patterns (findings only)

Look across the full sample for systemic patterns. **Only report a pattern if there's a finding.** Skip any of these that come back clean:

- **Tag consistency**: Are the same concepts tagged the same way across fragments, or are there inconsistencies (e.g., `bookbinding` vs `book-binding` vs `book-arts`)?
- **Link density distribution**: What's the link count distribution? Are some fragments over-connected while others are isolated?
- **Capture LLM tendencies**: Any recurring mistakes? (Adding concluding sentences, over-tagging, under-linking, editorializing titles, etc.)
- **Input patterns**: What does the user actually send? Short bursts? Long reflections? Questions? Quotes? Does the system handle each type well?
- **Source distribution**: Where are captures coming from? (Telegram, MCP, claude-code, etc.)
- **Temporal clustering**: Are there bursts of thematically related captures? Does the linking reflect those bursts?

### Phase 5: Retrieval quality assessment

Test whether the way fragments are captured serves retrieval downstream. This is the other end of the pipeline — does the structuring, tagging, and linking at capture time produce a corpus that's useful to query?

Run these searches against the live corpus and assess the results:

1. **"What have I been thinking about lately?"** — `list_recent` with limit 10. Does the list give a useful snapshot of recent thinking? Are titles scannable?
2. **"What do I know about [topic from the sample]?"** — Pick 2-3 topics that appear in the sample. Run `search_notes` for each. Are the results relevant? Is the ranking sensible? Any surprising omissions?
3. **"How does this idea connect to my other thinking?"** — Pick 2-3 well-linked fragments. Call `get_related`. Do the links tell a useful story? Would an agent be able to build context from these connections?
4. **"Find something I said about [specific thing]"** — Pick a specific claim or phrase from a raw_input. Search for it. Does the system find the right note? How high does it rank?

For each use case, rate: **works well** / **works but could be better** / **doesn't work**.

### Phase 6: Synthesis and recommendations

**Lead with findings.** Open with what's wrong, support with evidence. Then cover what's working. Do not comprehensively describe every fragment — only cite fragments that illustrate a finding.

#### Report header
- Date, sample size, date range of fragments analyzed
- Corpus stats: total notes (from list_recent with high limit), source breakdown, average links per note

#### Gaps (first)
Where reality diverges from the philosophy. For each gap:
- **The principle** (cite the specific philosophy.md principle)
- **What happened** (concrete example from the sample)
- **Why it matters** (what retrieval value is lost, or what trust is eroded)
- **Severity**: cosmetic / degrades retrieval / violates trust contract

#### What's working
Specific things the system does well, with examples from the sample. Be concrete but brief.

#### Regression check
Check memory for findings from previous audits. For each prior finding, assess: is this still happening, or did the fix work? Report regressions and resolved issues.

If no previous audit memory exists, skip this section and note that this is the first audit.

#### Recommendations
Ordered by impact. For each:
- **What to change** — is this a SYSTEM_FRAME fix, a capture voice tweak, a gardener threshold adjustment, a new pipeline step, or a product decision?
- **Where the fix lives** — code (`mcp/src/capture.ts`), database (`capture_profiles`), config (env var), or design (needs an issue)
- **Expected effect** — what gets better
- **Trade-off** — what might get worse or become harder

#### Retrieval scorecard
A table summarizing the 4 use case assessments from Phase 5.

#### Open questions
Anything the audit surfaced that needs the user's judgment — design tensions, philosophy edge cases, corpus curation decisions.

### Phase 7: Save audit summary to memory

After presenting the report, save a brief findings summary to memory. **Do not include note content (raw_input, titles, bodies) — only patterns and actions.** This enables regression checking in future audits.

Format:
```
---
name: audit-YYYY-MM-DD
description: Capture audit findings — [one-line summary of key findings]
type: project
---

**Date:** YYYY-MM-DD | **Sample:** N fragments | **Corpus:** N notes

**Findings:**
- [pattern found, severity, N/total affected]

**Actions taken:**
- [what was changed and where]

**Open:** [unresolved questions or items deferred to user judgment]
```

## Calibration

- **This is an analytical report, not a code change.** Do not modify any files. Do not open issues. Present findings and let the user decide what to act on.
- **Be specific, not general.** "The trust contract is sometimes violated" is useless. "Fragment X title says 'Espresso workflow optimization' but the raw input was a question about grinder settings — the title editorializes" is useful.
- **Use the user's own language.** When quoting raw_input or discussing the user's thinking, preserve their voice. Don't paraphrase.
- **The philosophy is the standard, not your opinion.** If the system deviates from philosophy.md, that's a finding. If the system follows philosophy.md but you think philosophy.md is wrong, that's at most an open question — not a gap.
- **Don't manufacture findings.** If the system is working well, say so. A short report with "everything looks good, here's one minor tag inconsistency" is better than inflating issues for completeness.
- **Tag the severity honestly.** Most capture imperfections are cosmetic. Reserve "violates trust contract" for actual body contamination, hallucinated content, or destroyed user intent.
- **Keep the report tight.** The value is in the findings and retrieval assessment, not in comprehensive per-fragment commentary. If 8/10 fragments are fine, don't describe them — describe the 2 that aren't.
