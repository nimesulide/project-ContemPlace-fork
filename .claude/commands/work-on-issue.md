# Work on issue

Execute the full planning-before-implementation workflow for a GitHub issue. The user provides an issue number or description — you handle the rest.

## Arguments

$ARGUMENTS — the issue number (e.g., "#47", "47") or a short description of what to build. If a number, fetch the issue first. If a description, open a new issue.

## Workflow

### Phase 1: Gather context

1. **Fetch the issue** (or create one if only a description was given). Read the full issue body.
2. **Fetch related issues** referenced in the body or that share labels/topics.
3. **Read the relevant source files** — whatever the issue touches. Use the project layout in CLAUDE.md to find the right files. Read them, don't guess.
4. **Check memory** — search MEMORY.md and topic files in the memory directory for prior context on this area.

### Phase 2: Specialist review (parallel)

Launch **two Plan agents in parallel** to evaluate the design before any code is written:

**Agent A — Best practices and design concerns:**
- Research best practices relevant to the task
- Surface edge cases, architectural concerns, interaction with existing systems
- Flag risks and anti-patterns
- Identify decisions that need to be made before implementation

**Agent B — Gap analysis and implementation specifics:**
- Read the actual source files that will change
- Identify what's missing, what could break, what depends on what
- Draft the minimal set of changes needed
- Flag prerequisites (schema changes, seed data, config, etc.)

Both agents receive: the issue body, relevant source code, and the project's hard constraints from CLAUDE.md. Both return structured findings. Both are told to do research only — no code writing.

### Phase 3: Synthesize and present the plan

Combine both reviews into a clear plan:
- **Priority-ordered list of changes** — what to do first, what depends on what
- **Design decisions surfaced** — with recommendations, presented as a table
- **Risks and mitigations** — anything the reviews flagged
- **Files that will change** — explicit list

Present this to the user. Wait for confirmation or adjustments before proceeding.

### Phase 4: Implement

1. **Create a feature branch** (`feat/<short-name>`)
2. **Write the code** — follow the plan from Phase 3
3. **Typecheck** — `npx tsc --noEmit` (and `-p` for sub-projects if touched)
4. **Run relevant unit tests** — the ones that cover the changed code
5. **Commit** with conventional commit message, refs the issue number

### Phase 5: Verify

1. **Deploy** to the live stack if the change touches a Worker
2. **Run smoke/integration tests** against the live deployment
3. **Verify manually** if the tests don't cover the specific behavior (e.g., check a curl response)

### Phase 6: Ship

1. **Push the branch and create a PR** — with summary, test plan checklist
2. **Merge** (if tests pass and user approves)
3. **Clean up** — delete the feature branch

### Phase 7: Documentation sweep (automatic, do not ask)

After merging, do the full housekeeping sweep:
1. Update `docs/` files that describe anything touched
2. Update `README.md` if status table, tool list, test count, project layout affected
3. Update `CLAUDE.md` if architecture, constraints, file layout, commands, or conventions changed
4. Record new decisions in `docs/decisions.md`
5. Comment on relevant GitHub issues with outcomes
6. Close resolved issues with a resolution comment
7. Clean up stale branches
8. Update memory files if project status shifted

### Calibration notes

- **Small changes** (config tweaks, description updates, test fixes): the specialist review phase can be lighter — one agent instead of two, or skip if the change is obviously safe.
- **Large changes** (new Workers, schema migrations, multi-file refactors): the specialist review is critical. This is where design mistakes get caught before they become mid-implementation surprises.
- **Design-only issues** (labeled `question`): Phase 2 is the whole point. The output is a design recommendation, not code. Skip Phases 4-6.
- If the user says "just do it" or "skip the review" — respect that and go straight to implementation.
