---
triggers: apple, ios, app store connect, asc, team_id, xcodebuild, transporter, developer.apple.com, apple-membership, apple-account, ios-release, ipa, ios-signing, DEVELOPMENT_TEAM
class: gui-macro-replaces
owner: ecodiaos
---

# creds.apple

Apple Developer identity row for the Ecodia account. Holds `team_id` (10-char, used as `DEVELOPMENT_TEAM` in `xcodebuild`), `account_email`, `account_name`, `team_name`, and macro-fetch metadata. Without it, every iOS build halts at preflight because xcodebuild cannot resolve which team to sign for.

## Source

developer.apple.com / appstoreconnect.apple.com > Membership page (signed in as `code@ecodia.au` - this is the canonical sign-in identity for the Apple Developer / ASC account; `apple@ecodia.au` is a separate ASC tester-account faux email, NOT a real mailbox and NOT used for sign-in). Fetched via Corazon Chrome `input.*` + `screenshot.screenshot` macro on 29 Apr 2026.

## Shape

object `{account_email, account_name, team_id, team_name, fetched_at, fetched_by_fork, fetched_via, screenshot}`

## Used by

- `~/ecodiaos/scripts/release.sh` (iOS branch reads `team_id`)
- `~/ecodiaos/clients/app-release-flow-ios.md`
- `~/ecodiaos/clients/app-release-flow-new-app.md`

## Replaceable by macro?

Yes - the row was POPULATED by macro and can be re-fetched any time the team_id changes (rare-to-never). The macro path through Tate's logged-in Chrome on Corazon supersedes any programmatic Apple-API path.

## Rotation

On-demand. Re-fetch via macro if `team_id` ever changes; otherwise never.

## Restoration if lost

1. Corazon: `browser.enableCDP` if not already attached, navigate to https://developer.apple.com/account
2. Take a `screenshot.screenshot` of the Membership page; team_id is the 10-char string under "Team ID"
3. UPSERT `creds.apple` with new fields

Doctrine: `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` (the parent rule that says skip-the-API-key when GUI works).
