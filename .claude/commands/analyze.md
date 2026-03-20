# Analyze

Extract project-relevant insights from user-provided input. The user brings material — a session write-up, product feedback, a captured fragment, an error log, a design sketch, a conversation transcript — and you turn it into actionable artifacts: GitHub issues, issue comments, doc updates, ADRs, or memory entries.

## Arguments

$ARGUMENTS — optional hint about what the input is or what to focus on (e.g., "clustering session feedback", "fragment about agent onboarding", "this morning's backup failure log"). Can be empty — you'll figure it out from the input.

## When to use this vs other commands

- **`/analyze`** — you have input to process and want insights extracted. No implementation.
- **`/product-intake`** — you *used the product* and want to turn that experience into tracked issues. Deeper than analyze — traces code paths, assesses maturity, produces agent-ready issues.
- **`/harvest-ideas`** — you want to search the *corpus* for product ideas. No external input.
- **`/audit-captures`** — you want to evaluate *capture quality* against the philosophy. Structured evaluation.
- **`/work-on-issue`** — you want to *implement* something, not just analyze.

## Workflow

### Phase 1: Receive and understand the input

If the user hasn't provided the input yet, ask for it and wait. Don't start analyzing nothing.

Once you have the input, classify it:

| Input type | Example | Typical output |
|---|---|---|
| Session write-up | "I tried using list_clusters and here's what happened..." | Feature refinements, UX observations, product value examples |
| Captured fragment | A ContemPlace note ID or pasted text | Connections to existing issues, new issue candidates, design implications |
| Product feedback | "This felt clunky because..." | UX issues, design tensions, improvement candidates |
| Error/failure log | A stack trace, CI log, or error message | Root cause analysis, fix candidates, issue creation |
| Design sketch | A rough idea, wireframe description, or feature concept | Design questions, feasibility assessment, issue creation |
| Conversation transcript | A discussion that produced decisions or ideas | Decision extraction, ADR candidates, issue creation |

**Calibrate your depth to the input.** A single captured fragment gets a focused 5-minute analysis. A detailed session write-up with product insights gets the full treatment. Don't run a heavyweight process on lightweight input.

### Phase 2: Cross-reference

In parallel:

1. **Fetch open issues** — `gh issue list -R freegyes/project-ContemPlace --state open --limit 100 --json number,title,labels` via Bash. Map insights to existing issues where they belong.
2. **Check project docs** — read `docs/philosophy.md`, `docs/decisions.md` (relevant sections), and any docs the input touches. Understand what's already decided vs. what's open.
3. **Check the note database** — if the input references ContemPlace content or touches capture/retrieval behavior, use MCP tools (`search_notes`, `get_note`, `get_related`) to pull real examples.
4. **Check memory** — search MEMORY.md and topic files for prior context on this area.

### Phase 3: Extract insights

For each insight in the input, classify it:

- **Feature refinement** — improves something that already exists. Maps to an existing issue or becomes a new one.
- **New feature idea** — something that doesn't exist yet. Becomes a new issue.
- **Product value example** — a concrete moment that demonstrates what ContemPlace delivers. Useful for docs, philosophy, or the README.
- **Design signal** — a pattern in how the user interacts with the system that should inform UX decisions. May become a doc update or issue comment.
- **Decision confirmation** — the input validates a prior decision. Worth noting on the relevant issue or ADR.
- **Decision challenge** — the input tensions with a prior decision. Flag it explicitly with the ADR reference.
- **Bug or friction** — something broke or felt wrong. Issue or comment.

For each insight, decide the right artifact:

| Artifact | When |
|---|---|
| **New GitHub issue** | A distinct problem or idea not covered by existing issues |
| **Comment on existing issue** | The insight enriches or sharpens an open issue |
| **Doc update** | A principle was refined, a workflow was discovered, usage guidance changed |
| **ADR entry** | A decision was made or confirmed with new evidence |
| **Memory entry** | Project context that future sessions need but doesn't belong in docs |
| **Nothing** | The insight is interesting but not actionable right now — note it in the report and move on |

### Phase 4: Privacy check

Before creating any public-facing artifact (issue, issue comment, PR):

- **Never post private note content** (titles, bodies, raw_input) to public GitHub issues. Describe patterns and behaviors without quoting personal captures.
- **Paraphrase, don't quote.** "The user captured a thought about agent onboarding" not the actual text of the thought.
- **Domain references are OK** — "instrument-making cluster" or "backup-related notes" describe topics without exposing content.

### Phase 5: Create artifacts

Create the artifacts you identified in Phase 3. Work through them in order:

1. GitHub issues (new)
2. Issue comments (on existing issues)
3. Doc updates (edit files)
4. ADR entries (append to `docs/decisions.md`)
5. Memory entries (if applicable)

For each artifact created, briefly report what you did and why.

### Phase 6: Report

Present a summary of what you extracted and created:

```
## Analysis: [short description of the input]

### Insights extracted
- [insight] → [artifact created, with link]
- [insight] → [artifact created, with link]
- [insight] → noted, no action needed because [reason]

### Docs updated
- [file] — [what changed]

### Open questions
- [anything that needs the user's judgment]
```

## Calibration

- **Match effort to input.** A 3-sentence captured fragment doesn't need 6 phases of heavyweight analysis. Read the input, check for related issues, create the appropriate artifact, done. The phases are a ceiling, not a floor.
- **The user's framing is the starting point, not the boundary.** They may describe something as a "feature idea" when it's actually evidence for an existing design decision. Or vice versa. Classify based on what you find in the cross-reference, not just what the user called it.
- **Don't manufacture insights.** If the input has two actionable things in it, extract two. Don't pad to five.
- **Prefer comments on existing issues over new issues.** The issue tracker should stay lean. Only create a new issue when the insight genuinely represents a distinct concern not covered elsewhere.
- **This is analysis, not implementation.** Don't write code, don't deploy, don't change config. Extract insights and create written artifacts. If something needs implementation, create an issue for it.
- **Post findings as you go.** Don't wait until the end to create all artifacts. If you identify that an insight belongs on issue #107, post it. This creates a trail even if the session is interrupted.
