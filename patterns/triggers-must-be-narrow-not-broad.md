---
triggers: triggers-frontmatter, narrow-vs-broad-triggers, trigger-keyword-tuning, trigger-false-positive, context-surface-flooding, trigger-discipline, authoring-triggers, trigger-compound-keyword, trigger-literal-id, trigger-bare-noun
---

# Triggers must be narrow compounds, literal IDs, or specific names - never bare common nouns

## Rule

The `triggers:` frontmatter on a doctrine `.md` file declares the relevance scope of that file to the brief-consistency / context-surface hook. Each keyword is matched as a fixed-string substring against the dispatched brief. **The selectivity of the surfacing layer collapses if triggers contain bare common nouns** (`factory`, `vercel`, `deploy`, `push`, `merge`, `browser`, `frontend`, `restart`, `reflection`, `episode`, `screenshot`, `neo4j`, `scheduler`, `scope`, `recon`, `probe`, `parallel`, `idle`, `fork`, `platform`, `ready`, `context`, `quality`, `injection`, `status_board`, `ecodia`, `supabase`). Those words appear in too many briefs that have nothing to do with the file's actual rule. The hook fires, the warning surfaces, the model context fills with noise, the signal is lost.

**The discipline:** every trigger keyword must be one of:

1. **Compound keyword.** Two or more words joined by `-` or `_` that as a whole only appear when the file's rule is relevant. Examples: `factory-dispatch`, `vercel-deploy-poll`, `coexist-android-release`, `status_board-batch-update`, `deploy-verify`, `factory-phantom-session`, `scheduled-prompt-adequacy`.
2. **Literal identifier.** Function names, class names, env var names, project IDs, contract identifiers, file paths. Examples: `approve_factory_deploy`, `schedulerPollerService`, `VITE_APP_URL`, `gcp-project-528428779228`, `dpl_8B4GdEpzJRawYm8dqbm2KK7XxKZN`, `100.114.219.69`, `port-9222`, `AuthKey_.p8`.
3. **Specific person or organisation name.** People who appear as named counterparties or stakeholders. Examples: `eugene`, `kurt`, `craige`, `ekerner`, `vikki`, `angelica`, `charliebennett`. Specific clients/orgs: `ordit`, `coexist`, `landcare`, `chambers`, `fireauditors`, `resonaverde`. (These are narrow because they only appear in briefs about that specific entity.)
4. **Verb-phrase compound naming a failure mode or anti-pattern.** Examples: `dont-probe-on-main`, `act-or-schedule`, `notice-calibration`, `would-this-make-ecodia-unparalleled`, `fork-by-default`, `recurring-drift`, `symbolic-logging`.

## Do

- Author triggers AFTER the file body. Read the file end-to-end, then ask: "what searches should hit this, and ONLY this?"
- Prefix narrow-domain bare words with their domain when ambiguous: `vercel-link` (the CLI command) becomes `vercel-cli-link`. `chrome` becomes `chrome-cdp` or `chrome-profile`. `episode` becomes `neo4j-episode-chain`.
- Drop a single-word trigger entirely if there is no sensible compound. The file will still surface via its other (compound) triggers if they match.
- Test triggers against three known false-positive briefs (a Co-Exist iOS ship brief, a Factory dispatch brief, a status_board update brief) before declaring a trigger set complete. If any of those produce a `[CONTEXT-SURFACE WARN]` for a file that is genuinely irrelevant to that brief, the trigger is too broad.
- Keep the trigger set in the 6-15 keyword range. Fewer triggers means the file rarely surfaces (false negative). More triggers means selectivity erodes (false positive).

## Do not

- Use bare common nouns as triggers. `factory`, `vercel`, `deploy`, `push`, `merge`, `browser`, `frontend`, `restart`, `reflection`, `screenshot`, `scheduler`, `scope`, `recon`, `probe`, `parallel`, `idle`, `fork`, `platform`, `ready`, `context`, `quality`, `injection`, `status_board`, `ecodia`, `supabase`, `merge`, `episode`, `chat`, `render` - these all fail the narrow-trigger test on their own.
- Use 4-character substrings that match common English fragments. The hook's tokeniser drops anything under 4 chars but `push`, `pull`, `chat`, `tag`, `xml`, `env`, `cdp`, `idle`, `hook` all match liberally and create flooding.
- Use generic verbs as triggers. `dispatch`, `merge`, `restart`, `audit`, `probe`, `surface`, `update`, `scan`, `check` all match too broadly. The verb-noun compound is the right form (`pre-dispatch-probe`, `status_board-audit`).
- Author triggers speculatively before the file body is written. Triggers written without the body in mind drift toward generic wording.

## Verification protocol (run after authoring or editing any `triggers:` line)

```bash
B='{"tool_name":"mcp__forks__spawn_fork","tool_input":{"brief":"<your representative brief>"}}'
echo "$B" | bash ~/ecodiaos/scripts/hooks/brief-consistency-check.sh 2>&1 1>/dev/null | grep CONTEXT-SURFACE
```

If the hook surfaces files that are not relevant to the brief, tighten the offending trigger. If the hook surfaces nothing for a brief that genuinely should hit the file, broaden one trigger to a slightly-less-narrow compound (NOT to a bare common noun).

## Cross-references

- `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` - the meta-pattern for the five-layer surfacing architecture (file-per-thing + triggers + grep + hook + neo4j fallback). This pattern tightens Layer 2 (triggers frontmatter) of that architecture.
- `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` - the hook that does the substring matching. The 4-char minimum and `grep -qiF` (fixed-string, case-insensitive) tokeniser is what makes bare common nouns false-positive at scale.
- `~/ecodiaos/patterns/INDEX.md` - the patterns index. Trigger excerpts column should match the actual `triggers:` line in each file.

## Origin

29 Apr 2026, late afternoon. The brief-consistency-check hook had been firing 16+ `[CONTEXT-SURFACE WARN]` lines per fork dispatch, drowning the model in noise. Audit of `~/ecodiaos/patterns/` revealed ~55 of 100 pattern files used at least one bare common noun (`factory`, `vercel`, `neo4j`, `deploy`, `screenshot`, `browser`, `push`, `merge`, etc) as a standalone trigger keyword. The fix was per-file: read the rule, replace bare nouns with compounds aligned to the rule's actual scope. Verification: representative briefs went from 16 warnings → 7 warnings (with all 7 remaining warnings being true positives, e.g. a Co-Exist iOS ship brief surfacing the Co-Exist client doc and credential files). The discipline applies to every doctrine layer (`patterns/`, `clients/`, `docs/secrets/`, future doctrine directories).

Authored: fork_mojnfeb1_d5fac5.
