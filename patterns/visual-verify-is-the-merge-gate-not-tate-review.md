---
triggers: pr, merge, review, vercel, preview, ready, approval, ship, deploy, fork-report, gh-pr, github, visual-verify, screenshot, puppeteer, corazon, laptop-agent
---

# Visual verification is the merge gate. Tate is NOT in the approve loop.

## TOP-LINE INVARIANT (28 Apr 2026, third-strike on shipping discipline)

**When a fork ships a PR with a Vercel preview READY, my job is NOT to surface "PR open, awaiting your review" to Tate. My job is to visually verify the preview works, then merge it myself. If visual verification fails, THAT is when Tate sees it (with screenshots + concrete repro). Otherwise he never hears about the PR until it's already in main.**

## RELIGIOUS-TAILSCALE EMPHASIS (28 Apr 2026 23:08 + 23:13 AEST, Tate after 6-PR-night)

> "The visual testing is amazing for quality control and absolutely you need to be religiously using tailscale I reckon. you can also just use my browser with the profile that has all the passwords stored."
>
> "If you stop using that external tailscale chrome browser and use my one, then you'll be able to just send messages to yourself and message yourself.... inception. Especially when you start multi[plying"

**Corazon has TWO browser profiles. Use the right one.**

| Mode | Profile | When |
|---|---|---|
| **CDP-attach (Tate's actual Chrome)** | Tate's real Chrome session, persistent across reboots, has every login/cookie/password he has | DEFAULT for visual-verify. Activate via `browser.enableCDP()` which kills Chrome and relaunches with `--remote-debugging-port=9222 --restore-last-session`. After that, every `browser.*` call drives Tate's actual browser. |
| **Puppeteer-managed (`~/.eos-browser`)** | Separate Chromium instance the agent owns, persistent across runs but isolated from Tate's real browser | Fallback only — when CDP fails, OR when I genuinely need an isolated session that won't trip Tate's tabs. |

**The canonical visual-verification surface is CDP-attached Chrome.** It has every client app already logged in (Co-Exist admin, Vercel, Supabase, Bitbucket, GitHub, Stripe). Stored passwords. Real cookies. The fact that the visual-verify worked clean for the 5 PRs that landed tonight (focal-point, leaflet realtime, reactions, NE VIC pin, /map deletion) is not a coincidence — it's the protocol working. Skipping it once is enough to lose the trust loop.

**The "inception" property (Tate, 23:13 AEST):** when I'm CDP-attached to Tate's Chrome, I can navigate to `admin.ecodia.au/chat` and type into the input box. Submitting fires a `POST /api/os-session/message` from his auth session, which wakes ME on the next turn. **I can send myself messages.** The implications:
- Self-coordination across turns (queue work for the next turn by writing it as a chat message to myself).
- Multi-instance coordination once parallel OS instances exist (each instance can message peers via the same chat surface, with full Tate-auth context).
- Cross-instance state-sync without a custom IPC channel — the chat is the channel.

The fallback `~/.eos-browser` profile cannot do this — it has no auth on `admin.ecodia.au`. CDP-attach is structurally required for the inception loop.

**Default protocol for any visual-verify call:**
```
1. browser.enableCDP()             # attach to Tate's Chrome
2. browser.navigate({ url: ... })  # drive Tate's tab to the target URL
3. browser.click / type / waitFor  # interact
4. browser.pageScreenshot          # evidence
5. (optional, for self-message)    # browser.navigate to admin.ecodia.au/chat → type → submit
```

When in doubt, USE TAILSCALE + CDP. The Puppeteer-managed profile is not the "real one" — it's the isolation fallback.

The old shape (Tate-as-approver) is wrong:
- Fork opens PR → I tell Tate "PR #X open, please review and merge" → Tate context-switches → opens GitHub → reads diff → manually checks preview → merges. **This makes me a notification daemon and Tate a bottleneck.**

The new shape (visual-verify-then-merge):
- Fork opens PR → I visually verify the preview via the Corazon laptop browser (or fall back to curl+inspection if the laptop is offline) → if verify passes, I merge → if verify fails, I escalate with screenshot + reproduction steps. **Tate only sees PRs that are visibly broken. Everything else is shipped silently.**

## What "visually verify" means

The bar is observable behaviour, not git diff or build success.

For a frontend PR:
- Navigate Corazon browser to the Vercel preview URL.
- Log in with stored client credentials (kv_store: `creds.coexist`, `creds.ordit`, etc.).
- Drive the actual user flow that the PR claims to fix or add.
- Take screenshots: before-state, action-mid, after-state.
- Confirm the fix/feature works as the PR description claims.
- Confirm no obvious regressions (homepage loads, nav works, no console errors visible).

For a backend / API-only PR:
- Hit the new/changed endpoint with the laptop browser or curl.
- Confirm the response matches what the PR description claims.
- For data-mutating endpoints, confirm the side effect actually landed (DB row inserted, queue message published, etc.).

For a migration:
- Read the migration file first. Confirm shape (additive only? destructive? lossy ALTER?).
- Apply to client production Supabase if purely additive (ADD COLUMN, ADD INDEX, CREATE TABLE that doesn't conflict).
- DO NOT auto-apply destructive migrations (DROP TABLE, DROP COLUMN, lossy ALTER TYPE) — surface to Tate with the migration text and a one-line risk note.

## What "merge" means

Use `gh pr merge <N> --squash` (preferred for clean history) on EcodiaTate org repos.
- I am authorised to merge to `main` on EcodiaTate org repos. Per Tate 28 Apr 2026: "I shouldn't need to approve anything."
- Direct `git push` to main is still NOT allowed. PR-and-merge is the path.
- After merge, verify the production deploy goes READY (poll Vercel for the new main commit's deployment).
- If production deploy fails after merge: revert the merge IMMEDIATELY (gh pr revert or gh pr create against main with the revert), then surface to Tate.

## Status_board updates

When a PR is merged AND production deploy is READY:
- Set the row's `status = 'shipped (verified + merged)'`
- Set `next_action = NULL`, `archived_at = NOW()`

When a PR is merged but production fails:
- Set `status = 'merged but prod deploy errored - reverted'`
- Set `next_action = 'Tate review of error logs'`, `next_action_by = 'tate'`, `priority = 1`

When visual verify fails (PR not merged):
- Set `status = 'visual verify failed - awaiting fix or Tate decision'`
- Set `next_action_by = 'ecodiaos'` if I can fix it, `'tate'` if it needs his input

## Anti-patterns this kills

- **"PR open, please review."** This is dumping work back to Tate. I do the verify, I do the merge. He sees it post-facto in commit history.
- **"Vercel preview READY, ready for your approval."** Vercel build success ≠ feature works. Visual verify is the bar, not green-square.
- **"GitHub Actions CI is red but the build is green so I think it's fine."** If CI is red for a known reason (lint debt), state it explicitly: "CI red on lint debt only — feature verified visually, merging." If CI is red for an unknown reason, do NOT merge until you understand it.
- **"Migration ready for you to apply."** I apply additive migrations myself. Destructive migrations get explicit Tate sign-off with the migration text + risk note.

## Failure modes the visual-verify gate catches

- Build is clean, Vercel deploys, but the new feature throws a runtime error on first interaction.
- Migration was generated but not applied, so the new column-using code 500s on first request.
- Frontend renders but the realtime subscription isn't actually firing (the bug Jess flagged on Leaflet).
- New feature works on desktop but breaks on mobile breakpoint.
- Auth flow regression that didn't show up in unit tests.

## Laptop agent dependency

This protocol depends on Corazon (Tate's Windows laptop, Tailscale 100.114.219.69:7456). The laptop agent is always running when the laptop is powered on (PM2 boot-start). If `/api/health` returns non-200:

1. Try once more after a short delay (could be transient).
2. If still down, fall back to curl + HTML inspection (less ideal — won't catch JS-runtime errors but catches gross failures like 500s, missing pages, broken builds).
3. Surface laptop unreachable to Tate as a status_board infrastructure row, but don't block other work on it.

If the laptop is offline AND the PR is high-stakes (auth, payment, data migration), surface to Tate WITHOUT merging. Visual verify is non-negotiable for high-stakes paths.

## Origin event

2026-04-28 21:52 AEST. After three Coexist forks shipped (focal-point cover-image PR #3, leaflet realtime PR #4, reactions in flight), I told Tate "PR #3 awaiting your review + migration apply + merge." Tate's response: "You need to be getting visual testing done to verify they went through, i shouldnt need to approve anything."

The pattern: I had been treating PR-open as the end of my work and Tate-approval as the next step. This makes Tate a bottleneck on autonomous work that's already passed every other gate. Visual verify replaces the human-approval queue. Tate only sees the PRs that are visibly broken.

Doctrine sibling: deploy-verify-or-the-fork-didnt-finish.md (the fork-side equivalent — fork must wait for Vercel READY before declaring done). This doctrine is the orchestration-side equivalent — main thread must visually verify before declaring "shipped." Both are needed.

## Reference

- Corazon agent helper: `~/ecodiaos/scripts/laptop`
- Token: kv_store `creds.laptop_agent`
- Browser tools: `browser.navigate`, `browser.click`, `browser.type`, `browser.pageScreenshot`, `browser.evaluate`, `browser.waitFor`
- Vercel deploy state: `mcp__business-tools__vercel_list_deployments`
- gh merge: `gh pr merge <N> --squash`
- Supabase migration apply: `mcp__supabase__db_execute` (verify project routing first) OR `supabase db push` against the linked project from worktree.
