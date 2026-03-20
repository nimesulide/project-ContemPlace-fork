# Product intake

Turn raw experience reports from using the product into agent-ready GitHub issues at the right maturity. The user arrives wearing the user hat — "here's what happened when I used the thing" — and shifts to the product hat to make decisions about maturity, framing, and priority.

## Arguments

$ARGUMENTS — optional hint about the area of experience (e.g., "image capture", "multilingual", "gardening results"). Can be empty — the user will describe what happened.

## When to use this vs other commands

- **`/product-intake`** — you used the product and want to turn that experience into tracked issues. The input is "I tried X and here's what happened."
- **`/analyze`** — you have general input to process (session write-ups, error logs, transcripts). Broader, shallower.
- **`/audit-captures`** — you want to systematically evaluate capture *quality* across a sample. Structured evaluation against the philosophy.
- **`/work-on-issue`** — you want to *implement* something that already has an issue.

The key difference from `/analyze`: product intake goes deep on *why* the system behaved the way it did (code paths, emergent vs. designed behavior, trust contract implications) and produces issues optimized for cold-start pickup by a future agent session.

## Workflow

### Phase 1: Listen and separate

If the user hasn't provided input yet, ask for it and wait.

The input is typically voice-dictated, stream-of-consciousness, and may contain multiple unrelated observations in one continuous narrative. Before doing anything else:

1. **Voice correction** — scan for misrecognized words per the user's Wispr Flow preference.
2. **Identify distinct observations** — separate them. Each observation that describes a different behavior, edge case, or use case becomes its own track. Don't merge unrelated observations into one issue.
3. **For each observation, note:**
   - What the user did (the action)
   - What they expected
   - What actually happened
   - Whether this was a surprise (positive or negative)
   - Any broader use case the user described ("I would like to be able to...")

**Don't start researching yet.** Just understand what the user is telling you.

### Phase 2: Find the evidence

For each observation, gather concrete evidence. Launch these in parallel where possible:

1. **Find the captures** — if the user describes specific captures they made, find them via `search_notes`, `list_recent`, or `get_note`. Pull the full record including `raw_input` and links. These are the primary evidence.
2. **Read the code path** — find the code that handled (or didn't handle) the user's input. Trace from entry point to outcome. Understand *why* the system behaved the way it did — was it by design, an emergent behavior, or a gap?
3. **Check the trust contract** — read `docs/philosophy.md` and `mcp/src/capture.ts` (SYSTEM_FRAME). Does the observed behavior align with, tension against, or violate the product's stated principles?

The goal is to distinguish between:
- **Designed behavior** — the code explicitly handles this case
- **Emergent behavior** — the system does something useful that nobody designed (e.g., the LLM translates without being told to)
- **Graceful degradation** — the system handles an unsupported case without breaking
- **Gap** — the system can't do something the user wants

### Phase 3: Contextualize

In parallel:

1. **Fetch open issues** — `gh issue list --state open --limit 100 --json number,title,labels` via Bash.
2. **Search closed issues** — the observation may relate to prior investigations or decisions already made. Search with relevant keywords.
3. **Check memory** — search MEMORY.md for prior context on this area.
4. **Check docs** — `docs/decisions.md` if the observation touches a prior design decision. Don't read the whole file — search for relevant sections.

For each predecessor issue found, note what it concluded and why it was closed — not just that it exists. A future agent needs to know what's *in* the predecessor, not just its number.

### Phase 4: Assess maturity

Present your findings to the user and frame the maturity question. This is the hat-switch moment — the user moves from "person who used the product" to "product owner who decides what this means."

The maturity labels map to the project's existing conventions:

| Label | Meaning | Typical prefix | Signal |
|---|---|---|---|
| `question` | Observation, not yet actionable. Needs more data or design thinking before becoming work. | "Question:" | "I'm not sure what should happen here" |
| `question` | Design decision needed. The observation reveals a tension or gap that needs investigation. | "Design:" | "There are multiple valid approaches" |
| `enhancement` | Ready for implementation. The desired behavior is clear. | "Enhancement:" | "I know what I want, build it" |
| `bug` | Something broke or violated the trust contract. | (no prefix) | "This shouldn't have happened" |

**Don't assume maturity.** Present the observation, the evidence, the context, and ask the user: "How do you see this — is this an open question to investigate, or do you already know what you want?"

The user may also provide additional context, redirect the framing, or split/merge observations at this point.

### Phase 5: Draft issues

For each observation that becomes an issue, produce an agent-ready draft. The bar is: a future agent session can read this issue cold and understand the situation, the current behavior, and the next step without asking questions.

**Required sections:**

- **Real-world observation** — what the user did and what happened. Concrete, not abstract.
- **How it works today** — code pointers (file:line), explanation of the current behavior, whether it's designed or emergent.
- **[If applicable] Design tensions** — where the observed behavior sits relative to the trust contract, philosophy, or existing decisions. Include exact references.
- **Maturity: what comes next** — concrete next steps appropriate to the maturity level. For questions: what investigation would answer them. For enhancements: what the design scope looks like.
- **Predecessor context** — related issues with a one-sentence summary of what each concluded. Not just issue numbers.
- **Evidence in corpus** — UUIDs of relevant captures for future reference.

**Don't include:**
- Architecture proposals (this is intake, not design)
- Implementation details (that's `/work-on-issue` territory)

### Phase 6: Privacy check

Before creating any public-facing artifact:

- **Never post private note content** (titles, bodies, raw_input, specific tags) to public GitHub issues.
- **UUIDs are OK** — they're opaque identifiers. But don't pair them with quoted content.
- **Describe behavior, not content.** "The capture agent translated the fragment and found correct related notes" not the fragment's actual text.
- **Code snippets from the codebase are OK** — they're already public.
- **Domain-level topic references are OK** — "a personal reflection" or "a creative concept" without specifics.

If in doubt, generalize. The issue should be useful without exposing what the user was thinking about.

### Phase 7: Publish and cross-reference

1. **Create the issues** on GitHub with appropriate labels.
2. **Cross-reference** — if the observations answer or enrich an existing open issue (especially self-check issues like #200), post a comment linking to the new issues.
3. **Report** what was created:

```
## Product intake: [short description]

### Issues created
- #NNN — [title] (label) — [one-line summary of what it tracks]
- #NNN — [title] (label) — [one-line summary]

### Cross-referenced
- #NNN — [what was added and why]

### Open questions
- [anything that came up but wasn't resolved]
```

## Calibration

- **The user's experience is the primary source.** Don't redirect, reinterpret, or minimize what they experienced. If they say "this surprised me," that's a finding even if the behavior is technically correct.
- **Go deep on the code, not wide on speculation.** The value of this command over `/analyze` is tracing the actual code path and understanding designed vs. emergent behavior. Don't skip this.
- **One observation, one issue.** Don't merge distinct observations into a combined issue. They may have different maturity levels and different futures.
- **The maturity conversation is the key moment.** Don't auto-assign labels — present the evidence and let the user decide. They may see connections or implications you don't.
- **Agent-readiness is the output quality bar.** After publishing, ask: could a fresh agent session pick up this issue and make progress without this conversation's context? If not, the issue needs more.
- **This is intake, not implementation.** Don't write code, don't propose architecture. Produce issues that a future `/work-on-issue` session can start from.
- **Iterate with the user.** The first draft is rarely final. The user will refine wording, add context, redirect framing. That's the process working, not a failure of the first draft.
