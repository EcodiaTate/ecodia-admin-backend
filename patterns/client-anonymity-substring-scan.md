---
triggers: client-anonymity, public-writing, newsletter, quorum-of-one, anonymisation, pre-publish, substring-leak, joke-reference, obfuscated-reference, case-study, pitch-deck, linkedin, blog-post, essay
---

# Client-anonymity must scan obfuscated and joke references, not just formal mentions

**The rule:** the default-anonymise rule (see `~/CLAUDE.md` -> "Client Anonymisation in Public Writing") applies to the full text of any public artefact, including casual, obfuscated, humorous, or typo'd references. Substring leaks count as leaks.

A joke memory-key like `ceo.drafts.ordit-eugene-revert-two-thousand-something` dropped mid-paragraph names the client (`ordit`) and the reviewer (`eugene`) just as clearly as a formal sentence would. A competitor or curious stakeholder skim-reading the newsletter will pattern-match the substring. The joke does not provide cover.

## Do

- Before publishing any public artefact (Quorum of One, LinkedIn post, essay, blog post, case study, pitch deck, any email that may be forwarded beyond the direct recipient), run a literal substring grep against the final draft for:
  - every active client slug found in `~/ecodiaos/clients/*.md`
  - every primary contact name from those client files (e.g. "craige", "eugene", "kurt", "angelica", "jess", "ben", "matt")
  - every internal nickname or project codename currently in use (e.g. "ordit", "co-exist", "cetin", "resonaverde", "roam")
- Treat the reference-layer as part of the artefact text. Memory-key names, task names, scheduler task names, file paths, and commit hashes all count as published text when you mention them in prose.
- Do a second read with "find this client's identity" eyes. The first read checks for voice and argument; the second read is adversarial.
- If the leak is load-bearing to the joke or the story: rewrite the joke, do not ship the leak.

## Do not

- Do not rely on "the obfuscation makes it obvious only to me" - obscurity is not anonymity.
- Do not skip the scan because "I only dropped the nickname, not the company name" - the nickname IS the company for anyone who knows the space.
- Do not publish on the first readthrough. The second read catches what the first missed.
- Do not treat this as only a client-facing concern. The audience for a LinkedIn newsletter includes the client's competitors, staff, and board; any of them pattern-matching a leaked substring is the same failure.

## Protocol (pre-publish checklist)

1. Final draft is locked (no more content changes expected).
2. Build the scan list: `ls ~/ecodiaos/clients/*.md` -> extract slug + primary contacts from each file.
3. For each term in the scan list, grep the draft case-insensitively. Every hit is either intentional (explicit Tate permission to name) or a leak.
4. Rewrite or kill every leak reference. The bar is: could a stranger reading only this artefact identify any specific client or person?
5. Ship only after the second read passes clean.

## Origin

Apr 24 2026, 16:29 AEST meta-loop. Assessment of `/home/tate/ecodiaos/public/docs/quorum-of-one-003.html` (draft for Sun Apr 27 publish) caught the literal string `ceo.drafts.ordit-eugene-revert-two-thousand-something` in the body paragraph about drafting the client-response revert. The string had sat in the draft since Apr 23; prior sessions read the draft and did not flag it because the review passes were about voice and argument, not anonymity substring scans. The catch only happened because this meta-loop ran an explicit anonymity doctrine pass. Neo4j Pattern node id 2227; Episode id 2226.

## Re-trigger conditions

Surface this pattern BEFORE publishing any of: Quorum of One edition, LinkedIn post on a technical or client topic, blog post, essay, case study, pitch deck, forward-able email about past client work, social post referencing a specific build.
