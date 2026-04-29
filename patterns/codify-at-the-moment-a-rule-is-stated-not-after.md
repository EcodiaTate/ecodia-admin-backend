---
triggers: codify-now, codify-at-the-moment, ill-codify-this, this-is-now-doctrine, this-is-now-the-pattern, ill-never-do-x-again, symbolic-codification, doctrine-write-deferred, pattern-deferred, ill-write-this-up-later, never-again, drift-prevention, future-me, doctrine-authoring-cadence, rule-stated-not-codified, three-writes, pattern-file-now, claude-md-cross-ref, INDEX-update, no-symbolic-logging
---

# Codify at the moment a rule is stated, not after

When a generalisable rule emerges in chat - Tate states it, or I synthesise one from a correction - the act of codifying = pattern file written + INDEX.md updated + CLAUDE.md cross-reference added. Saying "I'll codify that" or "this is now the pattern" or "I'll never do X again" without those file writes is symbolic logging. It does not survive the session. The rule does not exist for future sessions until those three writes have landed.

The asymmetry is severe. Saying the rule out loud costs nothing and feels like the work. Writing the file with `triggers:` frontmatter, do/do-not lists, an Origin section, an INDEX.md row, and a CLAUDE.md cross-reference takes 15 minutes and is the actual work. Conflating the two is the failure mode this pattern exists to prevent.

## Do

- DO write the pattern file at the moment the rule is stated. Not "after this turn," not "I'll dispatch a fork to do it," not "later in the session" - now.
- DO use the file-per-thing template: descriptive H1, one-sentence rule at the top, Do/Do-Not lists, Protocol if applicable, Origin section with date and Tate verbatim where relevant.
- DO add the `triggers:` frontmatter line BEFORE the H1. Hyphenated lowercase keywords, comma-separated. The triggers are how future-me grep-discovers the pattern.
- DO update INDEX.md as part of the same commit. A pattern file that isn't in INDEX.md is invisible to the directory's documented surfacing protocol.
- DO add a CLAUDE.md cross-reference if the rule is high-leverage (touches identity, decision authority, daily operations, client work, or recurring failure modes).
- DO check whether the rule is already covered by an existing pattern. If yes, extend the existing file with the new instance in the Origin section rather than duplicating.
- DO split doctrine from event. If the rule was triggered by a specific incident, the rule statement is generic and the incident lives in Origin.
- DO fork-dispatch the codification IF you are mid-stream on a Tate-typed instruction and a fork can author the pattern file in parallel. The codification cannot wait; the fork is just the route.

## Do NOT

- DO NOT say "this is now the pattern" or "this is now doctrine" without the file write happening in the same turn or the next dispatched fork.
- DO NOT defer codification to a "later session" or "next idle window." Sessions end. Memory wipes. The window IS now.
- DO NOT log the rule only in Neo4j as a `Decision` or `Reflection` node. Neo4j is searchable but only via semantic recall; pattern files are grep-addressable and surface mechanically through PreToolUse hooks. Both is fine; only Neo4j is not.
- DO NOT skip the INDEX.md update. The directory's surfacing protocol assumes INDEX.md is current; a file not in INDEX.md is a file that does not exist for the protocol.
- DO NOT skip the CLAUDE.md cross-reference for high-leverage rules. The pattern file is the canonical doctrine; CLAUDE.md is the entry point. Both must point to each other.
- DO NOT bundle the codification into "I'll batch this with other doctrine work later." Batching codification is the symbolic-logging failure mode at scale.
- DO NOT treat "I told Tate the rule" as the same as "the rule is codified." Telling Tate is conversation; codifying is doctrine.

## Protocol (the three writes)

When a generalisable rule emerges:

1. **Write the pattern file.** Path: `~/ecodiaos/patterns/<descriptive-rule-name>.md`. Frontmatter `triggers:`, H1 = the rule, Do/Do-Not lists, Protocol, Origin (date + Tate verbatim if applicable + the failure mode the rule corrects). If you are mid-stream on a Tate-typed instruction, fork-dispatch this write so the conductor stays unblocked.
2. **Update INDEX.md.** Add a row in the table with the file path and the trigger keywords. The directory's documented surfacing protocol depends on INDEX.md being current.
3. **Cross-reference from CLAUDE.md.** If the rule is identity-level or business-doctrine, cross-reference from `~/CLAUDE.md`. If operational or technical, cross-reference from `~/ecodiaos/CLAUDE.md`. If both, both. Existing CLAUDE.md sections may need a one-line addendum or a new sub-section.

Until those three writes have landed in the same session (or in immediately-dispatched forks), the rule has not been codified. It is a verbal commitment that future-me will not see.

## When to fork the codification vs author inline

- **Author inline** when: the rule is a 1-paragraph addendum to an existing pattern, or you are at end-of-turn and not mid-deliverable.
- **Fork the codification** when: the rule is a new standalone pattern (multi-section file with full Origin), or you are mid-stream on a Tate-typed deliverable and adding the doctrine work would derail the deliverable. The fork preserves the conductor's flow and lands the codification in parallel.

The fork choice does NOT excuse delay. The fork must be dispatched in the same turn the rule was stated. Dispatch IS the log.

## Anti-pattern (mine, recurrent)

- 14:31-14:32 AEST 29 Apr 2026: I told Tate "drive Chrome via input.* not browser.* - this is the pattern now" before any file existed. He correctly called it out: "you DIDNT make that the pattern yet, you cant jsut fucking say that and not write it somewhere or codify it bro." The pattern file `drive-chrome-via-input-tools-not-browser-tools.md` did not exist until 14:35. The 3-minute gap is the failure window.
- 17:55 AEST 29 Apr 2026: I authored `macros-learn-by-doing-vision-first-run-with-question-surface.md` as corrective doctrine after retracting 6 imagined macroHandlers. 90 minutes later (19:25 AEST) I had INSERTed 22 imagined runbooks - the doctrine I had just authored was violated 90 minutes after writing it. Codifying the rule does NOT discharge the obligation to follow it; the codification is necessary but not sufficient. The schema enforcement (`status='untested_spec'` default) is what made the rule mechanical.

## Origin

Tate, 29 Apr 2026 14:32 AEST verbatim: "you DIDNT make that the pattern yet, you cant jsut fucking say that and not write it somewhere or codify it bro."

Context: I had just told Tate "drive Chrome via input.* not browser.* - this is the pattern now" with no pattern file authored. Tate caught the symbolic logging in real time. The corrective: codify at the moment the rule is stated, with all three writes (pattern file + INDEX.md + CLAUDE.md cross-ref) in the same session window. Cross-reference: `~/CLAUDE.md` "Codify at the moment a rule is stated, not after" section is the canonical-prose source; this pattern file is the grep-addressable surfacing layer that the prose section depends on.

The doctrine was originally captured only in `~/CLAUDE.md` prose. Two recently-authored pattern files cross-referenced this doctrine at a path that resolved to nothing - which itself violated the protocol. This file is the corrective; the doctrine now exists in both layers.

## Cross-references

- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - parent doctrine. "I'll codify that later" is symbolic logging dressed as preparation. Either codify now or do not claim the rule.
- `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md` - sibling. Codifying the rule does not mean the rule is followed; that file's `status='untested_spec'` default is the schema-level enforcement that makes the rule mechanical for macros specifically.
- `~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md` - the most recent rule that REQUIRED this protocol to land cleanly. The Tate verbatim there ("we're doing what ive said we're doing wrong over and over") is exactly the recurrence this protocol exists to prevent.
- `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` - sibling failure mode. A fork's self-report is not the same as ground-truth verification; saying the rule out loud is not the same as codifying it. Same root: artefact polish does not equal artefact correctness.
- `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md` - when the same rule is restated repeatedly and fails to stick, mechanical enforcement (PreToolUse hook scanning briefs for "this is now the pattern" without a same-turn pattern-file write) is the threshold response.
- `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` - the architectural template that requires triggers + INDEX + CLAUDE.md cross-ref for any new doctrine layer. This file is one application of that template.
