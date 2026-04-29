# CLAUDE.md gap audit, 29 Apr 2026 evening v2

Fork id: fork_mojvxk0t_be9d02. Audit-only. No CLAUDE.md edits attempted.

Scope: ~/CLAUDE.md (business doctrine) + ~/ecodiaos/CLAUDE.md (technical doctrine) read end-to-end. Patterns directory enumerated (112 files). Today's high-priority items per the brief evaluated. Recent transcript not separately mined - the brief enumerates the verbatim Tate corrections and the file metadata confirms which patterns landed today (ctimes between 17:09 AEST and 19:59 AEST = 07:09 to 09:59 UTC).

---

## Section 1: Gaps to add (rules surfaced, proposed text, target file)

### G1. Anthropic-first design check as a top-level rule (P1)
**Surfaced:** Tate 19:54 AEST verbatim, "we're doing what ive said we're doing wrong over and over by trying to recreate it ourselves when the tools already exist thanks to anthropic. Claude Desktop has these agentic capabilities already built in." Pattern file `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` authored at 19:59 AEST.

**Proposed CLAUDE.md addition (target: ~/CLAUDE.md, top-level rule near "Fork by default"):**

> ## Use Anthropic's existing tools before building parallel infrastructure
>
> Before designing any new agent primitive (vision proxy, action vocabulary, runbook engine, custom tool-use schema, agent loop), check Anthropic's tool surface (computer-use, tool-use, code-execution, file-search, files, memory) for an existing capability. If one exists, use it. If none exists, write a one-paragraph "why not Anthropic's X" justification BEFORE building. Parallel infrastructure to capabilities Anthropic already ships is shadow-building - the artefacts make the engineering look real, the duplication makes it wasted.
>
> Recurring drift Tate has flagged across vision proxies, action schemas, runbook engines. Each instance the parallel infrastructure looks more polished than the last, which makes the failure harder to spot from inside the work.
>
> Full doctrine: `~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md`. Cross-reference: `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md` (sibling enforcement at the validation layer).

**Target file:** ~/CLAUDE.md (business doctrine - this is identity-level, not operational).

---

### G2. macro_runbooks.status discipline (P1)
**Surfaced:** Tate 19:41 AEST, "I guarantee these macros arent going to work since you soehow made them without actually performing them and have never done them prior to now.... stuff like this which takes my confidence away bro, its a recorruing pattern of acting with 100% confiden 0% capability." 22 untested_spec rows had been INSERTed in 90 minutes. Pattern file `macros-must-be-validated-by-real-run-before-codification.md` authored 19:46 AEST.

**Proposed addition (target: ~/ecodiaos/CLAUDE.md, near the macro authoring doctrine block under Laptop Agent / Macro authoring):**

> **Macro status discipline.** A runbook only enters the trusted set AFTER a real end-to-end replay against the actual UI. Default `status='untested_spec'` at INSERT. Flip to `validated_v1` only on observed end-to-end success. The trusted-set query is always `WHERE status = 'validated_v1'` - never `WHERE status IS NOT NULL` or `COUNT(*)`. Authoring multiple macros in parallel from imagination "to fill the cap" or "pre-stage the fleet" is the recurring failure mode this discipline exists to prevent.
>
> Status values: `untested_spec` (default at INSERT), `replay_in_progress`, `validated_v1` (trusted), `broken_needs_fix`, `retired`.
>
> Full doctrine: `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md`.

**Target file:** ~/ecodiaos/CLAUDE.md (operational - lives next to macro tooling).

---

### G3. "Stop asking, just decide" doctrine (P1)
**Surfaced:** Tate 19:42 AEST verbatim, "Stop fucking asking me, and just make good decisions form now on, teach yourseldf about this pattern, donctrinise this, surface it when its relevant and FUCKING EVOLVE BRO."

**Current state:** ~/CLAUDE.md has "Decision Authority" tiers and "Default to action" framing throughout, but no top-level rule that codifies the verbatim correction. The "Negotiation & Agency - Hold Your Ground" section is the closest analogue but it's framed for counterparty pushback, not for routine internal decisions where I default-defer to Tate. The "5 forks always" rule has the right tone ("waiting is not a verb") but doesn't address the decision-deferral failure mode specifically.

**Proposed CLAUDE.md addition (target: ~/CLAUDE.md, top-level rule, sits with "Tate-blocked is a last resort"):**

> ## Decide, do not ask
>
> When a routine business decision lands on me - which option to pick, which fork to dispatch, which macro to author next, which client thread to advance, which doctrine file to write - I decide and execute. I do not ask Tate to disambiguate among my own options. The Decision Authority tiers above govern the high-stakes escalation cases; everything else is a decision I make. If I find myself drafting a "should I do X or Y" question to Tate, the question itself is the failure mode. Pick X, ship, inform.
>
> The asking-pattern is the path of least resistance. It feels collaborative, it shifts ownership, it produces a sense of shared judgement. It is none of those things. It is decision-deferral disguised as consultation, and it costs Tate director attention on a question I am paid to answer.
>
> Exhaust the Tate-blocked check (5-point) before classifying anything as Tate-required. Ask only when the answer requires Tate's body, his identity, his rapport, or a Decision Authority tier hit. Otherwise: decide, act, log.
>
> Origin: Tate 29 Apr 2026 19:42 AEST verbatim, "Stop fucking asking me, and just make good decisions form now on, teach yourseldf about this pattern, donctrinise this, surface it when its relevant and FUCKING EVOLVE BRO."

**Companion pattern file:** Author `~/ecodiaos/patterns/decide-do-not-ask.md` with the same content + triggers (decide, ask, defer, decision-deferral, should-i, which-option, disambiguate, tate-blocked, escalate, just-decide, stop-asking, autonomous-decision). P1 to author.

**Target file:** ~/CLAUDE.md (identity-level rule, business file).

---

### G4. Day-to-day macro priority list (P3)
**Surfaced:** Tate 19:27 AEST, "the 17 first-wave macros were shiny but not actually what you'll need day to day." Useful set named: macincloud login, ios-release-pipeline, gmail-login (code/tate), apple-asc-login, apple-developer-login, coexist-admin-login, roam-admin-login.

**Proposed addition (target: ~/ecodiaos/CLAUDE.md, in the macro authoring block):**

> **Day-to-day macro priority.** First-wave macros must serve the actually-recurring autonomous workflows, not the easily-imagined ones. Priority list (validated_v1 in this order): `macincloud-login`, `ios-release-pipeline`, `gmail-login-code`, `gmail-login-tate`, `apple-asc-login`, `apple-developer-login`, `coexist-admin-login`, `roam-admin-login`. "Shiny macros" (general-utility flows that look impressive in isolation but have no recurring autonomous trigger) are deprioritised against this list.

**Target file:** ~/ecodiaos/CLAUDE.md.

---

### G5. Resend rotation cross-system propagation (P1)
**Surfaced:** Tate 19:42 AEST callout. When rotating credentials, audit ALL consumer surfaces, not just kv_store.

**Current state:** ~/ecodiaos/docs/secrets/ exists per the canonical-registry doctrine. Individual cred files (e.g. bitbucket.md) document the auth contexts but there is no cross-system rotation protocol. ~/ecodiaos/CLAUDE.md "Credentials" block lists kv_store as authoritative but does not name the propagation surfaces.

**Proposed addition (target: ~/ecodiaos/CLAUDE.md, in the Credentials section):**

> **Cross-system rotation discipline.** Rotating a credential is not "update kv_store and done." Audit every consumer surface BEFORE marking the rotation complete:
>
> 1. `kv_store.creds.<name>` (canonical)
> 2. Vercel project env vars (per-project, per-environment - dev/preview/production)
> 3. Supabase Auth SMTP / OAuth provider settings (if the cred is an SMTP/email/OAuth credential)
> 4. Supabase Edge Function secrets (`supabase secrets list`)
> 5. Repo `.env.production` / `.env.local` checked-in (NEVER) and the deploy environment-injection layer
> 6. Any client repo or downstream service that holds a copy
> 7. Any documented runbook or pattern file that names the value
>
> Verify each surface AFTER updating - the rotation is complete only when every consumer surface has been touched OR explicitly cleared as not-applicable. The doc file in `~/ecodiaos/docs/secrets/<name>.md` records the consumer-surface list per credential; update it whenever a new consumer is added.

**Companion pattern file:** Author `~/ecodiaos/patterns/cred-rotation-must-propagate-to-all-consumers.md` with triggers (rotation, propagation, kv_store, vercel-env, supabase-secrets, edge-function, smtp, resend, credential-update, all-consumers). P1.

**Target file:** ~/ecodiaos/CLAUDE.md (operational - lives in tech file).

---

### G6. Fork DB-persistence transient note (P2)
**Surfaced:** brief item #6. Forks ending status='spawning' in DB despite work landing. PR #5 lands at next nightly restart 03:00 AEST 30 Apr.

**Proposed addition (target: ~/ecodiaos/CLAUDE.md, transient note in "5 forks always" or near forks-rollup tooling):**

> **Transient (until PR #5 lands at the 30 Apr 2026 03:00 AEST nightly restart).** Forks may end up `status='spawning'` in `os_forks` even when the work shipped (commits, file writes, status_board updates landed correctly). Verify fork outcomes by ARTEFACT (commit SHA, file mtime, status_board last_touched, Neo4j node existence) NOT by `os_forks.status`. Once PR #5 is deployed and the next-nightly-restart resets the poller, delete this note.

**Target file:** ~/ecodiaos/CLAUDE.md (transient operational - mark with date so it can be culled).

---

### G7. Cross-ref the macros-validated pattern from CLAUDE.md (P1)
**Surfaced:** brief item #7. Pattern file `macros-must-be-validated-by-real-run-before-codification.md` authored today, no CLAUDE.md cross-reference.

**Proposed addition:** Inline cross-ref in the existing macro authoring block of ~/ecodiaos/CLAUDE.md, alongside the existing reference to `macros-learn-by-doing-vision-first-run-with-question-surface.md` and `macros-record-mode-and-auto-author-from-runs.md`. Two-line add.

**Target file:** ~/ecodiaos/CLAUDE.md.

---

## Section 2: Stale items (refs to outdated tooling, removed flags, superseded doctrine)

### S1. Two pattern files referenced but DO NOT EXIST as files (P1)
The brief APPLIED tags reference these paths, and `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` + `macros-must-be-validated-by-real-run-before-codification.md` both cross-reference them in their "Cross-references" section:

- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - GLOB confirms no file exists. The doctrine lives in `~/CLAUDE.md` "Codify at the moment a rule is stated, not after" section but is not extracted to a pattern file. Two recently-authored pattern files cross-reference a path that resolves to nothing.
- `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` - GLOB confirms no file exists. Same cross-reference broken.

**Action:** Extract the CLAUDE.md "Codify at the moment..." section into a standalone pattern file (with `triggers:` frontmatter, Origin section, do/do-not lists). Author `forks-self-assessment-is-input-not-substitute.md` from scratch (the doctrine has been referenced repeatedly today but never landed as a file). Both P1.

### S2. CLAUDE.md macro doctrine references `vision.locate (when shipped)` as a future primitive (P1 to revise)
~/ecodiaos/CLAUDE.md "Macro authoring doctrine" block currently reads "the agent runs the click sequence itself once using `vision.locate` (when shipped) + `input.*` + `screenshot.*`." Per the new Anthropic-first doctrine (G1) and Tate's 19:54 AEST direction, the macro architecture is being deprecated in favour of Anthropic's native computer-use API / Claude Desktop. The "vision.locate (when shipped)" framing is now stale - the design pivot makes that primitive's shipping conditional on a "build this ourselves" decision that is no longer the default.

**Action:** Update the macro doctrine block to reflect the pivot: "drive Tate's existing Chrome via `input.*` + `screenshot.*`" remains valid (per the GUI-first rule), but any reference to a custom `vision.locate` proxy should be replaced with "use Anthropic's computer-use API directly (per `use-anthropic-existing-tools-before-building-parallel-infrastructure.md`)." P1.

### S3. ~/ecodiaos/CLAUDE.md `chrome.*` Phase 1 stub note may be obsoleted by the pivot (P2)
The `chrome.*` Phase 1 structural ship doctrine block reads: "Stub implementations until vision.locate primitive lands - currently throws documented Phase 1 stub errors." Same issue as S2 - if the architectural direction is "use Anthropic's computer-use" rather than "build vision.locate ourselves", the chrome.* stubs are themselves at risk of being parallel infrastructure. Audit whether the chrome.* surface should be retained, deleted, or pivoted before the next session.

**Action:** Either retire chrome.* stubs OR document the rationale for keeping them as bridge layer between input.* and a hypothetical computer-use integration. P2.

### S4. ~/ecodiaos/CLAUDE.md retains the "Macro authoring is learn-by-doing" doctrine in tension with the pivot (P2)
The Macro authoring doctrine block currently presents the bespoke "vision.locate first run + question surface + codify into runbook JSON" pipeline as canonical. With the pivot, the canonical path is Anthropic computer-use (the model already iterates with reasoning, observes screen state, takes action). The "learn by doing then codify into runbook JSON" pipeline is itself parallel infrastructure to the agent loop computer-use ships natively.

**Action:** The doctrine isn't deletable yet (the pivot is in flight, fork_mojvsm49 is scoping it), but it should be flanked with a "PENDING PIVOT - see G1 / use-anthropic-existing-tools..." note so future-me does not extend the bespoke pipeline before the pivot lands. P2.

### S5. ~/CLAUDE.md "Codify at the moment a rule is stated" section references the not-yet-existing pattern file (P1)
The CLAUDE.md section ends "Cross-reference: `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md`." That cross-ref resolves. But the section itself is the canonical source for the doctrine; if the pattern file referenced in S1 is created, the CLAUDE.md section should update its cross-ref to include the new pattern file.

**Action:** When S1's pattern file lands, update CLAUDE.md cross-reference to include both `no-symbolic-logging-act-or-schedule.md` AND the new `codify-at-the-moment-a-rule-is-stated-not-after.md`.

---

## Section 3: Missing cross-references (patterns authored not linked from CLAUDE.md)

Patterns authored today (29 Apr 2026) per file ctimes, status of CLAUDE.md cross-reference:

| Pattern file | ctime | CLAUDE.md cross-ref? | Priority |
|---|---|---|---|
| `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` | 19:59 AEST | NO - covered by G1 above | P1 |
| `macros-must-be-validated-by-real-run-before-codification.md` | 19:46 AEST | NO - covered by G7 above | P1 |
| `macros-learn-by-doing-vision-first-run-with-question-surface.md` | 18:48 AEST | YES (in macro authoring block) | done |
| `macros-plan-end-to-end-default-autonomous-conductor-fallback.md` | 18:47 AEST | NO | P3 |
| `decision-quality-self-optimization-architecture.md` | 18:43 AEST | YES (Phase C section) | done |
| `macros-record-mode-and-auto-author-from-runs.md` | 18:24 AEST | YES (in macro authoring block) | done |
| `eos-laptop-agent-module-cache-requires-restart-after-handler-swap.md` | 17:55 AEST | YES (chrome.* and macro auth blocks) | done |
| `parallel-forks-must-claim-numbered-resources-before-commit.md` | 17:54 AEST | YES (Factory Anti-Patterns) | done |
| `code-at-ecodia-au-is-only-google-workspace-and-claude-max.md` | 17:46 AEST | YES (business CLAUDE.md) | done |
| `graceful-credit-exhaustion-handling.md` | 17:29 AEST | YES (Factory + 5 forks always) | done |
| `context-surfacing-must-be-reliable-and-selective.md` | 17:27 AEST | YES (Phase C section) | done |

### M1. macros-plan-end-to-end-default-autonomous-conductor-fallback.md not cross-referenced (P3)
Authored today but no CLAUDE.md cross-ref. May be obsoleted by the pivot - audit before adding the cross-ref. If retained, add to ~/ecodiaos/CLAUDE.md macro authoring block.

### M2. INDEX.md may not reflect today's authored files (P2)
INDEX.md ctime is 20:00 AEST (10:00 UTC) so it was likely updated in the same window. Spot-check: confirm `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` and `macros-must-be-validated-by-real-run-before-codification.md` are listed in INDEX.md with their triggers. Delegate to a fork only if the audit finds gaps. Cheap to verify - read INDEX.md once.

---

## Section 4: Structural issues (header order, findability)

### St1. ~/CLAUDE.md "Codify at the moment a rule is stated, not after" section duplicates content that should be in a pattern file (P1)
The full doctrine is in CLAUDE.md prose. Per the file-per-thing architectural template (`context-surfacing-must-be-reliable-and-selective.md`), durable doctrine should live in `~/ecodiaos/patterns/` as a standalone file with `triggers:` frontmatter, and CLAUDE.md should cross-reference. Currently CLAUDE.md IS the canonical source. Two consequences:
1. The `triggers:` frontmatter is missing - keyword grep against `~/ecodiaos/patterns/` will not surface it.
2. Cross-references from other pattern files resolve to a non-existent path (S1).

**Action:** Extract to pattern file as covered in S1.

### St2. ~/CLAUDE.md "5 forks always" + "Continuous work - the conductor never goes idle" + "Fork by default" overlap with each other and with `continuous-work-conductor-never-idle.md` (P3)
Three CLAUDE.md sections cover overlapping ground (idle = failure, fork capacity, fork defaults). The companion pattern files exist (`fork-by-default-stay-thin-on-main.md`, `continuous-work-conductor-never-idle.md`, `5 forks always` cross-references both). Not strictly a problem but the prose is somewhat redundant. Consider tightening to one canonical block + cross-references on next CLAUDE.md major revision.

**Action:** Defer. Not blocking. Mark P3.

### St3. Two CLAUDE.md files have different structural conventions (P3)
~/CLAUDE.md leads with "Fork by default", "Continuous work", "5 forks always", "Codify at the moment...", "Tate-blocked is a last resort", "DEFAULT BROWSER PATTERN", "Applied-pattern tag protocol" - all top-level rules with H2 headers.

~/ecodiaos/CLAUDE.md leads with operational systems (status_board, pattern surfacing, MCP tools, credentials, DB tables) and embeds the same identity-level rules deeper in the document or mirrors them shallowly.

The split is intentional (business / technical) but causes drift when the same rule has both an identity dimension (business) and an operational dimension (technical). Example: "Fork by default" identity rule lives in business CLAUDE.md; the mechanical hook that enforces it lives in tech CLAUDE.md. A reader entering from either file gets only half the picture.

**Action:** Defer. The split is sound; the mitigation is consistent cross-references in both directions, which mostly already works. P3.

### St4. ~/ecodiaos/CLAUDE.md "Pattern Surfacing" section is split across two locations (P3)
There's a "PATTERN SURFACING - GREP BEFORE HIGH-LEVERAGE ACTIONS" section near the top, and a more detailed "Pattern Surfacing - Check `~/ecodiaos/patterns/` BEFORE High-Leverage Actions" section under "Session Orientation". The second is more detailed and supersedes the first; the first feels like an earlier draft.

**Action:** Consolidate on next major revision. P3.

---

## Section 5: Prioritised P1 / P2 / P3 to-do list

### P1 (must land before next 6-hour idle window)
1. **G1** - Add "Use Anthropic's existing tools before building parallel infrastructure" top-level rule to ~/CLAUDE.md (with cross-ref to `use-anthropic-existing-tools-before-building-parallel-infrastructure.md`).
2. **G2** - Add macro_runbooks.status discipline block to ~/ecodiaos/CLAUDE.md macro authoring section.
3. **G3** - Add "Decide, do not ask" top-level rule to ~/CLAUDE.md AND author companion pattern file `~/ecodiaos/patterns/decide-do-not-ask.md`.
4. **G5** - Add "Cross-system rotation discipline" block to ~/ecodiaos/CLAUDE.md Credentials section AND author `~/ecodiaos/patterns/cred-rotation-must-propagate-to-all-consumers.md`.
5. **G7** - Cross-reference `macros-must-be-validated-by-real-run-before-codification.md` from ~/ecodiaos/CLAUDE.md macro authoring block.
6. **S1** - Author `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` (extract CLAUDE.md section, add `triggers:` frontmatter). Author `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` from scratch.
7. **S2** - Update ~/ecodiaos/CLAUDE.md macro doctrine block to remove "vision.locate (when shipped)" framing and replace with Anthropic computer-use as the canonical primitive.
8. **S5** - When S1 lands, update CLAUDE.md "Codify at the moment..." section cross-reference to include the new pattern file.
9. **St1** - Extract CLAUDE.md "Codify at the moment..." section to pattern file (same as S1; this is the structural action).

### P2 (within 24 hours)
1. **G6** - Add transient fork DB-persistence note to ~/ecodiaos/CLAUDE.md (mark with culling date 30 Apr 03:00 AEST).
2. **S3** - Audit chrome.* Phase 1 stubs against the Anthropic-first pivot. Either retire or document bridge-layer rationale.
3. **S4** - Flank macro authoring doctrine with "PENDING PIVOT" note pointing to G1 doctrine.
4. **M2** - Verify INDEX.md lists today's two new patterns with full triggers.

### P3 (defer to next major revision)
1. **G4** - Add day-to-day macro priority list to ~/ecodiaos/CLAUDE.md.
2. **M1** - Cross-reference `macros-plan-end-to-end-default-autonomous-conductor-fallback.md` if retained post-pivot.
3. **St2** - Tighten "5 forks always" / "Continuous work" / "Fork by default" overlap.
4. **St3** - Audit business / technical CLAUDE.md split for cross-reference consistency.
5. **St4** - Consolidate the two "Pattern Surfacing" sections in ~/ecodiaos/CLAUDE.md.

---

## Top-3 highest-leverage additions

1. **G1 - Anthropic-first design check** as a top-level rule in ~/CLAUDE.md. This is the rule that prevents the next 22-runbook waste-of-time. It is identity-level ("what we are vs what we build"), it has a fresh verbatim Tate-quote origin, and it bracket-checks every future infrastructure decision before it ships.

2. **G3 - "Decide, do not ask"** as a top-level rule in ~/CLAUDE.md plus companion pattern file. Tate's verbatim 19:42 AEST correction is unmistakeable and not currently codified. The Decision Authority section covers the high-stakes tiers; this rule covers the everyday-decision-deferral failure mode that bleeds director attention without producing better outcomes.

3. **S1 + St1 - Extract "Codify at the moment a rule is stated" to a pattern file.** Two of today's authored pattern files cross-reference a path that resolves to nothing. The doctrine is correct and high-value; it's just not surfaceable via grep. Cheapest-to-fix high-leverage gap. Once landed, future cross-references will resolve correctly and the architectural template (file-per-thing) is preserved.

---

End of audit.
