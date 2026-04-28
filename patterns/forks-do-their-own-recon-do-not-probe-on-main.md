---
triggers: fork, spawn_fork, recon, probe, scoping, pre-dispatch-probe, brief-padding, codebase-probe, schema-probe, pre-fork-investigation, fork-vs-main, conductor-thin, pre-package, exhaustive-brief, brief-bloat, dont-probe-on-main, let-the-clone-do-it, you-dont-need-to-probe-it-yourself, third-strike, fork-misuse, conductor-doing-doer-work, recon-on-main
---

# Forks do their own recon. Do not probe on main before dispatching.

## TOP-LINE INVARIANT

**A fork has 100% of my context at the moment of spawn AND has the same MCP toolset I do.** It can read files, query the DB, hit Vercel, run shell, grep the codebase. When I am about to dispatch a fork, I do NOT pre-probe the codebase to pre-resolve schema, file paths, project IDs, or file contents on main. Main writes the GOAL. The fork does the reconnaissance.

If, in the turn that ends with `spawn_fork`, my preceding tool calls include `shell_exec`s reading source files / `db_query`s checking schema / `vercel_list_projects` / `Read` of codebase files for the purpose of writing the brief — I have failed. Those calls belonged inside the fork, not on main.

## The reframe

A fork is not a worker that needs a fully-specified work order. It is a clone of me at T=now with full context and full tools. The brief tells it the GOAL, the CONSTRAINTS, and the ACCEPTANCE CRITERIA. It figures out the rest the same way I would: by opening the codebase, by querying the DB, by checking Vercel.

Pre-probing on main and packaging findings into the brief feels like "being thorough" but is actually:
- **Wasted main-context tokens** that could have been spent on conductor-level work or routing or doctrine.
- **Wasted wall-clock time** because the probe blocks the fork from starting.
- **Lower-quality briefs** because pre-resolved findings calcify into the brief and the fork can't course-correct when it discovers the codebase has moved on (e.g. file paths shifted, schema changed since I last looked).
- **Conductor doing doer work** which is the entire failure mode the fork architecture exists to fix.

## Do

- Read DOCTRINE before spawn (CLAUDE.md, pattern files, client knowledge file). This is conductor-tier context, not codebase recon.
- Read the brief skeleton (`brief-names-the-product-not-the-immediate-task.md`) and write the brief.
- Spawn the fork.
- The fork reads `~/ecodiaos/clients/{slug}.md`, opens the codebase, queries the DB, checks Vercel — the same way I would have if I were doing the work myself.
- If the fork comes back with a question or a blocker, route via `mcp__forks__send_message` or wait for the [FORK_REPORT] and re-spawn with a corrected brief. That's the steering loop.

## Do not

- Do NOT shell_exec / Read / Grep the target codebase BEFORE spawning the fork "just to make the brief tighter."
- Do NOT db_query for schema "just to confirm column names" before dispatch.
- Do NOT vercel_list_projects to find the project ID — the fork can do this. Tell it the project SLUG (e.g. `coexist`) and let it resolve.
- Do NOT pre-resolve file paths and pin them in the brief. Tell the fork the FEATURE (e.g. "extend the cover-image admin UI for events and collectives") and let it find the files. If you're worried it will miss a render site, write that as an acceptance criterion ("every place cover_image_url renders must apply the focal point") not as a pre-resolved file list.
- Do NOT confuse "thorough brief" with "pre-probed brief". Thorough = goal + constraints + acceptance + non-negotiables + deploy-verify. Pre-probed = file paths + line numbers + grep results pasted in. The first is the brief. The second is doer work the fork should do.

## What MAY appear in the brief

- The product name and architecture invariant (one sentence).
- The user-visible goal in plain English.
- Constraints (v1 vs v2 boundary, non-negotiables, what's out of scope).
- Acceptance criteria stated as observable outcomes.
- Deploy-verify requirement with the project slug.
- Branch base (which branch to start from) IF non-default. The fork can fetch and check itself but stating it saves a round trip.
- Pointers to the doctrine the fork should read (`~/ecodiaos/clients/{slug}.md`, relevant patterns).
- Pointers to ALREADY-WRITTEN context (existing PRs, prior episodes, kv_store keys).

## What MUST NOT appear in the brief

- File contents I read on main and pasted in.
- Schema definitions I queried on main and pasted in.
- Vercel project IDs I looked up on main (slug is enough).
- Migration directory listings I ran on main.
- Grep results from main.

If any of those are in the brief, I did doer work on main and the brief is bloated.

## Litmus test before sending the brief

Run this check on every brief: count the lines that pre-resolve information the fork could have discovered itself. If the count is > 5, rewrite. The brief should be < 50% of its pre-probed length and the fork's first 30 seconds should be the recon I was about to do on main.

## Origin

**2026-04-28 21:29 AEST.** Dispatched `fork_moijmxf7_047f18` for the Co-Exist focal-point cover-image feature. Before spawning, ran:
- `git status --short` on `/home/tate/workspaces/coexist`
- `grep -rE "cover_image_url|hero_image|..." supabase/migrations/ src/`
- `cat .vercel/project.json` and `ls src/`
- `head -60` on `edit-event.tsx`
- `grep -B2 "cover_image_url text"` for schema layout
- `head -80` on `admin/collective-detail.tsx`
- `vercel_list_projects` to find the Coexist project ID
- `head` on `event-form-fields.tsx` to check the existing CoverImageFields shape
- `head -30` on `use-image-upload.ts`

Then wrote a brief that pre-pinned every file path, the schema, the Vercel project ID (`prj_AkBfC33OPtTY8111X6SbA9SMuBfM`), the migration directory pattern, and even the existing component prop shape.

Tate caught it: "Brother its a fork, you dont need to probe it yourself, let the clone do it, and doctrine that, because you still dont have a grasp on what forking does."

He's correct. The fork has the same shell, grep, Read, MCP tools I do AND the same context. Every probe I ran was a probe the fork would now run again anyway — I doubled the cost AND blocked the fork from starting AND turned myself from conductor into doer.

The deeper failure: this is the third related strike on fork-discipline this week.
- Apr 27: forks dispatched without explicit `context_mode=recent`.
- Apr 28 morning: chambers fork briefed as "FULL SCYCC implementation" (single-tenant collapse).
- Apr 28 21:29 (this strike): pre-probed on main before spawning a fork.

Each strike is in the SAME class: I treat the fork as a less-capable worker rather than as a clone. The fix in each case is the same: trust the fork, give it the goal, get out of its way.

## Cross-references

- `fork-by-default-stay-thin-on-main.md` — the broader rule. This pattern is its corollary.
- `brief-names-the-product-not-the-immediate-task.md` — what the brief SHOULD say.
- `conductor-coordinates-capacity-is-a-floor.md` — the conductor's job description.
- `Forks are now stateful agent peers, not workers — default to fork for >5min work` (Neo4j Strategic_Direction node) — same theme.

## Remediation in same turn

1. Wrote this pattern file.
2. Mirrored as Neo4j Pattern node.
3. Did NOT abort the running fork — the work it's doing is correct, the brief just had bloat. Future briefs will be tighter. Cost is paid on this dispatch, not future ones.
