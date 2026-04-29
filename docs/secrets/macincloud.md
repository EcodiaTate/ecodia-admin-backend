---
triggers: macincloud, sy094, mac, ssh, mac-ssh, mac-bootstrap, ios-build, xcode, sshpass, ios-release, ipa, mac-host, remote-mac, agent_token, macincloud.password
class: programmatic-required
owner: tate
---

# creds.macincloud

SSH credentials and machine metadata for SY094, the MacInCloud Mac that hosts iOS builds (Xcode, Simulator, ipa generation). Without this row the entire iOS release pipeline halts at preflight - we cannot SSH to the build host.

## Source

MacInCloud control panel (Tate's account, vendor: MacInCloud). The control panel issues username, password, hostname; the agent token was generated when the laptop agent was installed on SY094.

## Shape

object `{username, password, hostname, agent_token, agent_port, ip, os, service, status, apps, connection, xcode}`

## Used by

- `~/ecodiaos/scripts/release.sh` (preflight SSH bootstrap to SY094: `scripts/release.sh:275-281, 326`)
- `~/ecodiaos/scripts/laptop-agent-staging/macroHandlers/xcode-organizer-upload.js` (requires `ssh_pass` from `creds.macincloud.password`)
- `~/ecodiaos/scripts/laptop-agent-staging/macroHandlers/transporter-upload.js` (same)
- `~/ecodiaos/clients/macincloud-access.md` (canonical access doctrine)
- `~/ecodiaos/clients/app-release-flow-ios.md`

## Replaceable by macro?

No. SSH to SY094 IS the bootstrap that ENABLES the macro path on the Mac. The `password` field is what `sshpass` types into the SSH challenge from the VPS.

## Rotation

Per-vendor-policy. **MacInCloud auto-rotates passwords on certain panel events.** If `sshpass` fails with `Permission denied`, the most likely cause is the password rotated and `creds.macincloud.password` is stale.

## Restoration if lost

1. Tate logs into the MacInCloud control panel.
2. Reads current SSH credentials from the panel.
3. Updates `creds.macincloud.password` (and `username`, `hostname` if those changed).

```sql
-- Pseudo-pattern (Tate runs this; agent does not have authority to modify creds without explicit instruction)
UPDATE kv_store SET value = jsonb_set(value::jsonb, '{password}', to_jsonb('NEW_PASSWORD'::text)) WHERE key = 'creds.macincloud';
```

Documented in `~/ecodiaos/clients/macincloud-access.md`.

## Failure mode if missing

All iOS releases blocked at preflight. The `release.sh` driver reaches `die "SSH to $MAC_USER@$MAC_HOST failed. Verify creds.macincloud.password is current; the panel rotates it."`
