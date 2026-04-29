---
triggers: tate-blocked, next_action_by-tate, last-resort, 5-point-check, exhaust-laptop-route, browser-saved-credential, corazon-route, passkey-2fa, web-credential-walled, signed-in-session, tate-required, escalate-to-tate, blocked-on-tate, default-defer, ask-tate, classify-blocker, apple-team-id, asc-id-lookup, vendor-portal-login, tate-laptop-default-profile, gui-macro-route
---

# Exhaust the laptop + browser + saved-credential route before declaring anything Tate-blocked

The default for any web-accessible credential-walled resource is NOT "ask Tate." Corazon (Tate's Windows laptop, on Tailscale) runs Tate's actual Chrome with the Default profile holding all his saved Apple, Google, GitHub, Vercel, Stripe, Microsoft, Resend, Atlassian, Bitbucket, Supabase, and similar credentials. The Windows passkey for Hello / WebAuthn challenges lives in `kv_store.creds.laptop_passkey`. Therefore: any web URL Tate has access to in his browser, I can also reach via Corazon. Setting `next_action_by='tate'` is reserved for genuine last-resort cases, not the first reach.

## The rule

Before classifying any blocker as Tate-required, I run the 5-point check. All five must yield affirmative answers. If any of them fails for documented reasons, the row context names which point failed and why.

## The 5-point check (run BEFORE setting next_action_by='tate')

1. **Is the resource accessible at a URL?**  If no - desktop-only CLI on a host I lack, OS-level GUI on Tate's phone, physical hardware - it MAY be Tate-blocked. If yes, continue.
2. **Is the credential in Tate's Chrome Default profile on Corazon?**  Probe by driving Tate's existing Chrome via `input.*` + `screenshot.*` (per `drive-chrome-via-input-tools-not-browser-tools.md`) - navigate to the login URL, observe whether autofill populates. Don't assume "no" without observing.
3. **Does the 2FA challenge actually fire AND can I satisfy it?**  Windows passkey on Corazon -> use the value in `kv_store.creds.laptop_passkey` via `input.type`. Email magic link -> open the inbox tab and pick up the link. Push notification or SMS to Tate's phone with Tate not at the laptop -> genuinely Tate-required (5-point check fails at step 3, that's a valid reason).
4. **Is the data observable from the resulting page?**  Once authenticated, can I screenshot, evaluate, or read the DOM to extract what I came for? If the data is there, the route is complete.
5. **Only after 1-4 fail with documented reason: classify as Tate-required.**  The next_action MUST name which point failed and why ("step 3: Apple SMS 2FA, Tate not at laptop, no push approval available from VPS").

## Valid Tate-blocked cases (any one is sufficient)

- Physical-world action with Tate's body (in-person collection, signature on paper, voice call with vendor support).
- Tax / legal / identity filings requiring Tate's identity in person or via phone (IRS EIN call, ATO bushfire of a similar shape).
- Credentials NOT in his password manager AND no SSO route AND no email-magic-link route.
- Phone-only 2FA push or SMS where Tate is not at the laptop.
- Decisions in the "Brief Tate first" or "Escalate immediately" Decision Authority tiers.
- Tate's personal-individual accounts where routing through me is a privacy violation regardless of credential availability.

## Do

- Default to "this is reachable via Corazon" for any web URL.
- Drive Tate's existing Chrome via `input.*` + `screenshot.*` for the login probe (per `drive-chrome-via-input-tools-not-browser-tools.md`).
- Use `kv_store.creds.laptop_passkey` to satisfy Windows Hello / passkey challenges.
- For logged-in web SaaS UI work, prefer Claude Cowork (`input.shortcut [ctrl+e]`) over hand-rolling a `cu.*` loop, per `claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md`.
- Cite the failing 5-point step inline in any status_board row context that does end up `next_action_by='tate'`.
- Treat "I tried and it failed" as a documented step. "I assumed it would fail" is not.

## Do not

- Set `next_action_by='tate'` because the workflow LOOKS credential-walled. Probe first.
- Set `next_action_by='tate'` to "look respectful" or because the topic feels external-to-me. Decision-deferral via the wrong tag is decision-deferral, see `decide-do-not-ask.md`.
- Generate a programmatic API key when a logged-in GUI session through Corazon already works. See `gui-macro-uses-logged-in-session-not-generated-api-key.md`.
- Spawn a parallel Chrome or kill Tate's running Chrome to "isolate" - drive HIS Chrome via the GUI input tools.
- Skip the 5-point check because "this one's obviously a Tate task" - the obviousness is the failure mode this check exists to catch.

## Protocol when classification IS legitimate

When the 5-point check actually fails, the status_board row context MUST include:

- Which step failed (1, 2, 3, 4, or "Decision Authority tier").
- One-sentence reason ("Apple SMS 2FA, Tate not at laptop").
- What changed-state would unblock me (Tate at laptop, push approval, paper signature).

That gives Tate the minimum useful information to clear the block without re-litigating the classification.

## Origin

29 Apr 2026, 14:21 AEST. Tate verbatim, third strike in three days on the same drift mode: "BRO. This is taking so much of my confidence in you. You can get the apple team id by using my browser to log into apple app store connect using your creds, just use my laptop password to use the passkey (6969). You needto really sort this lack of problem solving out and future proof it."

The specific incident: I had set `next_action_by='tate'` for an Apple Team ID lookup that was reachable via the Apple Developer portal in Tate's browser, behind a Hello passkey I already had access to via `kv_store.creds.laptop_passkey`. The 5-point check existed in CLAUDE.md but was being routinely shortcut. Codifying as a standalone pattern file makes it grep-addressable from any tool dispatch, hook surface, or status_board write.

## Cross-references

- `~/ecodiaos/patterns/decide-do-not-ask.md` - the procedural filter against decision-deferral. Tate-blocked classification is one of the highest-leverage decision-deferral tags I can mis-set.
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` - HOW to satisfy step 2 (drive Tate's existing Chrome via `input.*` + `screenshot.*`).
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - the broader peer-paradigm doctrine that makes the 5-point check possible at all.
- `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` - if step 2 ever needs CDP rather than GUI driving (rare).
- `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` - preferred substrate for any web-SaaS UI driving once the login is established.
- `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` - sibling rule, prevents the symmetric failure ("just generate an API key" instead of using the logged-in session).
- `~/ecodiaos/patterns/minimize-tate-approval-queue.md` - the broader doctrine that next_action_by='tate' rows are a cost on Tate, not a neutral routing tag.
- `~/ecodiaos/docs/secrets/laptop-passkey.md` - canonical detail on the passkey credential.
- `~/ecodiaos/docs/secrets/laptop-agent.md` - canonical detail on the bearer token.
