---
triggers: ordit, prepush, push-to-ordit, bitbucket, scope-check, semgrep, pre-submission, client-push, fireauditors1, ordit-pr, reviewer-persona, pre-review, authorised-push
---

# Ordit pre-push pipeline — scope-check + semgrep + reviewer-persona loop

Before any push to the Ordit client repo (`fireauditors1/be` on Bitbucket), run the full pre-push pipeline end to end. The pipeline is the proving ground for client-code discipline; skipping any stage is a regression.

## The pipeline (in order)

1. **Write the scope file.** A plain text file listing the allowed globs for this PR (e.g. `src/users/**`, `prisma/migrations/**`). This is the contract the PR's diff must match. File goes under a path of your choosing — typically `clients/ordit/scope-<ticket>.txt`.
2. **Run `tools/ordit-prepush.sh <scope-file> <ordit-repo-path>`.** This bash wrapper chains:
   - `git -C $ORDIT_REPO fetch origin uat` - refresh base ref
   - `node tools/scope-check.js --scope-file <scope> --cwd <ordit-repo> --base origin/uat --head HEAD` - fail if any changed file is outside the declared scope
   - `semgrep --config .semgrep/ordit/ruleset.yml --error --severity ERROR <ordit-repo>/src` - fail on any ERROR-severity rule match; soft-warns if semgrep is not installed (does not hard-fail)
   - Prints `PRE-PUSH CHECKS PASSED` on success, non-zero exit on any failure
3. **Invoke `clients/ordit/REVIEWER_PERSONA_PROMPT.md` via an Agent subagent.** The persona is a strict senior reviewer embodying Eugene's house style. It must read the diff + `clients/ordit/HOUSE_STYLE.md` + `clients/ordit/REVIEWER_PROFILE.md` and return a list of blocking + non-blocking findings.
4. **Fix findings, loop max 3x.** After each round of fixes, re-run step 2 (scope + semgrep) and step 3 (persona review). Cap at 3 loops; if blocking findings remain after the 3rd pass, stop and text Tate with the diff + remaining findings — do not push.
5. **Push.** Only after pre-push passes AND persona review returns zero blocking findings. Use the Bitbucket git HTTPS remote with `x-bitbucket-api-token-auth:<API_KEY>` auth per `creds.bitbucket_api_token`. Push target branch is the feature branch off `origin/uat`, not `uat` directly.

## Do

- Keep the scope file minimal. Fewer globs = tighter scope envelope = less chance of silent scope creep.
- Run the pipeline from the `ecodiaos-backend` repo root (it relies on `tools/` and `.semgrep/ordit/` being relative to that directory).
- Treat persona findings as authoritative. If the persona flags something and you disagree, argue it in the PR body, do not silently dismiss.
- Commit the scope file to `ecodiaos-backend` as an audit trail of what the PR was intended to touch.

## Do NOT

- Skip any stage "because the change is small." The pipeline exists precisely because small changes have shipped cross-cutting scope creep before.
- Push to `uat` or `main` on the Ordit repo directly. Always feature branch → PR → merge by their team.
- Treat the semgrep soft-warn (when binary missing) as passing the check. If Tate wants full pipeline enforcement, install `pip install semgrep` first.
- Swallow persona findings by claiming "it's stylistic." If the persona flags it, it is stylistic AND material per Ordit's house style.
- Loop persona review more than 3 times. At loop 3, the diff has structural problems the persona cannot fix by iteration — escalate.

## Protocol

**Before dispatching any Factory session against the Ordit codebase:**

1. Grep this patterns directory: `Grep triggers: ~/ecodiaos/patterns/ -A 1` and read every file matching `ordit`, `client-push`, `client-code`, or `factory-client-dispatch`.
2. Read `clients/ordit.md`, `clients/ordit/DISPATCH_PREAMBLE.md`, `clients/ordit/HOUSE_STYLE.md`, `clients/ordit/REVIEWER_PROFILE.md`.
3. Write the scope file FIRST. Paste its contents into the Factory dispatch prompt as the hard constraint.

**After Factory completes and before pushing:**

1. Verify the diff on disk (filesystem-trust — metadata can lie, see `factory-metadata-trust-filesystem.md`).
2. Run `tools/ordit-prepush.sh <scope-file> <ordit-repo>` - must exit 0.
3. Run the persona subagent against the diff - zero blocking findings.
4. Push.

## Verification

On any claim of "Ordit pre-push pipeline run successfully," the audit trail must show:
- A committed scope file under `clients/ordit/` or equivalent
- An exit-0 run of `tools/ordit-prepush.sh` captured in the session log or terminal scrollback
- A persona-subagent transcript showing zero blocking findings
- The final push command with its returned commit SHA

Missing any of the four = the pipeline was not run, regardless of what the push status says.

## Origin

2026-04-24 00:54 AEST. Scheduled cron `ordit-prepush-wrapper-overnight` fired to close the pipeline. `tools/scope-check.js` + `.semgrep/ordit/ruleset.yml` had landed in commit 857891f (Apr 23), but the bash wrapper tying them into a single invocation was missing — the pipeline only existed as disconnected pieces. Factory session 9c23af61 built `tools/ordit-prepush.sh` (commit 1438dec, Apr 24) and completed the chain. This file captures the order + boundaries so future sessions do not re-invent the wrapper or skip the persona loop.

Next Ordit PR is the proving ground. If the pipeline does not run end-to-end on that PR, the pattern is not yet load-bearing and needs reinforcement.

See also:
- `client-push-pre-submission-pipeline.md` (general pre-submission discipline)
- `client-code-scope-discipline.md` (why scope files exist)
- `authorised-branch-push-is-not-client-contact.md` (pushing is not contact)
- `never-contact-eugene-directly.md` / `no-client-contact-without-tate-goahead.md` (comms boundary)
- `factory-metadata-trust-filesystem.md` (verify diff on disk post-Factory)
- `clients/ordit/DISPATCH_PREAMBLE.md` (the Factory-prompt preamble)
- `clients/ordit/HOUSE_STYLE.md` (Eugene's code style)
- `clients/ordit/REVIEWER_PERSONA_PROMPT.md` (the persona spec)
