---
triggers: canva, canva-2fa, mfa-backup-codes, canva-login, backup-codes, recovery-codes, 2fa-fallback, canva-account-recovery
class: gui-macro-replaces
owner: tate
---

# creds.canva.mfa_backup_codes

Canva account 2FA backup codes. Single-use codes that clear Canva's 2FA challenge when Tate's normal 2FA device is unreachable. Used by Canva-login macros to drive the 2FA prompt without needing Tate to fish for his phone.

## Source

canva.com > Settings > Login & Security > Two-factor authentication > Generate backup codes.

## Shape

object `{service, account, codes[], count_total, count_used, used_codes, received_from_tate_at, note}`

`codes[]` is the full set issued by Canva (typically 10). `count_used` and `used_codes` track which have been burned (each code is one-time-use).

## Used by

- Canva-login macros via Corazon Chrome (when prompted for 2FA, type the next unused backup code)

## Replaceable by macro?

N/A - these ARE the macro's input. Equivalent to the Apple 2FA case but for Canva.

## Rotation

Canva regenerates the full set on demand. Individual codes expire after one use.

When `count_used` approaches `count_total`, Tate must regenerate before the set is exhausted.

## Restoration if lost

1. Tate logs into canva.com > Settings > Login & Security > 2FA.
2. Regenerate backup codes (this invalidates the old set).
3. UPSERT `creds.canva.mfa_backup_codes` with the new set, reset `count_used`/`used_codes`.

## Burn protocol

Every time a macro consumes one:
1. Pick the lowest-index unused code.
2. Type it.
3. Increment `count_used`, append to `used_codes`.

The macro should never re-use an already-used code.

## Failure mode if missing

If Tate's normal 2FA device is unavailable AND backup codes are exhausted, Canva login locks out and requires Canva account recovery (slow, manual, support ticket).
