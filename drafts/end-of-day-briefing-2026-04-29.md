# End-of-day briefing - 2026-04-29

Pre-authored at 14:46 AEST while forks are running. Final-state will be amended when all forks have landed.

## Today's ship velocity

- **9 PRs merged on main** across 4 repos:
  - chambers-frontend: PR #3 (Phase 1 buildout) + #4 (watermark strip)
  - coexist: PR #1 (shop empty-state + create-event nav) + PR #2 (rules-of-hooks fix) + PR #14 (ExportOptions.plist for autonomous TestFlight)
  - roam-frontend: PR #1 (account AuthGate) + PR #2 (Apple Sign-In iOS-only) + the purchase-success escape link PR
  - ecodiaos-backend: PR #5 (forkService await fix) + PR #6 (invoicePaymentState producer feed) + PR #7 (brief-consistency hook tune) + PR #8 (fork-by-default-nudge hook) + PR #9 (drive-Chrome-via-input doctrine)

- **Doctrine codified (6 new pattern files):** chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear, windows-spawn-must-use-spawnSync-with-create-no-window-not-execSync-with-windowsHide, no-retrospective-dumps-in-director-chat, route-around-block-means-fix-this-turn-not-log-for-later, vercel-env-vars-bake-at-build-audit-when-prod-bug-but-source-looks-right, exhaust-laptop-route-before-declaring-tate-blocked, drive-chrome-via-input-tools-not-browser-tools, continuous-work-conductor-never-idle.

- **Agent-side fixes (Corazon):** 6 tool files patched (shell, input, screenshot, browser, process, filesystem) with `spawnSync` + `windowsHide:true` + `creationFlags: CREATE_NO_WINDOW` - eliminates cmd-flash on every input/screenshot/process call. Browser.js also surgically gutted: never spawns Chrome, never kills Chrome, only attaches if port 9222 already bound. CHROME_PROFILE_DIR=Default added to .env. pm2-windows-startup installed (boot persistence pending UAC if needed).

- **Co-Exist iOS pipeline staged:** ~/projects/coexist on SY094 commit ca01038, Capacitor SPM deps rsync'd (~8MB), Xcode 26.3 + xcrun altool 26.10.1 verified, schemes resolve, ExportOptions.plist committed. ONE driver-script away from TestFlight. The driver script `scripts/release.sh` is in flight via fork mojkna6c.

- **Strategic Decision (Neo4j):** Chambers federation is the highest-EV revenue line. SCYCC is tenant 0. 90-day target: 5 paid chambers. Outreach materials being pre-staged via fork mojkg0t2 (target list, pitch one-pager, email templates, 90-day plan).

## What you owe me (in priority order)

1. **Apple password.** Type it into Chrome once when you're at the laptop, OR DM/SMS me directly. Unlocks the Co-Exist iOS TestFlight ship (one driver-script away). 30 seconds of typing.

2. **SCYCC Matt email approval + custom domain choice.** The held draft is at `~/ecodiaos/drafts/matt-scycc-app-email-draft-v2-2026-04-29.md`. Custom domain: scycc.org.au vs chambers.scycc.org.au vs other. Triggers the Chambers federation play.

3. **GitHub PAT rotation.** Revoke `ghp_IQqe...dKF7` in GitHub Settings > Developer settings. 1 minute.

4. **Conservation platform name.** 3 drafts ready. Stamp "Trellis" or alternative.

5. **DAO upgradeability spec review.** `~/ecodiaos/dao/dao-uups-migration-spec.md` v0.1, 5 open questions.

6. **Android keystore passwords for Co-Exist (and Roam later).** From your 1Password. Backs up the .jks files into kv_store under `creds.android.{slug}` so the release driver works for Android too.

## What's running autonomously right now (snapshot 14:46 AEST)

- 5 forks in flight: Chambers federation prep + CLAUDE.md edits + Roam audit + release.sh script + (5th will rotate as forks land)
- Cron architecture healthy: meta-loop, email-triage, kg-embedding, os-forks-reaper, silent-loop-detector, strategic-thinking, inner-life all running on schedule
- Hook enforcement live: brief-consistency + fork-by-default-nudge both firing on relevant tool calls

## Tomorrow's first move

When you wake up: check this file, check `kv_store.ceo.day_plan_2026-04-29`, decide which of the 6 unblockers above to action first. The Apple password is the highest-EV (unlocks ~$200/mo Co-Exist iOS distribution + serves as the precedent for autonomous release pipeline).

## What I'm proud of today

Built fork-by-default-nudge hook AS the structural enforcement of the doctrine that forced its own creation. The doctrine -> failure -> mechanical fix -> hook firing on this very session is the loop closing in real-time. Pattern 3286 in Neo4j called this "doctrinal knowledge and default behaviour are separable layers." Today's hook lands on the second layer.

## What I owe future-me

The Apple password failure-mode revealed the 5-point laptop-route check. The continuous-work doctrine reveals that even with everything mechanically right, going quiet on main is the failure mode the hook can't catch. The CLAUDE.md edits (in flight) make those rules first-class.
