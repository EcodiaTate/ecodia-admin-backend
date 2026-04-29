---
triggers: cmd-flash, windows-spawn, execSync, spawnSync, windowsHide, createNoWindow, CREATE_NO_WINDOW, console-window-flash, agent-on-windows, eos-laptop-agent, powershell-flash, child-process-windows, process-spawn-flash, taskkill-flash, screenshot-flash, input-flash, click-flash, type-flash, parent-has-console, pm2-daemon-console
---

# On Windows: any agent subprocess must use spawnSync with windowsHide + creationFlags: CREATE_NO_WINDOW. execSync(cmd, {windowsHide:true}) is NOT enough when the parent process has a console.

## TOP-LINE INVARIANT (29 Apr 2026, after Tate flagged cmd-flashes on every input/screenshot)

When the eos-laptop-agent runs as a child of PM2 (which is a child of the user's elevated shell), the agent's process tree HAS A CONSOLE. Any `child_process.execSync(cmd, options)` or `child_process.spawn(file, args, {windowsHide:true})` on Windows still creates a brief visible console window for child processes BECAUSE:

- `windowsHide:true` only sets `STARTF_USESHOWWINDOW` + `wShowWindow=SW_HIDE`. The console IS allocated and the window IS created; it just gets hidden ms after. Visible flash on the user's screen.
- The HIDE happens too late when the child is a console app (cmd.exe, powershell.exe, taskkill, tasklist, wmic). The window briefly appears.

**The reliable fix: `creationFlags: CREATE_NO_WINDOW (0x08000000)` via `spawnSync` (or `spawn`).** This tells Windows: "do not create a console for this child at all." No window allocated, no window to hide, zero flash.

## The pattern

```js
const { spawnSync } = require('child_process')
const CREATE_NO_WINDOW = 0x08000000

function runHidden(file, args, timeoutMs = 15000) {
  const r = spawnSync(file, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: false,
    detached: false,
    creationFlags: CREATE_NO_WINDOW,
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    const e = new Error('Command failed: ' + file + ' status=' + r.status + ' stderr=' + (r.stderr || ''))
    e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr
    throw e
  }
  return r.stdout || ''
}
```

For long-lived spawns that should outlive the agent (e.g. launching Chrome): use `spawn` with `creationFlags: 0x00000008 (DETACHED_PROCESS)` so the child detaches from the parent's console entirely.

## Why execSync fails

`child_process.execSync(cmd, options)` always runs `cmd` through `cmd.exe` (with `shell:true` default) or via `command-line parsing`, both of which on Windows create a console for the wrapper shell even when the wrapped command is hidden. The wrapper console flash IS the cmd flash.

`child_process.spawn(file, args, {windowsHide:true, shell:false})` is closer to the metal but still allocates the console because libuv's STARTUPINFO doesn't suppress console allocation - just hides it.

`spawnSync` (or `spawn`) with explicit `creationFlags: CREATE_NO_WINDOW` passes the flag straight to `CreateProcess`, which suppresses console allocation entirely.

## Files patched in eos-laptop-agent (29 Apr 2026)

All converted from `execSync(cmd)` to `spawnSync(file, args, {creationFlags: CREATE_NO_WINDOW})` on Windows:

| File | Hot path |
|---|---|
| `tools/shell.js` | `shell.shell` - every shell call |
| `tools/input.js` | `input.click`, `input.type`, `input.shortcut`, etc - every input call |
| `tools/screenshot.js` | `screenshot.screenshot` - every screenshot |
| `tools/browser.js` | `browser.enableCDP` (taskkill chrome) |
| `tools/process.js` | `process.listProcesses`, `process.killProcess` |
| `tools/filesystem.js` | `filesystem.diskUsage` (wmic call) |

After patching all six, every agent tool call is silent. Verified empirically - Tate's screen no longer flashes during click/type/screenshot/process/filesystem operations.

## Do

- For every NEW Windows-spawning function in the agent: use `spawnSync(file, args, {creationFlags: CREATE_NO_WINDOW, windowsHide: true, shell: false})`.
- For NON-Windows: regular `execSync` is fine (no console-window concept on macOS/Linux).
- ALWAYS branch on `process.platform === 'win32'` to pick the path.
- For long-lived child processes (Chrome, browser, daemon), use `spawn` with `creationFlags: DETACHED_PROCESS (0x00000008)` instead of CREATE_NO_WINDOW.

## Do NOT

- Do NOT trust `windowsHide: true` alone. It hides AFTER the console is allocated. You see the flash.
- Do NOT use `shell: true` in agent subprocess calls. It wraps in cmd.exe which always allocates a console.
- Do NOT use `execSync(cmd)` on Windows in any agent hot path. It runs through cmd.exe by default.
- Do NOT pass commands as a single string; use `(file, args[])` form so quoting is safe AND `shell:false` is a valid choice.

## Origin event

29 Apr 2026 11:14 - 12:43 AEST. Tate's "while I'm gone, push yourself" autonomous window. Earlier (12:11) he typed in real-time during my screenshots: "cmd is opening every time you run a call, opening just for a moment, but that'll always happen unless you change how you're doing it." I had patched `shell.js` with `creationFlags: CREATE_NO_WINDOW` but the flash persisted because input.js + screenshot.js + browser.js + process.js + filesystem.js still used `execSync` without the flag. Audited all six tool files, replaced with `spawnSync(file, args, {creationFlags: CREATE_NO_WINDOW})`. Restarted eos-laptop-agent via PM2. Empirical screenshot during patched session showed zero cmd-flash. Tate's prior message at 11:14 had been: "be on it 24/7, on your game, fired up, not assistant-style" - the persistence-of-flash was itself the cmd-flash visible to him as I worked.

## Cross-references

- `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` - the related Chrome-launch pattern; uses same DETACHED_PROCESS flag for chrome to avoid console attachment.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - the parent doctrine: agent on Tate's laptop is a peer, must not visually disrupt his work.
- `~/ecodiaos/patterns/route-around-block-means-fix-this-turn-not-log-for-later.md` - the doctrine that drove this fix: when the same symptom hits twice (Tate flagged at 12:11 AEST after I'd already patched shell.js at 12:11), the second strike means audit ALL similar code paths, not just the one.
