# Preference Excavation

1. No Supabase account. New project to be created.
2. No OpenRouter account. Needs to be set up.
3. Telegram bot not yet created. BotFather setup required.
4. No personal preference. Specialist advises: **develop against the cloud project directly** (no local Docker). Use Supabase CLI for deployments and migrations only. Rationale: Docker-based local stack adds operational complexity for someone who isn't deep in DevOps. Cloud project is always in sync with production schema. Edge Function logs are in the Supabase dashboard. The tradeoff is slower iteration (no offline dev), but for a single-user bot this is acceptable and keeps setup simple.
5. No personal preference. Specialist advises: **smoke tests using Deno's built-in test runner, targeting the live deployed function**. A handful of tests that send known inputs to the Edge Function and assert on the database state and Telegram reply. Covers: (a) thoughtful capture stores a note and sends confirmation, (b) `/fast` capture stores a note in <3s, (c) embedding is not null after insert, (d) error path returns a user-facing message. No unit tests for internal functions — the functions are thin orchestrators and unit tests would mostly mock everything. This gives production confidence without complexity.
6. Tell the user what failed and provide as much context as possible for debugging. Never fail silently.
7. Self-documenting code with minimal comments. Comments reserved for non-obvious logic only — written for senior coders, not rookies. Code should be readable enough to onboard experienced contributors without hand-holding.
8. No personal preference. Specialist advises: **strict TypeScript mode**. This is a small codebase; strict mode adds negligible overhead but catches real bugs — especially around nullable embeddings, JSON parsing from the LLM, and Supabase response types. Use explicit types, avoid `any`. The one exception: Deno import maps and external SDK types sometimes require `as unknown as X` casts; that is acceptable where unavoidable.
9. Build for replicability. Setup must be fully documentable for peers, and potentially publishable as a tutorial later.
10. General best practices. No specific additional wishes.

## Derived conventions

- **No Docker, cloud-only dev**: All development against the live Supabase project. Supabase CLI used for `functions deploy`, `secrets set`, `db push` only.
- **Strict TypeScript, no `any`**: Full type safety throughout. Explicit return types on all functions. Use `unknown` + narrowing instead of `any`.
- **Error transparency**: All failures surface a user-facing Telegram message with context. Structured console logging for Supabase dashboard visibility (`console.error(JSON.stringify({event, error, context}))`).
- **Smoke tests over unit tests**: A small `tests/` folder with Deno tests that hit the live function and assert on DB state. Run manually before each release.
- **Replicable setup**: Every setup step must be documented in README.md with exact commands. No assumed knowledge. Peers should be able to replicate from scratch.
