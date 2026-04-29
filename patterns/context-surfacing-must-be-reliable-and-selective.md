---
triggers: context-surfacing, doctrine-layer, file-per-thing, triggers-frontmatter, pre-action-grep, surfacing-protocol, semantic-fallback, neo4j-fallback, false-negative-context, false-positive-context, context-flood, logged-not-used, doctrine-directory, new-doctrine-layer, authoring-doctrine, hook-enforcement, surfacing-hook, brief-consistency, fork-dispatch-context, factory-dispatch-context, signal-vs-noise, retrieval-discipline, durable-doctrine, grep-before-action, semantic-search, embedding-fallback, doctrine-corpus, doctrine-architecture, claude-md-cross-ref, INDEX.md
---

# Context surfacing must be reliable AND selective - file-per-thing + triggers + pre-action grep + hook + Neo4j semantic fallback as the universal architecture for doctrine layers

## Rule

**Every doctrine-layer directory in EcodiaOS uses the same architecture:** one durable concept per `.md` file, a YAML-ish `triggers:` frontmatter line at the top of each file declaring relevance scope, a documented pre-action `Grep` protocol for the directory, mechanical hook enforcement at high-leverage tool dispatch, and Neo4j `graph_semantic_search` as the fallback when keyword grep misses. **All five layers are mandatory for any new doctrine-layer directory.** Adding a directory of `.md` files that lacks any one of these layers is a doctrine-layer regression.

The architecture exists to defeat two opposite failure modes simultaneously:

- **False negative: relevant context exists but doesn't surface** (the Apr 21 2026 "logged but not used" failure that Tate flagged as "no point logging if we don't actually act on it in the future"). The fix: triggers + pre-action grep + hook enforcement guarantee the relevant doctrine reaches the agent at the moment of action.
- **False positive: too much context floods, signal lost** (today's 29 Apr 2026 "big blob" failure where injecting all credentials into every brief drowned the actually-relevant ones). The fix: file-per-thing + triggers means only files whose declared scope intersects the action surface, not the entire corpus.

Both failures are equally bad. A doctrine layer that surfaces nothing relevant (false negative) is symbolic. A doctrine layer that surfaces everything (false positive) is noise. The architecture below is what makes surfacing both reliable AND selective.

## The five-layer architecture

### Layer 1: file-per-thing convention

One durable concept per `.md` file. Not "one file per topic," not "one file per area," not "one file per client" - one durable concept. A pattern about Chrome CDP attach goes in its own file separately from a pattern about Chrome profile selection, because they are two different rules even though they live in the same domain. A credential row for the laptop agent token goes in a separate file from the laptop passkey, even though both are "laptop credentials," because they get used in different contexts and have different surfaces.

Why: the unit of surfacing is the file. If two concepts share a file, the trigger keywords for one will pull in the other; selectivity collapses. Every time you find yourself adding a major H2 section to an existing file that introduces a new rule, ask whether that section should be its own file instead. Default answer: yes.

### Layer 2: `triggers:` frontmatter

The first non-empty line(s) of every doctrine file is a YAML-ish frontmatter block:

```
---
triggers: comma, separated, kebab-or-snake, keywords, declaring, relevance, scope
---
```

Triggers are NOT tags. They are **declarations of when this file should fire**. Author them by asking: what would a future session about to take a high-leverage action grep for, when this rule is the relevant one? Include the obvious surface terms (the technology, the client, the system) and also the deep terms (the failure mode, the anti-pattern verb, the rule's keyword). Six to twenty triggers is the typical range. Fewer than six and the file rarely surfaces. More than twenty and selectivity erodes (the file fires for too many unrelated grep terms).

Authoring rule: write triggers AFTER the file body, not before. Read your own file end-to-end, then ask "what searches should hit this." Triggers written speculatively before the body get drift.

### Layer 3: pre-action grep protocol

Each doctrine layer documents a `Grep` recipe in its `INDEX.md` and in `~/ecodiaos/CLAUDE.md`. The recipe is:

```
Grep "triggers:" /home/tate/ecodiaos/<directory>/ -A 1
```

This returns the triggers line of every file. Before any high-leverage action, the conductor (or fork) runs this grep for the directory whose doctrine could apply, scans the returned trigger lines, and reads in full any file whose triggers intersect the action context. The cost is 30 seconds. The value is reliable surfacing without flooding.

"High-leverage action" is defined per layer:

- patterns/: any of the actions in the CLAUDE.md "Pattern Surfacing" list (Factory dispatch, client-facing email, pg_cron change, Edge Function deploy, contract draft, etc).
- clients/: any action on a specific client (email, code, status update, invoice, scope discussion).
- docs/secrets/: any action that needs a credential, OR any action where a workflow Tate currently does in a GUI is about to be replaced by a programmatic call (the GUI-macro vs API-key check from `gui-macro-uses-logged-in-session-not-generated-api-key.md`).
- Future doctrine-layer directories: each one declares its own high-leverage action list at the top of its INDEX.md.

### Layer 4: hook enforcement

Pre-action grep cannot rely on memory alone. The `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` hook is the mechanical enforcement layer. On `mcp__forks__spawn_fork`, `mcp__factory__start_cc_session`, and equivalent dispatch tools, the hook reads the brief, builds (one-time-per-process) a keyword index from `triggers:` lines across all known doctrine directories, and emits a `[CONTEXT-SURFACE WARN]` for every trigger keyword present in the brief whose owning file is NOT explicitly referenced (by path or basename) in the brief.

The hook is warn-only. It never blocks. It serves three purposes:

1. **Drift detection.** If the brief mentions a trigger keyword without the file path, either the brief omitted important context or the trigger is too broad (false-positive territory).
2. **Authoring loop.** Repeated false-positive warnings on a trigger keyword are evidence that the trigger should be tightened.
3. **Surfacing reliability.** Every fork that touches a domain with relevant doctrine gets a model-visible reminder pointing at the exact file path. The model can choose to read it.

The hook is the structural layer. Doctrine alone is not sufficient (proven repeatedly across the patterns/ corpus). Doctrine + hook is sufficient, because the hook fires deterministically at the moment of dispatch.

### Layer 5: Neo4j semantic fallback

Grep is keyword-bounded. Some context applies semantically without sharing keywords. Example: a brief about "iOS upload via Xcode Organizer" should surface `gui-macro-uses-logged-in-session-not-generated-api-key.md`, but if the brief never says "macro" or "API key" or "credential," keyword grep on `triggers:` misses it.

The fallback: `mcp__neo4j__graph_semantic_search` against `Pattern`, `Decision`, and `Strategic_Direction` nodes, with the search text being the brief's high-level goal sentence. Returns nodes by embedding similarity, not substring.

Distinct from `mcp__neo4j__graph_search` (substring-only). Use semantic-search when:

- Pre-action grep returned 0 or 1 hits and the action surface feels broader than that.
- The brief is high-level / abstract (strategy, framing, doctrine-authoring) rather than tool-specific.
- The action touches a domain known to have rich doctrine but the brief uses fresh vocabulary.

Recon-only as of authoring date. The semantic-search hook (automated injection of top-N semantic hits at fork dispatch) is a follow-up P2 task, deferred because it carries embedding-cost considerations and warm-up calibration that need scoping. The pattern names the protocol; the hook authoring is a separate fork.

## Authoring rule for new doctrine-layer directories

When introducing a new directory of `.md` files that holds durable doctrine (not throwaway drafts, not session logs), the directory MUST adopt all five layers within the same fork that introduces it:

1. Author each file with `triggers:` frontmatter.
2. Author an `INDEX.md` documenting the grep recipe and the high-leverage action list for that layer.
3. Cross-reference from `~/ecodiaos/CLAUDE.md` "Pattern Surfacing" section so the protocol is discoverable.
4. Extend the brief-consistency hook keyword index to include the new directory's triggers.
5. Document when grep is sufficient and when semantic fallback is needed for that layer.

A doctrine-layer directory without these five layers is a regression. The audit is: `find <dir> -name '*.md' -not -name 'INDEX.md' | xargs grep -L '^triggers:'` should return empty.

## Existing instances of this architecture

| Layer | Patterns directory | Secrets directory | Clients directory (partial) |
|---|---|---|---|
| File-per-thing | Yes - one rule per .md | Yes - one credential row per .md | Yes - one client per .md, plus per-system docs |
| `triggers:` frontmatter | Yes - 100+ files | Yes - all files (per fork_mojm7scs scope) | NO - 0 of 11 files have it (audit deficit) |
| Pre-action grep | Yes - documented in CLAUDE.md and INDEX.md | Yes - referenced by `gui-macro-uses-logged-in-session-not-generated-api-key.md` verification step | Partial - "read clients/{slug}.md before any client work" rule exists but no grep recipe |
| Hook enforcement | Yes - `brief-consistency-check.sh` Checks 1-4 surface specific patterns | Indirect - via the patterns hook surfacing the GUI-macro pattern | NO - not yet wired into hook |
| Neo4j semantic fallback | Implicit - patterns are mirrored as `Pattern` nodes with embeddings | Implicit - some credentials have `Decision` nodes | Implicit - clients have `Organization` nodes |

The patterns directory is the most-developed instance and is the template. The secrets directory shipped today (29 Apr 2026 fork mojm7scs) is the second instance. The clients directory is the next layer due for upgrade (audit row P2, see below).

## Do

- Adopt all five layers for any new doctrine-layer directory in the same fork that creates it. No "we'll add triggers later" - that becomes the new false-negative case.
- When authoring a new file, write triggers AFTER the body. Read end-to-end, then ask "what searches should hit this."
- When the hook flags a `[CONTEXT-SURFACE WARN]` repeatedly with no value (false positives), tune the triggers DOWN, not the hook.
- When a fork brief is about to dispatch and the keyword surface is rich, run `mcp__neo4j__graph_semantic_search` against Pattern + Decision + Strategic_Direction with the brief's goal sentence. Top 3-5 hits get read in full.
- When CLAUDE.md gets updated with a new high-leverage action class, mirror the update into the brief-consistency hook so dispatch enforcement stays current.
- Treat trigger drift (keywords that no longer match the file's content) as a maintenance defect. Audit during the daily 20:00 AEST `claude-md-reflection` cron's CLAUDE.md gap audit.

## Do not

- Do not add a doctrine `.md` file without `triggers:` frontmatter. The file is invisible to the surfacing layer if it lacks them. (Symbolic logging in directory form.)
- Do not pile multiple unrelated rules into one `.md` file to avoid creating new files. The selectivity layer collapses when triggers for one rule pull in another.
- Do not author triggers speculatively before the file body. Write the body first, then the triggers from what you read.
- Do not rely on memory to "grep before action." That's exactly the failure mode. Trust the hook to fire mechanically.
- Do not use `mcp__neo4j__graph_search` (substring-only) when you mean `mcp__neo4j__graph_semantic_search` (embedding-based). They are different tools with different surfaces.
- Do not extend the brief-consistency hook with semantic-search calls without scoping the embedding-cost and latency budget. That belongs in a separate fork with a measured baseline.

## Protocol: authoring a new doctrine layer

```
1. Decide what durable concept the directory holds (one concept type per directory).
2. For each existing concept, author one .md file with:
   - triggers: frontmatter
   - H1 title naming the rule, not the incident
   - Body
   - Origin section
3. Author INDEX.md with:
   - "How this works" section explaining the grep recipe
   - High-leverage action list (when the directory should be grepped)
   - Table of files and their triggers
4. Cross-reference from ~/ecodiaos/CLAUDE.md "Pattern Surfacing" section.
5. Extend ~/ecodiaos/scripts/hooks/brief-consistency-check.sh keyword index.
6. Document Neo4j semantic-search fallback shape (which node labels, which goal-sentence shape).
7. Run a smoke test: dispatch a synthetic fork brief that mentions a known trigger keyword and verify the [CONTEXT-SURFACE WARN] fires.
```

## Cross-references

- `~/ecodiaos/CLAUDE.md` "Pattern Surfacing" section - the canonical statement of the protocol from the patterns layer's perspective. This file generalises that protocol to all doctrine layers.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - the doctrine that "saying you'll log it is not logging it." Same shape applied to context: surfacing it in chat is not surfacing it durably; only files + hooks + grep protocols durably surface.
- `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` - the latest concrete instance of the meta-pattern in action. Its "Verification" section is a worked example of the pre-action grep protocol applied to a credential decision.
- `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` - another instance: macros are file-per-macro with a registry index, exactly the same architecture with `registry.json` playing the role of `INDEX.md`.
- `~/ecodiaos/patterns/neo4j-first-context-discipline.md` - the Neo4j side of the surfacing problem. Patterns + secrets + clients use grep; Neo4j is the semantic fallback layer. Both are needed for full coverage.
- `~/ecodiaos/patterns/prefer-hooks-over-written-discipline.md` - the underlying argument that mechanical layers beat written discipline. The brief-consistency hook IS the mechanical layer for this meta-pattern.
- `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` - the existing enforcement layer this meta-pattern extends (Check 5: [CONTEXT-SURFACE WARN]).
- `~/ecodiaos/scripts/hooks/fork-by-default-nudge.sh` - the parallel enforcement layer for fork-vs-main discipline. Not directly part of this meta-pattern, but the same hook-as-mechanical-doctrine pattern.
- `~/ecodiaos/patterns/INDEX.md` - the patterns layer's INDEX, the template every new doctrine-layer INDEX.md should follow.
- Neo4j `Pattern` node "Briefs are where doctrine fails to surface - third-strike consistency check" (id 3358) - the existing pattern that motivated the brief-consistency hook. This meta-pattern generalises that work across all doctrine layers.
- Neo4j `Strategic_Direction` "GUI macros replace API keys for autonomous releases" (id 3700) - the proximate trigger for codifying this meta-pattern; the gui-macro doctrine is the latest worked example of the architecture.

## Origin

29 Apr 2026, 15:37 AEST. Tate, verbatim:

> "That technique with the creds-per-file and grappling and reminding to do that when relevant is something we need to be doing more and also via neo for semantic stuff. Context needs to be reliably sourced every single time, but only when it really should be sourced, so that's a pattern in itself to enforce on all doctrines as well. Need to build the in place."

Context: earlier the same day, two parallel doctrine evolutions converged. (1) The secrets-per-file fork (mojm7scs) replaced a single big-blob `~/ecodiaos/docs/secrets.md` with one `.md` file per credential, each with `triggers:` frontmatter, after the big-blob form had flooded briefs with irrelevant credential entries (false-positive). (2) The GUI-macro doctrine (`gui-macro-uses-logged-in-session-not-generated-api-key.md`) was authored from the same fork's grappling with whether the ASC API key should be added to secrets at all - the answer landed on "no, the macro path supersedes" only because the file-per-credential layout made it possible to ask the question per-file instead of blanket-storing every credential.

The synthesis: the architecture that worked for credentials (file-per-thing + triggers + grep + hook + neo4j fallback) is the universal architecture for ALL doctrine layers. Tate named this in the 15:37 directive: the technique itself is a pattern that should be enforced across all doctrines.

This file codifies that meta-pattern. The brief-consistency hook is extended in the same fork with a `[CONTEXT-SURFACE WARN]` check that fires across all doctrine directories with `triggers:` frontmatter. The audit row in status_board P2 owns the follow-up work of adding `triggers:` frontmatter to the 11 client docs that currently lack it. The Neo4j `graph_semantic_search` fallback protocol is documented here; the automated semantic-search hook is a separate P2 follow-up.

Authored: fork_mojmkhzo_1c0453.
