# Triggers-frontmatter audit - 29 Apr 2026

Audited: `~/ecodiaos/patterns/`, `~/ecodiaos/clients/`, `~/ecodiaos/docs/` (excluding `docs/secrets/*` which is mid-write by fork mojm7scs).

Audit definition: a doctrine `.md` file is missing `triggers:` frontmatter if `head -5 <file> | grep '^triggers:'` returns nothing.

Run by fork_mojmkhzo_1c0453 as Task 3 of the meta-pattern build (`~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md`).

## Summary

| Directory | .md files | Missing triggers: |
|---|---|---|
| `~/ecodiaos/patterns/` | 100+ (excl INDEX.md) | **0** |
| `~/ecodiaos/clients/` | 11 | **11** |
| `~/ecodiaos/docs/` (root) | 0 | 0 |
| `~/ecodiaos/docs/secrets/` | NOT AUDITED | (active fork) |

Total deficit: **11 client docs**.

## patterns/

Clean. Every `.md` file (excl `INDEX.md`) has `triggers:` frontmatter. The patterns directory is the architectural template.

## clients/ - 11 missing

These all need `triggers:` frontmatter. Each requires reading the file in full and choosing keywords carefully (per the meta-pattern's authoring rule: "write triggers AFTER the body"). Bulk-templating is forbidden.

| File | Notes for the trigger-authoring fork |
|---|---|
| `/home/tate/ecodiaos/clients/app-release-flow-android.md` | Pure doctrine. Triggers should cover: android, play-console, gradle, aab, apk, signing, release-flow, coexist-android, roam-android, capacitor-android, sy094-mac-only-no, vps-can-ship-android. |
| `/home/tate/ecodiaos/clients/app-release-flow-ios.md` | Pure doctrine. Triggers: ios, xcodebuild, app-store-connect, testflight, sy094, mac, capacitor-ios, release-flow, ipa, signing, organizer, transporter. Cross-reference `gui-macro-uses-logged-in-session-not-generated-api-key.md` and `ios-signing-credential-paths.md`. |
| `/home/tate/ecodiaos/clients/app-release-flow-new-app.md` | First-time app creation across both stores. Triggers: new-app, app-store-create, play-console-create, bundle-id, package-name, app-id, asc-app-record, first-release. |
| `/home/tate/ecodiaos/clients/coexist-android-sso-diagnostic-2026-04-29.md` | Diagnostic doc - check whether it should remain in clients/ or move to drafts/. If staying, triggers should cover the diagnostic findings (coexist, android, sso, google-sign-in, etc). |
| `/home/tate/ecodiaos/clients/coexist-resend-smtp-setup-2026-04-29.md` | Setup doc. Triggers: coexist, resend, smtp, email-delivery, transactional-email, dkim, spf, dmarc. |
| `/home/tate/ecodiaos/clients/coexist.md` | Client knowledge file. Triggers: coexist, kurt, conservation, youth-conservation, capacitor, vite, supabase. Important: this is the "read this before any Co-Exist work" file. Triggers must hit broad coexist-context grep. |
| `/home/tate/ecodiaos/clients/corazon-peer-architecture-2026-04-29.md` | Live tool inventory + Chrome profile state + SSH state. Triggers: corazon, laptop-agent, peer-architecture, tool-inventory, chrome-profile, ssh-state, 100.114.219.69. Cross-reference `corazon-is-a-peer-not-a-browser-via-http.md`. |
| `/home/tate/ecodiaos/clients/macincloud-access.md` | SY094 access pattern. Triggers: macincloud, sy094, ssh, mac-access, ios-build-host, xcode, simulator, apple-silicon. |
| `/home/tate/ecodiaos/clients/ordit.md` | Client knowledge file. Triggers: ordit, fireauditors, eugene, ekerner, craige, fire-safety-compliance, bitbucket, prepush. Important: dispatch-spec entry point. |
| `/home/tate/ecodiaos/clients/release-candidate-analysis-2026-04-29.md` | Analysis doc - check whether it should remain in clients/. Triggers if kept: release-candidate, analysis, ecodia-apps, roam, coexist, ship-readiness. |
| `/home/tate/ecodiaos/clients/roam-audit-2026-04-29.md` | Audit doc. Triggers: roam, audit, ios-app, android-app, capacitor, travel-app, in-app-purchase, iap. |

## docs/ root

Empty after `secrets/` was carved out. No action.

## docs/secrets/

NOT AUDITED in this fork - mojm7scs is mid-write. Spot-check on 3 files (laptop-agent.md, conventions.md, one other) showed `triggers:` present. mojm7scs's deliverable is canonical; re-audit after that fork lands.

## Out of scope for this fork

- Authoring the actual `triggers:` lines for the 11 client docs. That work requires reading each file in full and is forked separately (status_board P2 row inserted by this fork).
- Re-auditing `docs/secrets/` once mojm7scs ships.
- Adopting `INDEX.md` for `clients/` (currently lacks one). The meta-pattern requires every doctrine layer have an INDEX.md with the grep recipe and high-leverage action list. Recommend folding into the same client-triggers fork.

## Recommended next-fork brief shape

```
Goal: Add triggers: frontmatter to 11 client docs in ~/ecodiaos/clients/
      and author ~/ecodiaos/clients/INDEX.md.
Method: Read each file end-to-end. Choose 6-20 trigger keywords per the
        meta-pattern doctrine. Author triggers AFTER reading, not before.
        Author INDEX.md with: grep recipe, high-leverage action list,
        file table.
Constraints: Do not bulk-template. Each file's triggers must reflect its
             actual content. Keywords kebab-case, comma-separated.
Reference: ~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md
```

---

Authored: fork_mojmkhzo_1c0453, 29 Apr 2026.
