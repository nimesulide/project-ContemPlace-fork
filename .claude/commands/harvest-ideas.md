# Harvest ideas

Search the ContemPlace corpus for captured thoughts about ContemPlace itself, PKM, and related topics. Cross-reference with open GitHub issues. Surface ideas worth acting on — as new issues, comments on existing ones, or notes that a prior idea has evolved.

## Arguments

$ARGUMENTS — optional search focus (e.g., "synthesis", "gardening", "capture quality"). Defaults to a broad sweep of ContemPlace/PKM-related fragments.

## Workflow

### Phase 1: Pull relevant fragments from the corpus

Run these MCP searches in parallel. Cast a wide net — the user captures thoughts about their own system in many registers:

1. **`search_notes`** — query: "ContemPlace"
2. **`search_notes`** — query: "personal knowledge management"
3. **`search_notes`** — query: "note-taking workflow"
4. **`search_notes`** — query: "capture and retrieval"
5. **`search_notes`** — query: "linking and synthesis"
6. If `$ARGUMENTS` provides a focus term, add a targeted search for that term.

Deduplicate results by note ID. For each unique note, call **`get_note`** to get the full record (raw_input, title, body, tags, created_at). Run in parallel batches.

Also call **`list_recent`** with limit 20 and scan for any fragments that touch ContemPlace/PKM topics but didn't match the keyword searches. The user often captures system ideas without naming the system explicitly — look for fragments about workflows, information structure, tagging, memory, curation, friction, tools.

### Phase 2: Pull open GitHub issues

Fetch the current issue landscape:

1. **List open issues** on `freegyes/project-ContemPlace` — all labels, sorted by updated.
2. **List open issues labeled `enhancement`** specifically.
3. **List open issues labeled `question`** specifically.
4. **Check memory** for project status and recent decisions — some captured ideas may already be resolved.

Run in parallel with Phase 1.

### Phase 3: Classify each fragment

For each relevant fragment from Phase 1, classify it:

- **Actionable idea** — a concrete suggestion, feature request, or workflow improvement that could become a GitHub issue. Example: "I wish the system would show me clusters of what I've been thinking about this week."
- **Design reflection** — a thought about how the system should work, what it's for, or what it should avoid. Enriches an existing issue or philosophy discussion. Example: "The value of this system is that it doesn't try to organize for me — it just holds things until I'm ready."
- **Problem report** — friction, confusion, or something that didn't work as expected. Could be a bug or a UX gap. Example: "Tags keep coming back too broad — I said 'cimbalom' and got 'music'."
- **Stale or resolved** — the idea was captured before a change that addressed it. Note what resolved it.
- **Not actionable** — a passing thought that doesn't suggest a change. Skip these silently.

### Phase 4: Match fragments to issues

For each actionable or design-reflection fragment:

1. **Search open issues** for overlap. Does an existing issue already cover this idea? Check title, body, and comments.
2. **Check closed issues** — was this already shipped? If so, note the resolution.
3. **Assess freshness** — when was the fragment captured vs. when was the matching issue last updated? Has the user's thinking evolved since the issue was written?

Categorize each fragment into one of:
- **New issue candidate** — no existing issue covers this. Worth opening.
- **Comment on existing issue** — enriches an open issue with the user's own words and evolved thinking.
- **Already resolved** — the idea was addressed. No action needed.
- **Contradicts current direction** — the fragment tensions with a decision already made (check `docs/decisions.md`). Worth flagging as an open question.

### Phase 5: Present the harvest

**Lead with what's actionable.** Group by category, not by search query.

#### New issue candidates

For each, present:
- The fragment's `raw_input` (the user's actual words)
- When it was captured
- A proposed issue title and 1-2 sentence body (in the user's voice, not yours)
- Suggested label(s)
- Why this isn't already covered by an existing issue

#### Comments on existing issues

For each, present:
- The fragment's `raw_input`
- The target issue (number + title)
- What the fragment adds — new angle, evolved thinking, supporting evidence, or a concrete example
- A draft comment (short, in the user's voice)

#### Tensions with current decisions

For each, present:
- The fragment vs. the decision (cite the ADR or issue)
- Whether this suggests the decision should be revisited or is just natural ambivalence

#### Already resolved

Brief list — fragment title, what resolved it. Confirms the system is working.

### Phase 6: Wait for the user

**Do not create issues or post comments.** Present the harvest and let the user decide what to act on. They may say:
- "Open issues 1, 3, and 5" — create those issues
- "Comment on #120 with that fragment" — post the draft comment
- "Skip all of these" — done
- "That one's interesting, let's think about it" — shift to discussion mode

## Calibration

- **The user's words are the material.** Quote `raw_input`, don't paraphrase. The whole point is surfacing what the user actually said.
- **Don't manufacture relevance.** If a fragment mentions "notes" in a completely unrelated context, skip it. Only surface fragments where the user is genuinely thinking about their knowledge system.
- **Freshness matters.** A fragment captured yesterday about synthesis is more interesting than one from two weeks ago that predates a major architectural decision. Weight recent thinking higher.
- **Respect closed decisions.** If the user captured "maybe we should add SKOS back" but SKOS was deliberately dropped (ADR in decisions.md), flag the tension — don't propose reopening it as if the decision never happened.
- **Keep it tight.** A harvest with 3 strong candidates is better than 10 padded ones. If the corpus has nothing actionable right now, say so in one line.
- **This is a curatorial tool, not an idea generator.** You're surfacing the user's own thinking, not adding yours. If you see a gap the user hasn't thought about, you can mention it as an open question — but the harvest itself is their material.
