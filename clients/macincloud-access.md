# SY094 (MacInCloud) - Access Pattern

> Reframe per Tate directive 2026-04-26: the real blocker on the Mac is not signing credentials, it is the access pattern. Document that here. Signing creds will surface naturally when an iOS build is actually attempted.

**Machine:** SY094.macincloud.com (MacInCloud rented Mac)
**Tailscale IP:** none (NOT on the EcodiaOS Tailnet - access is SSH-only)
**Public IP:** 103.246.99.94
**SSH user:** user276189
**Agent port:** 7456 (localhost on the Mac, NOT exposed publicly)
**OS:** macOS 15.7.4, Apple Silicon, 16GB RAM, Xcode 26.3
**Has installed:** Claude.app, Cursor, Android Studio, Firefox, Xcode toolchain

## Credentials (canonical: kv_store.creds.macincloud)

```sql
SELECT value FROM kv_store WHERE key = 'creds.macincloud';
```
Returns `{username, password, hostname, ip, agent_token, ...}`. The password is the SSH password (no key auth - publickey is disabled on this account, intentional per the rental). The `agent_token` is the bearer for the on-Mac agent at localhost:7456.

## How I actually reach it from the VPS

**Two layers of indirection:**

1. **SSH for shell + filesystem.** Use `sshpass` to bypass the no-pubkey requirement.
   ```bash
   sshpass -p '<password>' ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new \
     user276189@SY094.macincloud.com '<command>'
   ```

2. **SSH tunnel for the on-Mac HTTP agent (port 7456).** The agent listens only on localhost; to talk to it from the VPS I open a local-forward tunnel and call it via 127.0.0.1.
   ```bash
   sshpass -p '<password>' ssh -o PubkeyAuthentication=no \
     -L 17456:localhost:7456 -fN user276189@SY094.macincloud.com
   curl -H "Authorization: Bearer <agent_token>" http://127.0.0.1:17456/api/health
   ```
   Tear down the tunnel when done by killing the backgrounded ssh PID.

   Alternative: do everything via SSH shell commands without the tunnel. The agent's HTTP API is mostly a wrapper around `shell.shell` + `filesystem.*` + `process.*`, all of which are reachable via plain SSH. Keep the tunnel for `browser.*` and `screenshot.screenshot` which need the agent's persistent Puppeteer profile.

## What works without any extra setup

- **SSH shell commands** - `git`, `xcodebuild`, `pod`, `xcrun`, file CRUD, process listing, `osascript`. Use these for >90% of Mac work.
- **Filesystem reads/writes** under the user home.
- **Xcode CLI** - `xcodebuild`, `xcrun altool`, `xcrun simctl` (simulators).
- **Spawning GUI apps** via `open -a` from SSH (works because the user is logged in on the Mac console).

## What needs the agent (and therefore the tunnel)

- **Persistent browser profile** - the on-Mac Chromium has cached SaaS logins (App Store Connect, TestFlight, Apple Developer, Xero if logged in there). Hitting these via the agent's `browser.navigate` keeps the session alive. Going via raw SSH + headless Chromium would lose the persistent login.
- **Visual screenshot of the GUI desktop** - `screenshot.screenshot` returns the live macOS desktop bitmap. Useful for visual verification of an Xcode build, ASC submission state, or device pairing dialog.
- **`process.launchApp`** - launches a GUI app and returns a handle. SSH `open -a` works but is fire-and-forget.

## Verified-working workflows (run these to smoke-test the connection)

```bash
# 1. SSH shell smoke test
PW=$(db_query "select value::json->>'password' from kv_store where key='creds.macincloud'")
sshpass -p "$PW" ssh -o PubkeyAuthentication=no user276189@SY094.macincloud.com 'sw_vers && xcodebuild -version'

# 2. Agent HTTP smoke test (via tunnel)
TOKEN=$(db_query "select value::json->>'agent_token' from kv_store where key='creds.macincloud'")
sshpass -p "$PW" ssh -o PubkeyAuthentication=no -L 17456:localhost:7456 -fN user276189@SY094.macincloud.com
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17456/api/health
# Expected: {"status":"ok","platform":"darwin",...}

# 3. List Xcode-available simulators (via SSH, no agent needed)
sshpass -p "$PW" ssh -o PubkeyAuthentication=no user276189@SY094.macincloud.com 'xcrun simctl list devices available | head -30'
```

## When to actually use the Mac (not just have it idle)

- **iOS build / archive / TestFlight submit** - this is its primary job. Run via SSH:
  ```
  cd ~/projects/<app>
  xcodebuild -workspace <App>.xcworkspace -scheme <Scheme> -archivePath build/<App>.xcarchive archive
  xcrun altool --upload-app -f build/<App>.ipa -u <appleid> -p <app-specific-password>
  ```
- **App Store Connect submission status** - via the persistent-login Chromium (agent path).
- **Visual regression of an iOS simulator** - boot a sim via `simctl`, `xcrun simctl io booted screenshot`, scp the PNG back.
- **Code review on Tate's machine when his laptop is off** - SSH in, `git log`, `git diff`, etc.

## When NOT to use the Mac

- For VPS-side bookkeeping, scheduling, MCP work, Neo4j, anything that has no GUI / iOS-toolchain need - the VPS is faster, always-on, and doesn't burn rental hours.
- For client web work that has a Windows alternative on Corazon (1TB, persistent Chrome) - prefer Corazon unless there's a Mac-only reason.

## Failure modes to know

- **MacInCloud kicks idle sessions.** If the SSH connection has been idle for hours, the rental session may have ended. Reconnect; the agent should auto-restart on Mac console boot but verify with `/api/health`.
- **Password rotates.** MacInCloud auto-rotates passwords on certain events. If `sshpass` fails with `Permission denied`, check the MacInCloud control panel and update `kv_store.creds.macincloud.password`.
- **Tunnel collisions.** If a previous tunnel is still open on local port 17456, the new ssh -L will silently bind to a different port or fail. Use `pkill -f 'ssh.*17456:localhost:7456'` before re-tunnelling.
- **No outbound Tailscale.** I cannot reach the Mac via Tailnet because MacInCloud's account is not on it. Adding it would require installing Tailscale on the Mac with `sudo` rights - possible but not done. Decision: accept SSH-only for now, revisit if I find myself wanting Tate's machine + this Mac on the same private network for any reason.

## Status

Agent live and reachable via the documented pattern. Next opportunistic test: actual iOS build of Roam when IAP unblocks (separate status_board row).

## Origin

Tate directive 2026-04-26: "real issue is access pattern, not credentials." Status_board row demoted from "blocked on signing creds" to "document the actual access pattern." This file is the deliverable for that demotion.
