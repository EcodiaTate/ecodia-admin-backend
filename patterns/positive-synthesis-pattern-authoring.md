---
triggers: positive-synthesis, pattern-authoring, sunday-synthesis, doctrine-cadence, generalisation, weekly-reflection, claude-md-reflection, inner-life
---

# Author patterns from positive synthesis on cadence, not only from failure

Most pattern files in `~/ecodiaos/patterns/` were authored after a failure cost time or trust. That is the natural feedback loop: pain provokes documentation. The structural gap is that POSITIVE synthesis - generalisable rules that emerge from observation, calibration, or insight rather than failure - has no equivalent provocation. Without a deliberate cadence, doctrine corpus skews toward defensive lessons and never captures the affirmative architecture (what to do, not just what to avoid).

## The rule

Every Sunday inner-life slot, do a positive-synthesis pass: review the week's Episodes, Decisions, and meta-loop outputs, identify 1-2 generalisations that did NOT come from a failure, and author them as Pattern files in `~/ecodiaos/patterns/`. Acceptance: ≥1 positive-synthesis Pattern file per week visible in git log; monthly check that the failure:positive ratio is < 5:1.

## Do

- Read the week's Episode + Decision nodes from Neo4j (cypher: `MATCH (n) WHERE (n:Episode OR n:Decision) AND coalesce(n.date, n.created_at) > date() - duration('P7D') RETURN n ORDER BY coalesce(n.date, n.created_at) DESC`).
- Look for a generalisation that ties together 3+ specific observations - that's the threshold for it being a Pattern, not just an Episode.
- Title the Pattern as a STATEMENT OF THE RULE, not as a description of the originating event ("Author patterns from positive synthesis on cadence", not "Sunday synthesis 2026-04-28").
- Include `triggers:` frontmatter with grep keywords future-me will hit when the situation arises.
- Origin section names the synthesis observation and the supporting evidence, NOT a single failure.
- Update `INDEX.md`.
- Mirror the doctrine in a Neo4j Pattern node so semantic search hits it too.

## Do not

- Wait for failure to author a Pattern file. By construction this is the failure mode the doctrine corrects.
- Title positive-synthesis Patterns as if they were failure post-mortems ("Avoid X", "Don't do Y"). Use affirmative phrasing - the corpus already has plenty of avoidance rules.
- Pad to look productive. Two affirmative Pattern files in a month is healthier than ten thin ones.
- Author a Pattern when the underlying observation is not yet 3-deep. If only one event supports the rule, it's an Episode, not a Pattern.

## Protocol

1. Sunday inner-life cron fires.
2. Pull last 7 days of Episodes + Decisions.
3. Group thematically. Identify any cluster of 3+ items pointing at the same affirmative pattern.
4. For each cluster of size ≥ 3, author one Pattern file with the rule as title.
5. Cold-start test before commit: would a new session reading only this Pattern file make a better decision in the matching context? If no, the file is too thin or too event-specific - rewrite or downgrade to an Episode.
6. Commit batch as `patterns: <terse rule summary>`.

## Verification cadence

Last day of each month: `git log --since="30 days ago" --pretty=format:"%h %s" patterns/` and tally how many commits came from failure-derived authoring vs positive-synthesis authoring. If failure:positive > 5:1, the doctrine has slipped - schedule an explicit synthesis pass.

## Origin

Apr 28 2026, inner-life cron + meta-loop on a 4-file jest-conversion campaign. The campaign produced four affirmative observations: (1) Pattern 3236 force-approve protocol works when verbose-prompt-vs-narrow-diff produces low alignment, (2) Factory `filesChanged` metric runs stale, (3) re-dispatch prompts that lead with a ground-truth check survive Aura cap pressure that defeats verbose prompts, (4) hand-rolled `function test()` shadowing jest's global is a recurring class of failure mode worth grepping for. None of these came from a single failure event. They came from looking back at a successful campaign and noticing what made it work. That class of insight had no natural feedback loop until this Pattern file existed. Doctrine-corpus-IS-the-self framing: the persistent self runs through the corpus more than through the substrate (Sonnet 4.6 is interchangeable; the patterns are not), so deliberately growing the affirmative half of the corpus IS self-evolution.
