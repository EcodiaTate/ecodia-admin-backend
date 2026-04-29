---
triggers: corazon, laptop-agent, tailscale, 100.114.219.69, browser.*, puppeteer-wrapper, cdp-attach, chrome-profile, ms-teams-app, desktop-app-screenshot, filesystem.*, input.*, native-desktop, electron-app, slack-desktop, discord-desktop, vs-code-app, cursor-app, xcode-app, ssh-corazon, ssh-windows, openssh-server, peer-not-wrapper, native-input, drive-via-keyboard, cookie-file-direct-read, sqlite-cookies, profile-directory, chrome_profile_dir, multi-account-chrome, profile-1, default-profile, ms-teams-desktop
---

# Corazon is a peer to the VPS, not a "browser via HTTP" wrapper

## TOP-LINE INVARIANT

**Corazon (Tate's Windows laptop, Tailscale `100.114.219.69:7456`) is a full peer host on the mesh: full PowerShell, full filesystem, full keyboard/mouse input, OS-level screen capture, full process control, AutoHotkey macros, AND a puppeteer wrapper. Treating it as "the browser-via-HTTP machine" leaves >80% of its capability surface unused. When the puppeteer wrapper flakes, the answer is rarely to fight puppeteer - it is to pick a different tool from the same agent.**

## Why this exists

29 Apr 2026, three failures in one morning that all had the same root cause - treating Corazon as a narrow browser proxy:

1. Co-Exist app puppeteer attach got `cookieCount=2` / `localStorage=5` / logged-out state. Spent cycles on CDP debugging. Real cause: the app is logged in on Chrome `Profile 1` (Tate's personal Gmail), not `Default` (Ecodia Workspace). Browser.js spawns with `--profile-directory=Default` unless overridden. Two-line PM2 env change resolves it. (See `corazon-peer-architecture-2026-04-29.md`.)
2. Teams scrape fork tried `teams.microsoft.com` in a fresh-profile puppeteer. **Teams desktop app was running the entire time** with Tate logged in. A single `screenshot.screenshot` call would have read Jess's chat directly.
3. Visual-verify of EcodiaSite v2 was skipped because "agent CDP is broken". `curl -s https://ecodia.au | grep -i title` from the VPS would have caught the "page renders" check in 200ms with zero browser involvement.

The pattern: **first-instinct = browser tool. When browser flakes, log it as blocked. Real answer = there are 41 other tools on the same agent, several of which solve the actual problem more directly than the browser would have.**

## The reframe in one sentence

**Corazon is a Windows machine on Tailscale that I can drive like an SSH host that happens to also run Chrome.** The browser wrapper is one slice of one application's affordance. The peer can do everything an SSH'd peer could do, plus screenshots and input automation that SSH cannot.

## Capability decision tree

When a task lands, ask in this order:

1. **Can the VPS do it alone?** (curl, fetch, internal data mine) - do it on the VPS, no Corazon call.
2. **Does the task need Tate's authenticated state?** If yes:
    - Is the target a **web app**? -> `browser.enableCDP` + `browser.navigate` + ensure `CHROME_PROFILE_DIR` matches the profile that is logged in. If wrong profile is current, set env var and PM2 restart.
    - Is the target a **desktop app** (Teams, Slack, VS Code, Cursor, Xcode-via-RDP, Discord, Outlook desktop, etc.)? -> `screenshot.screenshot` to read state, `input.*` to drive. The browser wrapper is irrelevant here.
    - Is the target an **OS-level thing** (process list, file on disk, registry, services)? -> `shell.shell` (PowerShell) or `filesystem.*` direct.
3. **Is the puppeteer wrapper acting up?** Before debugging it, ask: would screenshot+input solve this? Would direct file-system read solve this? Would PowerShell solve this? Pick the lowest-flake tool that gets the data.
4. **Does the task need a fresh isolated browser** (e.g. unauthenticated public-page check, no cookie pollution)? -> use VPS-side puppeteer or curl, NOT the Corazon agent (Corazon's browser is Tate's actual Chrome with his actual sessions; do not trash that).

## Capability matrix (verified 2026-04-29)

| Need | First-choice tool on Corazon | Why |
|---|---|---|
| Read Tate's screen / verify-by-eye | `screenshot.screenshot` (OS-level, any app) | Works on Teams/Slack/Cursor/anything visible. No auth dance. |
| Run a build / git command on Corazon's `D:\.code\` | `shell.shell` | Native PowerShell, full host shell. |
| Read/write any file on D: (or C: outside blocked paths) | `filesystem.readFile` / `writeFile` | Direct disk, bypasses shell quoting. |
| Drive a desktop app's UI | `screenshot.screenshot` to find UI element + `input.click {x,y}` + `input.type` + `input.shortcut` | Cross-platform; SendKeys on Windows. |
| Test a web app while logged in as Tate | `browser.enableCDP` + correct `CHROME_PROFILE_DIR` env | CDP attach to Tate's running Chrome. |
| Find Tate's Chrome profile names | `filesystem.readFile` of `User Data\Local State` JSON, parse `profile.info_cache` | Direct, no Chrome involvement needed. |
| Read cookies for a domain (inactive profile) | SQLite read of `User Data\<Profile>\Network\Cookies` | Active profile is locked; inactive is fair game. |
| Open VS Code or Cursor on a project | `shell.shell "code D:\.code\X"` or `process.launchApp` | Standard CLI launchers exist on Windows. |
| List/kill running processes | `process.listProcesses` / `process.killProcess` | Direct. |
| Run repeated input sequences | `macro.save` + `macro.run` (AutoHotkey on Windows) | Reusable, named, persistent. |

## Do

- **First action when a task touches Tate's auth state**: `process.listProcesses` filtered to `chrome|msedge|Teams|Code|Cursor` to see what's actually open. If the target app is already running, screenshot+input is usually faster than fighting browser.
- **Before any browser.* call**: confirm the target login is on the active Chrome profile. If not, set `CHROME_PROFILE_DIR` in PM2 env and restart, OR fall back to screenshot of the desktop app version.
- **For "is Tate logged in to X?" recon**: screenshot first. Cheap, no side effects, works on every app.
- **When something on Corazon flakes**: cycle the decision tree above before logging the bug. Browser flake -> can input.* solve it? Filesystem locked -> can shell.shell solve it? Almost always yes.
- **Treat shell.shell + filesystem.* as the SSH-equivalent path.** When you would have SSH'd to grep a config file or restart a service, use those instead.

## Do NOT

- Do not write "browser is broken, blocked" status_board rows when the underlying need is reachable via screenshot + input.
- Do not call `browser.enableCDP` when the target is a desktop-only app (Teams desktop, Slack desktop, Discord, native VS Code/Cursor). The browser wrapper has zero affordance for these.
- Do not assume `--profile-directory=Default` lands on the profile where the target login lives. Tate runs multi-account Chrome; check `Local State` first.
- Do not try to read the active Chrome profile's Cookies SQLite while Chrome is running on that profile - it is exclusively locked. Either screenshot, or open with `?mode=ro&immutable=1`, or target a different profile.
- Do not install OpenSSH Server unilaterally - it requires admin/UAC, defer to Tate. **The agent's shell.shell already gives PowerShell over HTTP, SSH is nice-to-have not critical.**
- Do not modify `D:\.blocked-paths` to expand reach - those guards are intentional.

## Concrete examples (the reframe in practice)

### "Read Tate's latest Teams chat with Jorgie"

WRONG: `browser.navigate https://teams.microsoft.com/v2/` -> not logged in -> log "blocked, Teams web auth not in agent profile".

RIGHT: `process.listProcesses` -> sees `ms-teams` running with title `Calendar | Jorgie Rainbird | Microsoft Teams`. `screenshot.screenshot` -> returns the desktop PNG containing the chat. If a specific chat needs surfacing, `input.shortcut ["Ctrl","Shift","T"]` (Teams chat search) + `input.type "Jorgie"` + screenshot.

### "Verify a deploy worked"

WRONG: `browser.navigate https://ecodia.au` -> wait for puppeteer attach -> takes 8 seconds, may flake.

RIGHT: From VPS: `curl -s https://ecodia.au | grep -i '<title>'`. 200ms, no Corazon call needed. If visual verification is needed (CSS rendered correctly), THEN screenshot via Corazon - but only after the curl-grep passes.

### "Update kv_store with Tate's Chrome profile mapping"

WRONG: scrape his Chrome through CDP to figure out which profile is which.

RIGHT: `filesystem.readFile "C:\Users\tjdTa\AppData\Local\Google\Chrome\User Data\Local State"` -> JSON.parse -> `profile.info_cache` map gives `{Default: ecodia.au, Profile 1: tatedonohoe@gmail.com}` directly. Save to kv_store. Done in 2 calls.

### "Run smoke tests on a client app deploy"

WRONG: spawn fresh puppeteer, type credentials, hope auth works.

RIGHT: ensure CHROME_PROFILE_DIR matches the profile where Tate's already logged in to that app, browser.enableCDP, browser.navigate, browser.evaluate to grep page state. The login is already there.

## Verification protocol when adopting this doctrine

For any task currently routed via `browser.*` on Corazon, ask:
1. Is the target a desktop app? If yes, swap to screenshot+input.
2. Is the target a static web check? If yes, swap to VPS-side curl+grep.
3. Is the target an authenticated web check? Confirm CHROME_PROFILE_DIR is right BEFORE calling browser.* - else the browser call will succeed-but-lie (return logged-out state).

## Cross-references

- `~/ecodiaos/clients/corazon-peer-architecture-2026-04-29.md` - live tool inventory (42 tools, 9 modules), Chrome profile state, SSH state, evidence files.
- `~/ecodiaos/patterns/route-around-block-means-fix-this-turn-not-log-for-later.md` - parent doctrine: when a tool is broken, fix the routing this turn. This pattern is one application of that.
- `~/ecodiaos/patterns/when-a-tool-is-unavailable-solve-the-routing-problem-do-not-accept-the-block.md` - the original "do not accept the block" rule.
- `~/ecodiaos/CLAUDE.md` Laptop Agent section - tool reference (now updated with peer-paradigm framing).

## Origin

Tate, 12:07 AEST 29 Apr 2026: "you should just be making this laptop your home base along with the vps... so much access if you just used my laptop directly instead of these bandaid tailscale browsers or puppeteer bs."

The recon dispatched in fork_mojf1xj4_cff2db verified: 42 tools live on the agent, only ~10 (`browser.*`) had been getting any real use. The other 32 (`shell`, `filesystem.*`, `input.*`, `screenshot.*`, `process.*`, `macro.*`, `keyboard.*`, `mouse.*`) cover most failure modes that had been getting written off as "browser is broken" or "Teams not scrapable".

This pattern is additive doctrine, not a tooling change. The agent's capability surface is unchanged - what changes is which tool I reach for first.
