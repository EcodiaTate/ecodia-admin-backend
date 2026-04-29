# PM2 Chrome profile per-call override - spec (2026-04-29)

Fork: `fork_mojlzepj_291024`. Authored 15:24 AEST 29 Apr 2026.

## TL;DR for the next implementer fork

The brief that triggered this spec assumed `browser.js` still spawns Chrome with `--profile-directory=$CHROME_PROFILE_DIR`. **It does not, as of the 14:24 AEST surgical-no-spawn-no-kill patch on Corazon.** The `CHROME_PROFILE_DIR` variable in `D:\.code\eos-laptop-agent\.env` is currently dead - nothing reads it. The shipped `browser.*` toolset is attach-only via `puppeteer.connect(browserURL: 'http://localhost:9222')`. Profile is whatever Chrome instance is bound to :9222 by Tate's interactive Session 1.

That, combined with the 14:32 AEST `drive-chrome-via-input-tools-not-browser-tools.md` doctrine making `input.*`+`screenshot.*` the default Chrome-driving path, means the per-call `profileDir` parameter the brief asked for needs a redesign. The naive "thread profileDir through browser.* and have it spawn Chrome with --profile-directory" path is a doctrine violation in two ways:

1. browser.js explicitly does not spawn Chrome anymore (no-spawn-no-kill rule).
2. driving profile selection through `browser.*` at all is now the secondary path. Default = `input.*` clicks Tate's actual Chrome.

This spec proposes the doctrine-aligned design: a NEW `chrome.switchProfile` tool (input.*-driven, no Chrome lifecycle touching) + an OPTIONAL verification-only `profileDir` parameter on `browser.navigate` that asserts the currently-attached Chrome is on the expected profile.

---

## Section 1 - Current behaviour (verified live 29 Apr 2026 15:20 AEST)

### `D:\.code\eos-laptop-agent\.env`
```
AGENT_TOKEN=fad8...e6011f
CHROME_PROFILE_DIR=Default
```

### `D:\.code\eos-laptop-agent\tools\browser.js` (post 14:24 patch)
- Module-scope: `const CDP_URL = 'http://localhost:9222'`. No `process.env.CHROME_PROFILE_DIR` reference anywhere.
- `ensureBrowser()` calls `puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })`. **Never spawns chrome.exe.**
- `enableCDP()` is probe-only. If :9222 is unbound it returns `{cdpEnabled: false, error: '...'}` and instructs the caller to launch Chrome interactively in Session 1. **Never spawns chrome.exe.**
- `close()` calls `browser.disconnect()` only. **Never kills chrome.exe.**

### `D:\.code\eos-laptop-agent\index.js`
- Generic param dispatcher. Reads `req.body.{tool, params}` and calls `tools[tool](params)`. No env injection, no per-tool transformation. **Adding new params to a tool is a pure tool-file change; index.js needs no edit.**

### `D:\.code\eos-laptop-agent\ecosystem.config.js`
```js
env: { NODE_ENV: 'production', AGENT_PORT: 7456 }
```
**`CHROME_PROFILE_DIR` is NOT in the PM2 env block.** It would only be loaded if the agent explicitly required `dotenv` (it does not - `index.js` reads `process.env.AGENT_TOKEN` and `process.env.AGENT_PORT` only). The `.env` file is therefore dead-loaded for browser purposes.

### Implication
The "per-call PM2 env override for CHROME_PROFILE_DIR" framing is obsolete. Profile selection at the agent level is currently a NO-OP because nothing on the agent side decides Chrome's profile. Whatever Chrome is currently focused on Tate's desktop (which has whatever profile Tate last clicked) is what `browser.*` attaches to.

---

## Section 2 - profileDir param feasibility

### YES, with a redesign. Three flavours:

| Option | What it does | Doctrine-aligned? | Recommended? |
|---|---|---|---|
| A. New `chrome.switchProfile` tool (input.*-driven) | Drives Tate's Chrome via `input.shortcut [ctrl, shift, m]` (profile menu) + `input.click` to select named profile. Returns when screenshot confirms switch. | Yes - matches drive-chrome doctrine. | YES (primary) |
| B. `profileDir` param on `browser.navigate` (verification-only) | Before navigation, evaluates `chrome://version` page or reads a cookie known to be profile-scoped. If currently-attached Chrome is not on the requested profile, returns error and tells caller to call `chrome.switchProfile` first. | Yes - browser.* stays attach-only. | YES (secondary, niche) |
| C. `profileDir` param triggers spawn with `--profile-directory` | Re-introduces Chrome lifecycle in browser.js. Violates no-spawn-no-kill rule. Risk: SingletonLock collisions, killing Tate's open Chrome. | NO. | NO |

### Recommendation
**Implement A first. Add B only if a real CDP-attach use case demands programmatic profile assertion. C is off the table.**

---

## Section 3 - Concrete code-diffs (NOT applied)

### Option A: new `chrome.switchProfile` tool

**New file: `D:\.code\eos-laptop-agent\tools\chrome.js`**

```js
// chrome.js - high-level Chrome GUI orchestration on top of input.* + screenshot.
//
// Doctrine: drive-chrome-via-input-tools-not-browser-tools.md.
// This module DOES NOT spawn or kill Chrome. It DOES NOT use puppeteer or CDP.
// It uses input.* (SendKeys-based) and screenshot.* (OS-level) only.

const input = require('./input')
const screenshot = require('./screenshot')

// switchProfile - opens Chrome's profile menu and clicks the named profile.
// Param `profileDir` is the User Data subdir name (e.g. "Default", "Profile 1").
// Param `displayName` is the human label shown in the menu (e.g. "ecodia.au", "Tate").
// Either one is sufficient if displayName is unambiguous; both make the call deterministic.
//
// Returns { switched: boolean, currentProfile?: string, screenshot: <base64> }.
//
// Implementation notes:
// - Tate's Chrome must already be focused. Caller is responsible (e.g. by clicking taskbar
//   icon or `input.shortcut [alt, tab]` to bring Chrome forward).
// - The profile menu is NOT bound to Ctrl+Shift+M by default in current Chrome stable; the
//   menu lives on the avatar button top-right of the omnibar. The reliable path is to read
//   the screenshot, locate the avatar (consistent x,y per Tate's window geometry; can be
//   stored in kv_store after first calibration), input.click it, screenshot the menu,
//   locate the named profile entry, input.click it. A new window opens.
// - For the v1 implementation, pre-calibrated coords are stored in kv_store key
//   `corazon.chrome.avatar_button_coords` and `corazon.chrome.profile_menu_coords.<displayName>`.
//   Calibration is a one-time manual step; spec does not auto-calibrate.

async function switchProfile(p) {
  const { profileDir, displayName } = p
  if (!profileDir && !displayName) {
    throw new Error('switchProfile requires profileDir or displayName')
  }
  // 1. Click avatar button (coords from kv_store / hardcoded calibration)
  // 2. Wait 300ms for menu render
  // 3. Click named profile entry
  // 4. Wait 1500ms for new Chrome window to open and bind to :9222 (or not - profile switch may
  //    just bring forward an existing window for that profile)
  // 5. Return screenshot for caller to verify
  // (Implementation deferred to next fork)
  throw new Error('Not yet implemented - see ~/ecodiaos/drafts/pm2-chrome-profile-per-call-spec-2026-04-29.md')
}

// resolveProfileForApp - lookup helper. Reads a static map (in code) or kv_store
// (preferred, see Section 5 profile registry).
function resolveProfileForApp(p) {
  const { app } = p
  const REGISTRY = {
    'coexist': { profileDir: 'Profile 1', displayName: 'Tate' },
    'ecodia-internal': { profileDir: 'Default', displayName: 'ecodia.au' },
  }
  return REGISTRY[app] || REGISTRY['ecodia-internal']
}

module.exports = { switchProfile, resolveProfileForApp }
```

### Option B: verification-only profileDir on browser.navigate

**Edit: `D:\.code\eos-laptop-agent\tools\browser.js` `navigate()` function**

Add at top of `navigate(p)` after `await ensureBrowser()`:

```js
async function navigate(p) {
  await ensureBrowser()
  if (p.profileDir) {
    // Verification: read chrome://version in a new tab, scrape "Profile Path"
    const verifyPage = await browser.newPage()
    try {
      await verifyPage.goto('chrome://version/', { timeout: 5000 })
      const profilePath = await verifyPage.evaluate(() => {
        const row = [...document.querySelectorAll('tr')].find(tr => tr.textContent.includes('Profile Path'))
        return row ? row.textContent.replace('Profile Path', '').trim() : null
      })
      const expectedSegment = p.profileDir // e.g. "Default" or "Profile 1"
      if (!profilePath || !profilePath.includes(expectedSegment)) {
        throw new Error(`browser.navigate: attached Chrome is on profile path "${profilePath}", expected segment "${expectedSegment}". Call chrome.switchProfile first.`)
      }
    } finally {
      await verifyPage.close()
    }
  }
  if (p.viewport || p.preset) {
    await setViewport(p.viewport ? p.viewport : { preset: p.preset })
  }
  const waitUntil = p.waitUntil || 'networkidle2'
  const timeout = p.timeout || 30000
  await page.goto(p.url, { waitUntil, timeout })
  return { url: page.url(), title: await page.title() }
}
```

This is opt-in. Existing callers that don't pass `profileDir` get current behaviour. Callers that pass it get a hard error if the attached Chrome's profile does not match.

### index.js - no change required
Generic dispatcher already passes `params` through unchanged.

---

## Section 4 - Profile registry

Static map (codified in `chrome.js` `resolveProfileForApp`, mirrored in kv_store for runtime override):

| App slug | profileDir | displayName | Why |
|---|---|---|---|
| `coexist` | `Profile 1` | Tate | Co-Exist Google SSO bound to tatedonohoe@gmail.com (personal Gmail) |
| `ecodia-internal` | `Default` | ecodia.au | Apple, Vercel, Microsoft, GitHub corp - all on tate@ecodia.au workspace |
| `ordit` | `Default` | ecodia.au | Bitbucket fireauditors1, Atlassian - Tate signs in as tate@ecodia.au |
| `roam` | `Default` | ecodia.au | App Store Connect, Play Console - tate@ecodia.au |
| (default fallback) | `Default` | ecodia.au | Safest default - workspace profile |

**Storage:** kv_store key `corazon.chrome.profile_registry` as JSON `{[app]: {profileDir, displayName}}`. Lets the registry be updated without an agent code redeploy. `chrome.resolveProfileForApp` reads kv_store first, falls back to in-code map.

**Co-Exist confirmation source:** `~/ecodiaos/clients/coexist-android-sso-diagnostic-2026-04-29.md` (this fork's brief cites it).

---

## Section 5 - How callers decide profile

**Caller pattern (preferred, explicit):**
```
1. Caller (VPS-side) knows which app they need.
2. Call chrome.resolveProfileForApp({app: "coexist"}) -> {profileDir: "Profile 1", displayName: "Tate"}.
3. Call chrome.switchProfile({profileDir: "Profile 1", displayName: "Tate"}).
4. (Now Tate's Chrome is on the right profile, focused.)
5. If CDP attach is genuinely needed (the rare case), call browser.navigate with profileDir: "Profile 1" for safety verification.
6. Otherwise default path: input.shortcut [ctrl, l] + input.type <url> + input.key enter, then screenshot to read state.
```

**Anti-pattern:** caller asks browser.* to "use Profile 1" while Tate's focused Chrome is on Default. Old design (spawn-with-flag) would have launched a parallel Chrome and failed silently; new design (switchProfile + verification) makes the dependency explicit and surfaces the mismatch as an error.

---

## Section 6 - Risks and gotchas

### HIGHEST-RISK GOTCHA
**SingletonLock collision is NOT a risk in the new design** because no fork ever spawns Chrome. The single risk is concurrent forks competing for Tate's focused Chrome window: fork A calls `chrome.switchProfile -> Profile 1`, fork B simultaneously calls `chrome.switchProfile -> Default`, the second one wins and fork A's subsequent `browser.navigate` lands on the wrong profile.

**Mitigation:** the agent is single-tenant by architecture. Serialize all `chrome.switchProfile` + `browser.*` calls behind a process-level mutex in the agent (or a kv_store lock with TTL). Implementation deferred but flagged. The doctrine bias toward `input.*`+`screenshot.*` makes most callers not touch `browser.*` at all, lowering collision frequency.

### Other gotchas
- Chrome's profile menu UI changes between versions. Pre-calibrated avatar coords go stale on UI updates. v2 should use OCR or template-matching against a screenshot to re-locate the avatar dynamically.
- Some Tate workflows have BOTH profiles open in separate windows simultaneously. `chrome.switchProfile` should bring-to-front the existing window for that profile if one exists, not open a new one. Current Chrome behaviour: clicking a profile entry in the menu opens a new window if none exists, focuses existing if one does. v1 relies on this.
- `browser.evaluate` of `chrome://version` is the most reliable profile-detection mechanism. `chrome://version` is a special URL puppeteer can navigate to and DOM-scrape; works even when other profile-detection (cookies, localStorage) would not.
- Calling `chrome.switchProfile` while no Chrome is focused (Tate alt-tabbed away) lands the click on whatever IS focused. Pre-call check: `process.listProcesses` for chrome, `screenshot.screenshot` to verify Chrome is the topmost window. If not, `input.shortcut [alt, tab]` cycle until Chrome is forward, OR fail with clear error.

---

## Section 7 - Doctrine recommendation

**The per-call profile override is a SECONDARY-PATH safety net, not the primary mechanism.**

The primary mechanism is the doctrine in `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md`: drive Tate's actual focused Chrome via `input.*`+`screenshot.*`. In that doctrine, profile selection is a GUI action like any other - if the wrong profile is focused, click the avatar, click the right profile, screenshot to verify. There is no "hidden" profile state; the source of truth is the screenshot.

The `chrome.switchProfile` + `browser.navigate(profileDir: ...)` machinery in this spec is only worth building when:
1. A specific app's flow genuinely requires CDP-level capability beyond what screenshot+input can do (DOM evaluation, network interception, cookie introspection beyond a screenshot's reach), AND
2. That flow runs unattended (autonomous fork) where a wrong-profile error would silently produce bad data.

For most Co-Exist post-deploy testing, the cleaner path remains: `chrome.switchProfile -> Profile 1`, then drive the page via `input.*`+`screenshot.*`, NOT `browser.navigate`.

---

## Section 8 - Cleanup of dead state

Independent of whether A and B above ship, the dead `CHROME_PROFILE_DIR=Default` line in `D:\.code\eos-laptop-agent\.env` should be removed. It implies a contract that no longer exists. Keeping it sets a future trap where someone changes it expecting profile behaviour and is silently ignored.

**Action:** in the implementing fork, also `filesystem.writeFile` to `.env` removing the `CHROME_PROFILE_DIR` line, leaving only `AGENT_TOKEN=...`. No PM2 restart needed because nothing reads it.

---

## Section 9 - What the next fork should do

1. Read this spec.
2. Read `~/ecodiaos/clients/corazon-peer-architecture-2026-04-29.md` for tool surface.
3. Calibrate Chrome avatar button coords on Tate's current window geometry (one-time screenshot + manual coord identification, save to kv_store `corazon.chrome.avatar_button_coords`).
4. Implement `tools/chrome.js` per Section 3 Option A.
5. Implement Option B verification-only profileDir on `browser.navigate` per Section 3.
6. Remove dead `CHROME_PROFILE_DIR` line from `.env`.
7. Seed kv_store `corazon.chrome.profile_registry` per Section 4.
8. PM2 restart `eos-laptop-agent`.
9. Test: `chrome.switchProfile {profileDir: "Profile 1"}` -> screenshot shows personal Gmail profile chip top-right.
10. Test: `browser.navigate {url: "https://app.coexistaus.org", profileDir: "Profile 1"}` -> succeeds. Same call with `profileDir: "Default"` while on Profile 1 -> errors cleanly.
11. Update status_board row to "shipped (fork id), tested".

## Cross-references

- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` (parent doctrine)
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` (default Chrome path)
- `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` (legacy attach mechanics, mostly obsolete after 14:24 patch)
- `~/ecodiaos/clients/corazon-peer-architecture-2026-04-29.md` (live tool inventory + Chrome profile state)
- `~/ecodiaos/clients/coexist-android-sso-diagnostic-2026-04-29.md` (the Co-Exist on Profile 1 finding that motivated this work)
- status_board row id `b97f443d-3bd7-42b5-b159-bbcf4d7f330a` "Corazon-as-peer build-out"

## Origin

Brief from main session, fork `fork_mojlzepj_291024`, 15:00 AEST 29 Apr 2026. Recon executed 15:15-15:24 AEST. The brief assumed CHROME_PROFILE_DIR was still live in browser.js; recon confirmed it was removed in the 14:24 surgical-no-spawn-no-kill patch. Spec redesigns the per-call override to fit the post-patch attach-only architecture and the drive-chrome-via-input-tools doctrine.
