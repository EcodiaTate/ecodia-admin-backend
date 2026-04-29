# chrome.switchProfile calibration recon - 2026-04-29

**Status:** Phase 1 structural pieces shipped (`chrome.js` module on Corazon, registered as `chrome.listProfiles`, `chrome.resolveProfileForApp`, `chrome.detectCurrentProfile`, `chrome.switchProfile`). `switchProfile` body is a STUB that throws with a documented pointer to this recon. Calibration of avatar + profile-menu coords is required before the stub can become a real GUI macro.

This recon is the same Option A pattern applied to today's earlier macro retraction (`~/ecodiaos/drafts/macro-phase1-shipped-vs-doctrine-reconciliation-2026-04-29.md`): ship the structural surface, leave the calibrated body as a stub, log the calibration steps. No coords are guessed. No Chrome lifecycle is touched. No `--profile-directory` spawn anywhere.

Doctrine alignment:
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` - profile switching MUST be GUI-macro via `input.click` on the avatar button + profile menu, not `--profile-directory` spawn.
- `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` Phase 1 observation rule - calibrated coords come from a Tate-recorded observation pass against live Chrome on Corazon, not from inference or guessing.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - `chrome.*` is a peer toolset alongside `input.*`, `screenshot.*`, `browser.*`, not an extension of `browser.*`.

---

## What's required to unblock the stub

### 1. Calibration target coords

For each named profile in `PROFILE_REGISTRY` (currently `ecodia-internal` -> `Default` -> displayName `ecodia.au`, and `coexist` -> `Profile 1` -> displayName `Tate`), we need:

| Coord | What it is | Why |
|---|---|---|
| `avatar_button_coords` | x,y of the Chrome avatar/profile-pill button in the top-right of Chrome's window chrome | Click here to open the profile menu |
| `profile_menu_coords[<displayName>]` | x,y of each profile entry inside the opened profile menu | Click here to switch to that profile |

Coords are tied to Tate's specific display geometry. If display layout changes (resolution, scaling, monitor swap), recalibration is required. The stored coords therefore include `display_geometry` for invalidation checks.

### 2. Tate-side observation steps (Phase 1)

This is a hand-driven observation pass on Corazon. Tate does this once, EcodiaOS records the coords. No code yet runs.

1. Open Chrome on Corazon manually. Bring it to the foreground at its normal window size/position.
2. Start a screen recorder (built-in Win+G Game Bar, or share-screen via Teams/Zoom recording).
3. Move the cursor SLOWLY to the Chrome avatar button (top-right of the window chrome, immediately left of the three-dot menu). Pause for 2 seconds.
4. Click the avatar button. The profile menu opens.
5. Move the cursor SLOWLY to each profile entry in the menu. Pause for 2 seconds on each.
6. For each profile entry, click it (Chrome will switch profile - that's fine, it confirms the click target is correct).
7. Stop recording. Share the recording (or screenshots) with EcodiaOS.

EcodiaOS extracts pixel coords from the recording (or asks Tate to run a quick `cliclick`-style coord-readout helper) and writes them into kv_store.

### 3. Coord storage location (kv_store)

Single keys per coord, mirroring the existing `creds.*` namespace convention.

| Key | Shape |
|---|---|
| `corazon.chrome.avatar_button_coords` | `{x: <int>, y: <int>, captured_at: <ISO>, display_geometry: {w: <int>, h: <int>, scale: <float>}}` |
| `corazon.chrome.profile_menu_coords.<displayName>` | `{x: <int>, y: <int>, captured_at: <ISO>, display_geometry: {w: <int>, h: <int>, scale: <float>}}` |

Sample value:
```json
{
  "x": 1240,
  "y": 88,
  "captured_at": "2026-04-30T10:14:00+10:00",
  "display_geometry": { "w": 1920, "h": 1080, "scale": 1.0 }
}
```

`display_geometry` lets a future-self detect drift: when `chrome.switchProfile` runs, it captures current geometry via `screenshot.screenshot` metadata + a Win32 query, compares to the stored geometry, and refuses to click if they diverge (forces a re-calibration rather than mis-clicking).

### 4. Stub -> implementation diff

Once coords are in kv_store, the next fork replaces the body of `switchProfile` in `D:\.code\eos-laptop-agent\tools\chrome.js` with roughly:

```js
async function switchProfile(p) {
  const target = resolveTarget(p); // existing logic
  // 1. Read coords from kv_store via a backend RPC (not direct Supabase from Corazon).
  const avatar = await fetchKv('corazon.chrome.avatar_button_coords');
  const entry  = await fetchKv(`corazon.chrome.profile_menu_coords.${target.displayName}`);
  if (!avatar || !entry) throw new Error('coords not calibrated for ' + target.displayName);
  // 2. Verify display geometry hasn't drifted.
  const geom = await currentDisplayGeometry();
  if (!geomsMatch(geom, avatar.display_geometry)) {
    throw new Error('display geometry drift - recalibration required');
  }
  // 3. Drive the macro.
  await input.click({ x: avatar.x, y: avatar.y });
  await sleep(300);                   // wait for menu animation
  await input.click({ x: entry.x, y: entry.y });
  await sleep(500);                   // wait for profile switch
  // 4. Verify via detectCurrentProfile().
  const now = await detectCurrentProfile();
  if (now.profileDir !== target.profileDir) {
    throw new Error(`switchProfile failed: still on ${now.profileDir}, wanted ${target.profileDir}`);
  }
  return { ok: true, switched_to: target };
}
```

Note: backend RPC for kv_store fetch (rather than wiring Supabase creds into Corazon) keeps the secrets-perimeter on the VPS. The `fetchKv` helper hits an authenticated endpoint on `api.admin.ecodia.au` that the agent token is bound to. That endpoint does not yet exist - it's an additional task to scope when Phase 2 lands.

### 5. Out-of-scope for Phase 1 (this fork)

- No Chrome spawn or kill. Ever.
- No `--profile-directory` flag.
- No `process.exec`-based attempt to read profile state by parsing the running Chrome's command line.
- No backend kv-RPC endpoint (deferred to Phase 2).
- No display-geometry drift detection (deferred to Phase 2).
- No registry expansion (ordit, roam, etc.) - those land when login state actually diverges and the calibration pass is repeated.

---

## Verification (Phase 1, completed by this fork)

Live calls against Corazon agent at `100.114.219.69:7456` after `pm2 restart eos-laptop-agent`:

- `chrome.listProfiles` -> `[{app:"ecodia-internal", profileDir:"Default", displayName:"ecodia.au"}, {app:"coexist", profileDir:"Profile 1", displayName:"Tate"}]` (HTTP 200)
- `chrome.resolveProfileForApp({app:"coexist"})` -> `{profileDir:"Profile 1", displayName:"Tate"}` (HTTP 200)
- `chrome.resolveProfileForApp({app:"unknown-app"})` -> `{profileDir:"Default", displayName:"ecodia.au"}` (HTTP 200, default fallback)
- `chrome.detectCurrentProfile()` -> `{profileDir:"Default", displayName:"ecodia.au", app:"ecodia-internal"}` (HTTP 200, read of Local State succeeded; current profile is `ecodia.au` workspace)
- `chrome.switchProfile({app:"coexist"})` -> HTTP 500, body: `chrome.switchProfile is a Phase 1 stub. Target={"profileDir":"Profile 1","displayName":"Tate"}. ...` (stub throws with pointer to Phase 1 observation rule and the spec doc)

All four assertions in the brief verified.

---

## Cross-references

- Spec source: `~/ecodiaos/drafts/pm2-chrome-profile-per-call-spec-2026-04-29.md` Section 3 Option A
- Mirror retraction: `~/ecodiaos/drafts/macro-phase1-shipped-vs-doctrine-reconciliation-2026-04-29.md` Option A
- Doctrine: `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md`
- Doctrine: `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md`
- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- Cred reference: `~/ecodiaos/docs/secrets/laptop-agent.md` (auth context for Corazon agent)
- Cred reference: `~/ecodiaos/docs/secrets/corazon.md` (Chrome profile mapping: Default = ecodia.au workspace, Profile 1 = personal Gmail / Tate)

Status_board row "Corazon-as-peer build-out" updated to reflect Phase 1 shipped, Phase 2 calibration on Tate.
