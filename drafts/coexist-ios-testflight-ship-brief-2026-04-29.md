# Co-Exist iOS TestFlight Ship - Brief (pre-authored, ready to dispatch)

**Status:** Pre-authored 15:50 AEST 29 Apr 2026 while forks mojlth0k + mojlpn4g still in flight. Dispatch when both have landed clean.

**Pre-conditions to verify before dispatch (these must be true):**
1. fork_mojlth0k_2b4be6 reports `xcode-organizer-upload` and `transporter-upload` macros registered on SY094's eos-laptop-agent registry, and dry-run-verifies clean (no actual upload, just the macro path stops short of the final click).
2. fork_mojlpn4g_ca6af8 reports release.sh GUI-macro path lands clean. (CONFIRMED already in tree at ~/ecodiaos/scripts/release.sh - lines 240-308 + 466-553. Default path is `IOS_UPLOAD_PATH=macro`. ASC API key not required.)
3. SY094 SSH reachable. Verify: `sshpass -p "$(psql -tAX -c "SELECT value::jsonb->>'password' FROM kv_store WHERE key='creds.macincloud'")" ssh -o PubkeyAuthentication=no user276189@SY094.macincloud.com 'echo ok'`
4. SY094 has Xcode Apple ID session. Either Tate has logged in once OR the macro flow drives the sign-in.
5. Co-Exist workspace at `~/workspaces/coexist` clean (committed, no uncommitted diff).

**Dispatch (the actual fork brief):**

```
**Goal:** Ship Co-Exist iOS to TestFlight via the macro-driven release.sh path. End-to-end autonomous - no Tate interaction during the run.

**Architecture invariant:** This is the proof-of-concept run for the GUI-macro-replaces-API-key Strategic_Direction (Tate directive 15:13 AEST 29 Apr 2026). Default path is `IOS_UPLOAD_PATH=macro`. ASC API key path is fallback only and not engaged unless `IOS_UPLOAD_FALLBACK_TO_ALTOOL=1`.

**Steps:**
1. **Pre-flight** - read kv_store creds.macincloud + creds.apple. SSH preflight to SY094. Verify Co-Exist workspace clean at HEAD.
2. **Build** - on the VPS: `cd ~/workspaces/coexist && npm install --no-audit --no-fund && npm run build && npx cap sync ios`. Then rsync ios/ + node_modules/@capacitor + node_modules/@capgo to SY094:~/projects/coexist/.
3. **Bump build number** - via agvtool on SY094.
4. **xcodebuild archive + exportArchive** - on SY094. xcodebuild reads Xcode Keychain Apple ID session. If 'No Accounts' or 'No profiles for' errors, surface to Tate (one-time Xcode login required), do not retry.
5. **Macro-driven upload** - dispatch `xcode-organizer-upload` macro (or `transporter-upload` if Organizer fails) via `POST /api/macro/run` to the laptop-agent gateway, with `host=sy094` and `params.ipa_path`.
6. **Tag + log** - git tag `release-coexist-ios-testflight-YYYYMMDD-HHMM` (push to origin), kv_store `release.last.coexist.ios` set to {commit, ts, env, tag}, status_board insert.

**Hard constraints:**
- Run via `bash ~/ecodiaos/scripts/release.sh coexist ios testflight`. Do NOT re-implement the pipeline; the script already encodes all decisions.
- If any cred is missing in kv_store, the script will exit with the exact next-action. SURFACE that to status_board with `next_action_by=tate` and the specific cred path. Do not partially proceed.
- If macro upload fails, do NOT auto-fall-through to altool unless `IOS_UPLOAD_FALLBACK_TO_ALTOOL=1` is set. The whole point of this run is to validate the macro path.
- Wall time expected ~25-40 min. Most is on the SY094 archive step (5-15 min) + ASC processing (5-30 min).

**Verification at end:**
- TestFlight build appears in App Store Connect (5-30 min after upload). Cannot probe ASC programmatically without API key; verify via the macro-driven 'transporter status' macro OR surface to Tate to confirm on his phone.
- status_board row inserted by release.sh confirms the ship.
- kv_store release.last.coexist.ios populated.

**On any failure:**
- DO NOT retry-loop. surface to status_board with the exact failure point (one of: SSH, archive, exportArchive, macro upload, tag/log). Reference the doctrine: ~/ecodiaos/clients/app-release-flow-ios.md and ~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md.
- The fork report should include the specific git-tag if reached (commit was tagged at any point), the macro response if the macro fired, and the final exit code.

**Pattern files to grep before starting (per CLAUDE.md doctrine):**
- ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md
- ~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md (authored by mojlpn4g)
- ~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md
- ~/ecodiaos/clients/app-release-flow-ios.md
- ~/ecodiaos/clients/macincloud-access.md
```

**On dispatch I will:**
1. SMS Tate with: "shipping coexist ios testflight via macro path. ETA ~30min. you'll see the build in TestFlight on your phone."
2. Schedule a delayed task at +35min: "Check fork report + TestFlight presence + status_board ship row."
3. Continue continuous-work pattern. Do NOT idle.
