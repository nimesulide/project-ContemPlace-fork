# Using ContemPlace

*You have it running. Now what? This is what a week looks like — what you send, what comes back, how you fix mistakes, and what happens while you sleep.*

---

## Capture: what goes in

You send raw text. The system does the rest.

Open your Telegram chat with the bot and type whatever is on your mind. A thought after a meeting. A quote from something you read. A question you can't answer yet. A half-formed observation from a walk. It doesn't need to be polished. It doesn't need to be complete.

```
I think the reason pair programming works isn't the code review —
it's that explaining forces you to confront what you don't understand yet
```

A few seconds later, the bot replies with what the capture agent made of it:

**Explaining forces confrontation with gaps in understanding**

Pair programming works not because of code review but because explaining forces you to confront what you don't understand yet.

──────────────────────

*pair-programming, learning, explanation*

The title is a claim extracted from your words. The body preserves what you said. The tags are inferred. Your exact input is saved alongside all of this — the structured version is for retrieval, but your words are the source of truth.

<div align="center">
<img src="assets/example-telegram-capture.png" alt="Telegram capture: photo of an ancient tree with a note about the Hungarian word böhönc — the bot replies with a structured fragment, tags, and a link to a related note" width="320" />
<br />
<em>A photo capture in Telegram — structured with title, tags, and a link to a related note. The raw input and photo are preserved exactly as sent.</em>
</div>

### Voice dictation

Voice input works the same way. Speak into Telegram, and the bot gets the transcribed text. Dictation errors are common — the capture agent corrects them silently and reports what it fixed:

*corrections: cattle stitch → kettle stitch*

You see the fix in the reply. The corrected version goes into the structured note. Your original words (errors and all) stay preserved in `raw_input`.

### What makes a good fragment

Anything. A focused thought produces the cleanest result — one claim, a sentence or three. But the system handles messy input too. A brain dump with three ideas. A stream-of-consciousness paragraph. A single word that means something to you. The capture pipeline structures whatever you send. Focused fragments produce better immediate linking; loose fragments accumulate and connect later through the gardener.

You don't need to think about whether something is "worth capturing." That's the system's job to sort out. Yours is to send what's on your mind.

### Links

If your fragment connects to something already in the database, the capture agent links them. You'll see it in the reply:

*related: Explaining forces confrontation with gaps in understanding*

The agent found a related note and created a link. You didn't ask for it — the system embedded your input, searched for similar notes, and let the LLM decide if a connection exists. Two link types: `related` for any meaningful connection, `contradicts` for tension or disagreement with a prior note.

---

## Retrieval: what comes out

The primary access pattern is agent-driven. You open a conversation with any MCP-capable agent — Claude.ai, Claude Code, a custom script — and it can query your knowledge base directly. No pasting context. No re-explaining.

### "What have I been thinking about..."

The most natural query. You ask an agent about a topic, and it calls `search_notes` behind the scenes. The agent gets back ranked results with body text included — enough to weave into a response without a follow-up call.

You might ask: "What have I captured about learning?" The agent pulls a cluster of fragments — the pair programming note, a note about spaced repetition, a quote about beginner's mind — and synthesizes a response from your own accumulated thinking.

<div align="center">
<img src="assets/example-semantic-exploration.png" alt="Claude.ai: searching for tree-related notes surfaces direct tree connections and unexpected wood/material connections across different projects" width="500" />
<br />
<em>One prompt — the agent queries your knowledge base and groups results by conceptual thread. No context pasted, no re-explaining.</em>
</div>

### "Show me what's connected to this"

When a note is interesting, you can ask the agent to explore its neighborhood. The agent calls `get_related` and sees all linked notes — capture-time links (things the LLM connected when you captured) and gardener links (similarity connections discovered overnight).

This is where the graph becomes useful. A note about pair programming links to a note about rubber duck debugging, which links to a note about writing as thinking. You didn't organize any of this. The connections accumulated.

### "What did I capture recently?"

A quick check-in. The agent calls `list_recent` and shows your last few fragments. Useful for reviewing what's been on your mind, catching something that needs correcting, or just re-reading what you said yesterday.

### The raw input distinction

When an agent retrieves a note, it sees two versions of your words: `body` (the capture agent's structured interpretation) and `raw_input` (your exact words). The description on `get_note` tells agents to prefer `raw_input` when quoting you. This matters — the structured body is for retrieval and scanning, but your actual words are the source of truth.

---

## Curation: the editorial loop

Capture is fast and low-friction. Sometimes too fast — you send something and immediately see the result is wrong. The system gives you two tools for this, matched to two different situations.

### Telegram: /undo

You just captured something. The reply comes back and the title is garbled, or you realize you said the wrong thing. Type `/undo`.

The bot deletes the note and confirms: "Undone: **Garbled title here**"

That's it. The note is permanently gone — no ghost rows, no archived junk. `/undo` works within the grace window (default 11 minutes) and only targets notes you captured via Telegram. It's a true undo: take back what you just did, right here, right now.

If the grace window has passed, `/undo` refuses: "The grace period has passed. To archive a note, use an MCP session." At that point you've left the capture session — context has shifted, and the safety of a full MCP session is appropriate.

<!-- TODO: screenshot of /undo flow — capture, bad result, /undo, confirmation -->

### MCP: remove_note

For deliberate curation — not correcting a mistake, but deciding a note doesn't belong anymore. You're reviewing your knowledge base with an agent, you encounter something stale or wrong, and you ask the agent to remove it.

What happens depends on the note's age. Recent notes (within the grace window) are permanently deleted. Older notes are soft-archived — hidden from all tools but recoverable via direct database access. This protects your corpus: an overzealous agent can only soft-delete established notes, never destroy them irreversibly.

The typical flow: you ask the agent "show me my recent notes about X," scan the results, and say "that second one is outdated, remove it." The agent calls `remove_note` with the UUID, confirms the action, and the note disappears from the active graph.

### The recapture loop

The common editorial cycle: capture → review → remove → recapture.

You voice-dictate a thought on your phone. The Telegram reply shows the capture agent misunderstood — maybe the voice transcription was too garbled, or the idea came out muddled. You type `/undo`. Then you retype or re-dictate the thought more clearly. The second capture replaces the first. Clean, fast, no accumulated junk.

---

## The gardener: what happens overnight

You capture fragments during the day. At 2am UTC, the gardener wakes up.

It does three things. First, it compares every note against every other note by embedding similarity. When two fragments are close enough in meaning — even if they share no tags and were never linked by the capture agent — the gardener creates an `is-similar-to` link between them with a confidence score. Notes that the capture agent couldn't link — because they didn't exist yet, or because a dense topic had more than 5 candidates and the pair didn't make the cut — are now discoverable through the gardener's similarity web.

Second, it runs cluster detection. Using the same similarity data, the gardener groups fragments into thematic clusters via Louvain community detection — at multiple resolutions, so you can see broad themes and fine-grained sub-topics. Each cluster gets a label from its most common tags and a gravity score that surfaces recent, active clusters. You might discover that your fragments about instrument-making and laser-cutting share a thread you hadn't noticed.

Third, if entity extraction is enabled, it identifies proper nouns (people, places, tools, projects) across new notes and maintains a corpus-wide entity dictionary. This enriches the structured data agents see when retrieving notes.

You don't see any of this happen by default. The next time you or an agent explores your knowledge base, the graph is richer than what you explicitly connected and the clusters reveal the shape of your thinking.

### On-demand gardening

You don't have to wait for the nightly cron. After a burst of captures — say, a dense brainstorming session or a batch import — call `trigger_gardening` from any MCP-connected agent. The full pipeline runs synchronously (~30 seconds) and returns the results: how many similarity links were created, how many clusters formed, how many entities were extracted. Then immediately call `list_clusters` or `get_related` to see the updated graph.

There's a 5-minute cooldown between triggers to prevent accidental spam. If you trigger too soon, the tool tells you how long to wait.

This is the difference between a note store and a knowledge graph. The gardener turns your accumulation into something you can navigate.

### Exploring clusters

Ask any MCP-connected agent to show your clusters. The agent calls `list_clusters` and gets back a gravity-ordered map of your thinking — recent active topics first, older quiet threads toward the bottom.

The resolution parameter is a zoom control. At 1.0, you see broad themes — making, thinking-about-thinking, tools. At 2.0, those themes split: making separates into plotter-specific work and correspondence/printmaking; your ContemPlace notes separate into product thinking and infrastructure.

What makes this useful is what you *don't* see. You never organized anything. The clusters emerged from the embeddings — notes that talk about similar things end up near each other, and the Louvain algorithm finds the boundaries. Some of those boundaries are obvious (instruments vs. note-taking philosophy). Others surface threads you hadn't noticed running through your fragments.

The unclustered notes matter too. A handful of fragments sitting outside every cluster tells you something — these are genuinely standalone thoughts. If you capture more on the same topic, a cluster will form. Until then, they wait.

**What gravity tells you:** A cluster with high gravity is where your recent attention is. A cluster with low gravity is an old thread — still coherent, still there, just not where you've been lately. This isn't a quality judgment. It's a recency signal. Old clusters with dormant gravity are often the most interesting to revisit.

### The clustering workflow

A clustering session follows a natural funnel — each step narrows focus based on what the previous step revealed.

1. **Landscape.** Call `list_clusters` with no parameters. The agent reads the gravity-ordered map and can say "here are the themes your brain has been working on" before reading a single note body. This is the cold-start entry point for any reflection session.

2. **Resolution comparison.** Call `list_clusters` again at a different resolution (e.g., 1.5). The agent narrates what split, what held, and what newly surfaced. This is a high-value single move — low effort, often the most structurally informative step. A cluster that splits reveals internal conceptual diversity; one that holds at higher resolution is genuinely coherent.

3. **Hub notes.** Each cluster includes `hub_notes` — the 1–2 notes with the most intra-cluster links. These are conceptual anchors: notes that connect multiple threads within the cluster. Start a depth dive with `get_related` on a hub note instead of scanning all titles.

4. **Title scan.** For an interesting cluster, increase `notes_per_cluster` to see all its titles. The agent reads titles for philosophical anchors, surprising members, and notes the hub notes don't reach.

5. **Graph walk.** From a hub note or any well-connected note, call `get_related` to explore the link topology. `get_related` is a second-stage tool — most useful once you've identified a specific note to anchor from, not as a starting point.

6. **Boundary search.** For any cluster, the agent can ask "what would this cluster contain if the orientation were different?" and search for those terms at low threshold. Finding nothing is informative — it reveals the framing and assumptions behind the cluster. The absence of expected concepts often says more about the user's orientation than the presence of captured ones.

Not every session goes through all six steps. Landscape orientation alone is often enough for a check-in. The funnel is there when you want to go deeper.

---

## Backups: what protects your data

At 4am UTC — two hours after the gardener finishes — a GitHub Actions workflow dumps your entire database to a private repository you control. Three SQL files: roles, schema (tables, indexes, RPC functions, pgvector), and data (every note, embedding, link, and the capture voice profile). The whole thing runs on free tiers.

You never interact with the backup. It runs in the background, commits to the backup repo if anything changed since the last run, and stays silent unless it fails. If it does fail, GitHub Actions shows the failure in the Actions tab, and optionally sends a Telegram alert.

Git history in the backup repo is your retention. Each day's backup is a commit. You can diff two days to see what changed, roll back to any point, or clone the repo for an offline copy. At current scale (~200 notes), the dump is about 4MB — git handles this effortlessly.

### Restoring

If you need to recover — a botched migration, a deleted project, starting fresh on a new Supabase instance — the restore is three `psql` commands:

```bash
psql $DB_URL -c "CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions"
psql $DB_URL -f schema.sql
psql $DB_URL -f data.sql
```

Everything comes back: notes with embeddings intact, links, RPC functions, the capture voice profile. `match_notes` and `find_similar_pairs` work immediately — no re-embedding needed.

### Setting it up

The workflow ships with the repo (`.github/workflows/backup.yml`). To enable it: create a private backup repo, set two GitHub secrets and one variable, trigger it once to verify. Full instructions in the [setup guide](setup.md#8-configure-automated-backups-optional).

---

## A real example: from capture to action

The sections above explain the mechanics. Here's what they feel like in practice — one scenario, five steps, ending not at a screen but in a forest.

### 1. Capture

You're browsing the internet and spot the word "böhönc" — Hungarian for ancient trees that have overgrown their neighbors, like Tolkien's Ents. You love that. You take a screenshot, open Telegram, and send the photo with a one-line note.

A few seconds later, the bot replies with a structured fragment: title, body, four tags, and a link to a related note about unusual words from a book you'd been reading.

<div align="center">
<img src="assets/example-telegram-capture.png" alt="Telegram capture: photo of an ancient tree with a note about the Hungarian word böhönc" width="320" />
<br />
<em>Photo stored in R2, note structured with tags and a link to a related note — raw input preserved exactly as sent.</em>
</div>

Your raw input and photo are saved exactly as you sent them. The structured version is for retrieval; your words are the source of truth. You close Telegram and don't think about it again.

Behind the scenes: the Worker downloaded the photo from Telegram and stored it in R2, embedded your raw text to find related notes, sent the input plus related context to the capture LLM, then re-embedded the structured body for storage. None of this required your attention.

### 2. Cluster

That night, the gardener runs. It compares every note against every other note by embedding similarity. Your böhönc fragment is semantically close to a note about a book that uses unusual, evocative words — close enough that the Louvain algorithm groups them into a cluster.

<div align="center">
<img src="assets/example-cluster-discovery.png" alt="Dashboard cluster view: the böhönc capture clustered with a note about unusual words in a force-directed graph" width="700" />
<br />
<em>The cluster grid on the dashboard — böhönc and a note about unusual words connected in a force-directed graph, surrounded by other thematic clusters.</em>
</div>

You didn't organize this. You didn't tag them the same way on purpose. The semantic proximity was enough. And the cluster reveals something you hadn't consciously connected: you didn't just like the tree — you liked the unusual word. The thread running through your fragments is your attraction to rare, evocative vocabulary.

This is the kind of pattern the system surfaces. Not a recommendation, not a suggestion — a structural observation about what your fragments have in common. You decide what to do with it.

### 3. Exploration

Days later, you're in a Claude session and you've just seen a beautiful forest. On impulse, you type: "I saw a great looking forest, and that made me think about trees in general. Search my notes for trees, check for anything related, see what comes up!"

<div align="center">
<img src="assets/example-semantic-exploration.png" alt="Claude.ai: semantic search for tree-related notes returns direct tree connections and unexpected wood/material connections" width="500" />
<br />
<em>The agent searches your knowledge base and groups results by conceptual thread — direct tree connections and unexpected wood/material connections.</em>
</div>

The agent calls `search_notes` and returns results ranked by semantic similarity. The böhönc capture comes back — but so do notes you'd nearly forgotten: someone making prints from cross-sections of felled trees, a drone flute carved from routed wood, beautiful wooden board games. The agent organizes them into "direct tree connections" and "wood/material connections" without being told to.

You hadn't thought of these things together. The instrument idea was from weeks ago, the board games from a different context entirely. But the embedding space puts them in the same neighborhood, and the agent traverses that neighborhood in one call.

### 4. Connection

This is the moment the system earns its keep. You're looking at these results and something clicks: your interest in trees connects to making things from wood, which connects to instruments, which connects to board games. These aren't separate interests — they're facets of the same thread. The system didn't tell you that. It showed you the proximity, and your brain did the rest.

These are the augmented happy accidents. Cross-linked fragments that emerge as patterns, helping your brain think creatively by surfacing connections you wouldn't have reached on your own — at least not this quickly, not this effortlessly.

### 5. Action

You finish your coffee. Your morning walk — which was going to be a routine stroll — now has a destination. Yesterday you noticed a huge tree by the river that had split in two. Now you're thinking: could you make a print from its cross-section? Could a piece of it become material for an instrument or a board game?

The system didn't send you there. It didn't recommend a walk. It reminded you why you'd want to go — by connecting a word you liked to a material you work with to a craft you practice. The fragment you captured days ago, without thinking about it, became a thread that pulled you into the physical world.

---

This is one scenario out of a thousand. The path through your graph will look different every time — project planning, reading notes, design thinking, whatever you're accumulating. The shape is the same: low-friction capture, emergent structure, agent-assisted exploration, and sometimes action you wouldn't have taken otherwise.

---

## A day, start to finish

Morning. You have a thought over coffee about how deadlines help creativity. You voice-dictate it into Telegram. The bot titles it, tags it, links it to a note from last week about constraints in design.

Afternoon. You're in a Claude Code session working on a project. You ask the agent "what have I captured about creative constraints?" It pulls three fragments — the coffee thought, the design constraints note, and a quote from a book you read last month. The agent weaves them together without you pasting anything.

You notice one of the fragments is from an early experiment and doesn't reflect what you think anymore. You ask the agent to remove it. It's soft-archived — gone from the active graph, recoverable if you change your mind.

Evening. You capture two more thoughts from a conversation. One comes out wrong — you `/undo` it immediately and retype.

2am. The gardener runs. Your morning thought about deadlines connects to a fragment about procrastination you captured three weeks ago. Tomorrow, when you think about either topic, the other is one hop away.

4am. The backup runs. Your entire database — every note, embedding, link, and the capture voice profile — is dumped to a private repo. If anything goes wrong tomorrow, you restore with three commands and lose nothing.

You never organized anything. The structure emerged. And the data is safe.

---

## Bringing in existing notes

There's no automated import. ContemPlace captures fragments through `capture_note` — that's the only write path, and it runs the full pipeline (embedding, structuring, linking) on each input. Importing a thousand notes means a thousand pipeline runs, each with LLM calls and embeddings.

What works instead is assisted re-capture: you sit with an agent, describe a topic from your existing notes, and the agent helps you extract and re-voice idea fragments that you then capture one by one. It's hands-on — you review each fragment before it enters the system.

The repo includes an example of this workflow as a Claude Code custom command (`.claude/commands/extract-fragments.md`). It's designed for Obsidian vaults with semantic search via MCP, but the pattern applies to any source: find relevant material, decompose into fragments, re-voice in your natural capture style, review, capture. You'll need to set up your own MCP access to whatever source system you're importing from.

This is a recipe, not a feature. It requires your editorial judgment at every step — which is the point. The system trusts you to decide what's worth re-capturing.
