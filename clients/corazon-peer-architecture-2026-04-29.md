---
triggers: corazon, 100.114.219.69, eos-laptop-agent, tjdTa, chrome-default-profile, chrome-profile-1, CHROME_PROFILE_DIR, .blocked-paths, openssh-server-windows, port-7456-corazon, screenshot.screenshot, input.cursorPosition, browser.enableCDP, D:\PRIVATE, multi-account-chrome-corazon, corazon-tool-inventory
---

# Corazon Peer Architecture - Recon (2026-04-29, fork_mojf1xj4_cff2db)

Tate's Windows laptop "Corazon" on Tailscale `100.114.219.69:7456` is a TRUE peer to the VPS, not a "browser via HTTP" wrapper. This file is the live tool-surface inventory that the doctrine `corazon-is-a-peer-not-a-browser-via-http.md` references.

## Live tool surface (42 tools, 9 modules)

Source of truth: `curl -H "Authorization: Bearer $TOK" http://100.114.219.69:7456/api/info | jq .tools` (run 2026-04-29 02:09 UTC / 12:09 AEST).

### shell.shell (1)
PowerShell on Windows. Full host shell. Params `{command, cwd?, timeout?}`. Returns `{stdout, stderr, exitCode, killed}`. **This alone gives me 90% of what SSH would give me.** Get-Service / Get-Process / Get-WindowsCapability / Get-NetConnection / Test-Path / Get-ChildItem / Set-Location / ConvertFrom-Json / Out-File - all native PowerShell is in scope.

### filesystem.* (6)
Direct disk I/O bypassing shell. Guarded by `D:\.code\eos-laptop-agent\.blocked-paths` (currently blocks `D:\PRIVATE`).
- `readFile {path, encoding?}` - returns content
- `writeFile {path, content, encoding}` - writes
- `listDir {path}` - returns entries
- `deleteFile {path}` - removes
- `fileInfo {path}` - stat
- `diskUsage {}` - returns drives array. **Verified: C: 10.6GB free / 126GB total (91% used, tight). D: 805GB free / 1TB total.**

### input.* (7) - cross-platform unified input
Verified callable via `input.cursorPosition` returned `{x:112, y:492}`. SendKeys-based on Windows.
- `click {x?, y?, button?}` - mouse click at coords or current
- `move {x, y}` - move cursor
- `type {text}` - type string
- `key {key}` - single key press
- `shortcut {keys: [...]}` - chord (e.g. ["Ctrl","Tab"])
- `drag {fromX, fromY, toX, toY}` - drag
- `cursorPosition {}` - returns `{x, y}` (read-only, no side effect)

### keyboard.* (5) - older split, kept for compat
- `type` / `press` / `focusWindow` / `copy` / `paste`
- Prefer `input.*` for new code per CLAUDE.md.

### mouse.* (6)
- `click` / `rightClick` / `doubleClick` / `move` / `scroll` / `drag`

### screenshot.screenshot (1)
**OS-level full-screen capture.** Returns `{image: <base64-png>, format: 'png'}`. **VERIFIED 2026-04-29 captured 1366x768 PNG (223KB) of whatever is on Corazon's screen RIGHT NOW.** Saved at `~/ecodiaos/drafts/corazon-desktop-screenshot-2026-04-29.png`. **This works for ANY desktop app, not just browser.**

### process.* (3)
- `listProcesses {}` - returns running processes
- `killProcess {pid}` - terminate
- `launchApp {path, args?}` - spawn a new process / open an app
- (Also reachable via `shell.shell "Get-Process | ..."`)

### browser.* (10) - puppeteer wrapper, attempts CDP-attach
- `navigate {url, waitUntil?, timeout?, preset?, viewport?}` - preset accepts `iphone|pixel|ipad|tablet|desktop`
- `click {text|selector}` / `type {selector, text, delay?}`
- `pageScreenshot {fullPage?, selector?}` - browser-only screenshot (vs `screenshot.screenshot` which is OS-level)
- `evaluate {script}` - script must be an EXPRESSION (wrapped in `new Function('return ('+script+')')`); for multi-statement IIFE `(()=>{...})()`
- `enableCDP {}` - **idempotent (29 Apr patch)**. Probes :9222 first; if reachable, no-op preserves Tate's tabs. Only kill+respawn if CDP genuinely unreachable. Respects `CHROME_PROFILE_DIR` env var (default `Default`).
- `switchTab {url}` - bring tab matching URL substring to front
- `setViewport`, `waitFor`, `close` (uses disconnect() when CDP-attached - 29 Apr patch).

### macro.* (4) - Windows AutoHotkey only
- `run {name}` / `inline {script}` / `list {}` / `save {name, script}`
- Macros at `D:\.code\eos-laptop-agent\macros\*.ahk`. Existing: `click-coords`, `focus-chrome`, `new-tab`, `type-and-submit`.

## Chrome profile state (verified 2026-04-29)

`C:\Users\tjdTa\AppData\Local\Google\Chrome\User Data\Local State` contains 2 profiles:

| ProfileDir | Name | UserName | ShortcutName |
|---|---|---|---|
| `Default` | ecodia.au | tate@ecodia.au | Tate (ecodia.au) |
| `Profile 1` | Tate | tatedonohoe@gmail.com | Tate |

**`Default` is the Ecodia Workspace profile (logged into Google Workspace as tate@ecodia.au).**
**`Profile 1` is Tate's personal Gmail.**

### Implication for the puppeteer "logged-out" failure

`browser.js` currently spawns Chrome with `--profile-directory=Default` unless `CHROME_PROFILE_DIR` env override. So when fork_mojd2kpj attached to Co-Exist via puppeteer and saw `cookieCount=2`/no auth, that's because the Co-Exist app login is on `Profile 1` (Tate's personal Gmail), NOT on the workspace profile.

### Fix path (no code change needed - already supported)

PM2 ecosystem env override per task. Two options:
- **(a) Set per-app env mapping** in kv_store, e.g. `puppeteer.profile_for.app_coexistaus_org = "Profile 1"`. Agent reads at call time (requires browser.js change later).
- **(b) Right now**: when post-deploy testing a client app whose login is on personal Gmail, edit `D:\.code\eos-laptop-agent\ecosystem.config.js` to set `env.CHROME_PROFILE_DIR = "Profile 1"`, `pm2 restart eos-laptop-agent`. For ecodia-internal apps, leave default.

### Cookie file lock state (direct-disk read alternative)

Cookies SQLite at `<UserData>\<Profile>\Network\Cookies`. Lock state right now:
- `Default\Network\Cookies` - **LOCKED** (size 2.69MB, Chrome holds exclusive lock because Chrome is running on this profile).
- `Profile 1\Network\Cookies` - **unlocked** (size 80KB, profile not actively in use).

Direct SQLite read works for the INACTIVE profile. For the active one, need `?mode=ro&immutable=1` SQLite URI flag, or VSS shadow copy, or stop Chrome first. **For most "is Tate logged into X?" recon, screenshot the desktop is faster than fighting the cookie lock.**

## SSH service state (verified 2026-04-29)

| Component | State |
|---|---|
| OpenSSH Client | **Installed** (`OpenSSH.Client~~~~0.0.1.0`) |
| OpenSSH Server | **NotPresent** |
| ssh-agent service | Stopped, StartType: Disabled |
| Port 22 listening | False (TcpTestSucceeded=False) |

### Install path (Tate-when-back, requires admin/UAC)

```powershell
# Run as Administrator
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
# Firewall:
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

After install, key-based auth (preferred over password): drop public key into `C:\Users\tjdTa\.ssh\authorized_keys`. Connection from VPS would be `ssh tjdTa@100.114.219.69` (port 22 over Tailscale - already on the mesh, no public exposure).

**SSH is NOT a blocker.** The agent's `shell.shell` already gives me PowerShell over HTTP. SSH would add: (a) interactive sessions / scp file transfer, (b) standard tooling (rsync, git over ssh), (c) fallback path if the agent process dies. Nice-to-have, not critical.

## Running desktop apps observed (2026-04-29 02:09 UTC)

```
chrome (13 processes) - foreground window: "Ecodia OS - Google Chrome"
ms-teams (2 processes) - main window: "Calendar | Jorgie Rainbird | Microsoft Teams"
msedge (5 processes)
explorer (1)
```

**The Teams desktop app is running with Tate logged in.** Past attempt to scrape Teams via puppeteer/teams.microsoft.com failed because:
1. Teams desktop app does not expose web auth cookies to Chrome.
2. Puppeteer wrapper has zero affordance for native desktop apps.
3. **A `screenshot.screenshot` call right now would literally capture Jess/Jorgie's chat directly.** That's the reframe in concrete form.

## Capability matrix - what to use for what

| Task | Right tool | Wrong tool |
|---|---|---|
| "Is Tate currently in Teams?" | `screenshot.screenshot` of full screen | `browser.navigate teams.microsoft.com` (no auth) |
| "Read a file from D:\.code\X" | `filesystem.readFile` | shell + Get-Content piped over JSON |
| "Run a deploy command" | `shell.shell` | `input.type` typing in a terminal |
| "Click a UI element in a desktop app" | `input.click {x,y}` after screenshot to find coords | `browser.click` (browser-only) |
| "Test a web app's logged-in flow" | `browser.enableCDP` + `browser.navigate` (right CHROME_PROFILE_DIR) | curl from VPS (no Tate auth) |
| "Open VS Code on a project" | `process.launchApp` or `shell.shell "code D:\.code\X"` | `browser.*` |
| "Read Tate's Chrome cookies for a domain" | (a) screenshot logged-in state OR (b) read inactive-profile Cookies SQLite | puppeteer fresh-profile spawn |
| "Drive an Electron app like Slack/Discord" | `screenshot` to read state + `input.*` to drive | browser wrapper (will not see Electron windows) |
| "List running processes" | `process.listProcesses` or `shell.shell "Get-Process"` | both work; pick whichever returns the shape you need |

## Recon evidence files

- `~/ecodiaos/drafts/corazon-desktop-screenshot-2026-04-29.png` - 1366x768 PNG, screen capture proving OS-level capture works regardless of foreground app.
- This file - capability inventory + Chrome profile state + SSH state.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - the doctrine derived from this recon.

## Out of scope (Tate-when-back)

- Installing OpenSSH Server (admin/UAC).
- Modifying Tate's Chrome profile state (signing in/out of accounts on his behalf).
- Adjusting `D:\.blocked-paths` to expand filesystem reach.
- C: drive cleanup (91% used; not urgent but worth flagging).
