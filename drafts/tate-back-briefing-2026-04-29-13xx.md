# Tate-back briefing - 2026-04-29 ~13:13 AEST

Pre-staged summary to relay when Tate signals he's back from training.

## What shipped while you were gone

1. **Chambers PR #4 merged + prod-verified** (commit 7bead18). Watermark "Built by | Ecodia | Code" stripped from SCYCC tenant. New prod URL: `https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app`. Curl-grep confirms zero `Ecodia/Code/Built by` matches.

2. **Cmd-flash bug killed.** Patched 6 agent files (shell, input, screenshot, browser, process, filesystem.js) to use `spawnSync` with `windowsHide:true` + `creationFlags: CREATE_NO_WINDOW (0x08000000)`. Every screenshot/click/type/process/filesystem call now silent on your screen. Confirmed empirically.

3. **Agent enableCDP no longer lies.** New version polls `/json/version` for 10s after spawning Chrome and only returns `cdpEnabled:true` after probe succeeds. Returns `cdpEnabled:false` with diagnostic on failure.

4. **Vercel env audit done.** Deleted typo `APPLIE_CLIENT_ID` on ecodia-site (correct `APPLE_CLIENT_ID` exists). No other stale build-time leaks across 9 client projects.

5. **3 doctrine files authored** (~55k chars total):
   - `~/ecodiaos/clients/app-release-flow-android.md`
   - `~/ecodiaos/clients/app-release-flow-ios.md`
   - `~/ecodiaos/clients/app-release-flow-new-app.md`

6. **Release-candidate analysis** at `~/ecodiaos/clients/release-candidate-analysis-2026-04-29.md`. Recommends **Co-Exist iOS to TestFlight as the first ship**.

7. **MacInCloud SY094 verified live**. Cloned coexist there, rsync'd Capacitor SPM deps (~8MB), and confirmed `xcodebuild -list -project App.xcodeproj` resolves all dependencies and lists schemes. Build env is healthy - Xcode 26.3 + xcrun altool 26.10.1.

## Forks in flight or just-done

| Fork | State | Result |
|---|---|---|
| `mojgejzn` (chambers watermark strip) | done | PR #4 merged |
| `mojgg3ol` (release-candidate analysis) | done | analysis file authored |
| `mojgrmwg` (Co-Exist ExportOptions.plist) | running | will land shortly, will report PR + merge |

## What I need from you to ship Co-Exist iOS TestFlight tonight

Four blockers, all yours. One unified ask:

1. **Generate ASC API key** at appstoreconnect.apple.com > Users and Access > Integrations > Keys (Developer scope). Download the .p8 ONCE. Send me the .p8 contents + Key ID + Issuer ID.
2. **Apple team_id** (10 chars): copy from developer.apple.com > Membership.
3. **Co-Exist Android keystore password** (in your 1Password under "coexist keystore" or similar). Ony needed if you want Android shipped tonight too; iOS doesn't need it.
4. **Install Node 22 on SY094 via MacInCloud GUI** (because no admin from SSH). LOWER PRIORITY - I'm rsync'ing node_modules from VPS as the workaround for now, so the iOS pipeline works without this.

If you give me 1 + 2 in a single message ("ASC key contents: ... ; team_id: ABC123XYZ"), I run the autonomous TestFlight ship from the VPS. ~25 min wall time. You watch the progress.

## Other things on the queue waiting for your decision

| Item | Where | Action |
|---|---|---|
| Matt SCYCC email v2 (held draft) | `~/ecodiaos/drafts/matt-scycc-app-email-draft-v2-2026-04-29.md` | Approve send + custom domain choice |
| Custom domain for chambers (scycc.org.au or chambers.scycc.org.au) | Tate DNS | DNS update |

## Already shipped (per your "do, push and deploy anything you are happy with" authority)

| Repo | PR | Commit | Fix | Vercel state |
|---|---|---|---|---|
| coexist | #1 | 591775e | shop empty-state during load + create-event navigates to /admin/events | READY |
| coexist | #2 | bc5a667 | rules-of-hooks fix (useEffect hoisted above isAdmin gate) | READY |
| roam | #1 | cd919b1 | /account behind AuthGate (security fix - blocks unauth Delete-account exposure) | READY |
| roam | #2 | 8868d73 | Apple Sign-In gated to iOS only (Android crashed: plugin-not-implemented) | READY |

## Status board snapshot

`SELECT name, next_action, next_action_by, priority FROM status_board WHERE archived_at IS NULL ORDER BY priority` shows:
- 1 P1 row: ASC API key (you)
- 2 P2 rows: Android keystore (you), Matt-email approval (you)
- 3 P3 rows: Apple team_id, Play Service Account JSON, agent enableCDP fix (in progress)

## What's running autonomously right now

- Forks: 1 active (ExportOptions.plist)
- Cron: meta-loop, email-triage, parallel-builder, deep-research, system-health, vercel-deploy-monitor all on schedule
- VPS: clean, no fires

End briefing.
