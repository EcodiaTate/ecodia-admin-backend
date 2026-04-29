---
triggers: apple-2fa, 2fa-code, transient, stale-cred, sms-code, push-notification, expired-code, cleanup-target
class: programmatic-required
owner: ecodiaos
---

# creds.apple_2fa_code

Transient artefact. A 6-digit Apple 2FA code captured during a one-time credential capture session. Apple 2FA codes expire in approximately 30 seconds, so this row is **stale by design** the moment its captured workflow completed.

## Source

Apple SMS / push 2FA prompt during a macro-driven credential capture session.

## Shape

scalar (other shape per the kv_store probe; length 7 - presumably a quoted 6-digit code).

## Used by

None currently. Was consumed by the macro session that captured `creds.apple` on 29 Apr 2026; row is post-hoc residue.

## Replaceable by macro?

N/A - this is the OUTPUT of a 2FA challenge, not a credential to be maintained. New challenges produce new codes.

## Rotation

Every Apple 2FA challenge.

## Restoration if lost

Don't restore. Delete on next cleanup pass.

## Drift / cleanup recommendation

This row should be pruned. The fork that authored the secrets registry was forbidden from deleting kv_store rows; the cleanup is on Tate's punch list (status_board P3). If you're a future fork and have authority to delete:

```sql
DELETE FROM kv_store WHERE key = 'creds.apple_2fa_code';
```

After deletion, this file can be removed too.
