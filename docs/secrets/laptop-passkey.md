---
triggers: laptop, corazon, passkey, windows-hello, 2fa-passkey, windows-passkey, 5-point-check, tate-blocked, exhaust-laptop-route, credential-prompt, 6969, windows-unlock
class: gui-macro-replaces
owner: tate
---

# creds.laptop_passkey

The Windows Hello / passkey value for Corazon. Drives the credential prompt that appears when a 2FA challenge surfaces a Windows passkey UI - the agent types this string via `input.type` to clear the prompt. Currently `6969` (4 chars).

This row is the linchpin of the 5-point check that prevents premature `next_action_by='tate'` classification: if a workflow blocks at a Windows passkey prompt, the agent has authority to type this passkey and continue.

## Source

Tate sets the value via Windows Settings on Corazon (Windows Hello / Sign-in options).

## Shape

scalar string (currently 4 chars).

## Used by

- The 5-point check in `~/CLAUDE.md` "Tate-blocked is a last resort, not a default" section
- Cross-ref in `~/ecodiaos/CLAUDE.md` "Credentials" section
- Any macro flow that reaches a Windows Hello prompt before completing a credential capture
- Referenced by `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` (note: this pattern file is a stale ref - see secrets/INDEX.md Drift; the doctrine lives in `~/CLAUDE.md` directly)

## Replaceable by macro?

N/A - this IS the macro's input. The value is what the agent types into Windows Hello.

## Rotation

Tate's discretion. Windows Hello can be re-set in Settings, but rotation is rare-to-never.

## Restoration if lost

1. Tate sets a new passkey via Windows Settings > Accounts > Sign-in options > PIN (Windows Hello).
2. UPSERT `creds.laptop_passkey` with the new scalar value.

## Failure mode if missing

Any auth flow that surfaces a Windows passkey prompt blocks at the prompt; the agent classifies the workflow as `next_action_by='tate'`. With the passkey present, the agent can type-and-clear the prompt without escalation.

## Sensitivity note

This is a 4-char scalar, NOT high-entropy. Its security is the local-network constraint (Tailscale-only access to Corazon) plus Windows Hello's own rate limiting on the device. Do NOT echo it in logs or screenshots; use `input.type` (which sends keystrokes directly to the focused field, no terminal echo).
