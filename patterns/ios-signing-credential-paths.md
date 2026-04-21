---
triggers: ios, xcodebuild, code-signing, provisioning-profile, app-store, asc-api-key, testflight, mac, sy094, exportarchive, manual-signing
---

# iOS ship pipeline blocks on signing credentials - pick one of three unblock paths in this order

## The rule

When an autonomous iOS build/archive/upload pipeline hits a signing error on SY094 (or any Mac that does not have an active Xcode login), there are exactly three viable unblock paths. Rank them this way:

1. **App Store Connect API key (.p8 + Key ID + Issuer ID)** - preferred. Fully autonomous, no GUI, rotatable, narrow scope, survives account password changes. Once dropped on the Mac, `xcodebuild -allowProvisioningUpdates` + `altool`/`notarytool` work end-to-end without interaction.
2. **One-time Xcode login on the Mac** - easiest if someone can touch the GUI once. Open Xcode, sign into the Apple ID with app-specific password or 2FA, let Xcode manage signing. Session persists. Works until the Apple ID does a forced re-auth, then it breaks silently.
3. **Manual provisioning profile drop** - one-shot. Download a specific `.mobileprovision` + `.cer/.p12` from the Apple Developer portal, drop into `~/Library/MobileDevice/Provisioning Profiles/` and Keychain. Works for exactly one bundle-id/team/expiry combination, then expires and you have to do it again.

**Do not try to combine these.** Pick one path, land it, document which path is live in `clients/{slug}.md`. If a future build fails, you want to know immediately which credential surface to check.

## Why rank this way

Autonomy is the whole point of the laptop-agent setup. Path 1 preserves it. Path 2 trades autonomy for a one-time GUI touch and is fine when a human is willing to do that once (and will not be re-prompted silently). Path 3 is the "unblock this single build right now" answer; it does not scale and the expiry will catch you out.

Important: `xcodebuild -allowProvisioningUpdates` only works when Xcode has either (a) an active Apple ID login with Developer team access, or (b) an ASC API key in `~/Library/MobileDevice/Provisioning Profiles/` OR passed via `-authenticationKeyPath -authenticationKeyID -authenticationKeyIssuerID`. With neither, you get the opaque `No Accounts` / `No profiles for 'com.example.app' were found` error even though the cert + profile exist on disk.

## Protocol - ASC API key path (path 1)

1. On App Store Connect: Users and Access → Keys → + → name it `ecodia-ci` or similar, scope `Developer` (App Manager is overkill). Download the `.p8` file (you only get to download it ONCE). Record the Key ID (10-char) and Issuer ID (UUID).
2. Store on VPS kv_store:
   ```
   creds.asc_api_key_p8 = <full .p8 file contents including BEGIN/END lines>
   creds.asc_api_key_id = <10-char Key ID>
   creds.asc_api_issuer_id = <UUID Issuer ID>
   ```
3. On the Mac, stage the key at the canonical location:
   ```
   mkdir -p ~/.appstoreconnect/private_keys
   echo "$P8" > ~/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8
   chmod 600 ~/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8
   ```
4. Test with a read-only API call first:
   ```
   xcrun altool --list-providers --apiKey <KeyID> --apiIssuer <IssuerID>
   ```
   If this returns your team, signing is wired. If it 401s, the key is wrong or unscoped.
5. Build with `-allowProvisioningUpdates` (Xcode auto-detects the key from `~/.appstoreconnect/private_keys/`):
   ```
   xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
     -archivePath build/App.xcarchive archive -allowProvisioningUpdates
   xcodebuild -exportArchive -archivePath build/App.xcarchive \
     -exportOptionsPlist ExportOptions.plist -exportPath build/export \
     -allowProvisioningUpdates
   xcrun altool --upload-app --file build/export/App.ipa --type ios \
     --apiKey <KeyID> --apiIssuer <IssuerID>
   ```
6. Record in `clients/{slug}.md`: which Mac has the key, Key ID (not the .p8), issuer ID, date added.

## Protocol - Xcode login path (path 2)

1. Get the human to the Mac GUI (VNC, screen share, or in person).
2. Open Xcode → Settings → Accounts → + → Apple ID → sign in with the Apple ID that has Developer team membership. 2FA or app-specific password.
3. Select the Team, click `Download Manual Profiles`.
4. Close Xcode cleanly. Do not sign out.
5. Signing now works headlessly until the session expires or the password rotates. If a build later fails with `No Accounts`, the session died and someone has to log back in.

This path is fine for single-developer teams where the same human will be present within a day of any failure. It is NOT fine for fully autonomous pipelines.

## Protocol - Manual profile drop (path 3)

Use only when you need to ship ONE build right now and paths 1-2 are not possible.

1. Developer portal → Certificates, IDs and Profiles → Profiles → find or create a distribution profile for the bundle-id. Download the `.mobileprovision`.
2. Certificates → find the distribution `.cer`, download and import into Keychain. If you do not have the `.p12` (private key), you cannot use this certificate - you need the Mac that originally generated it, or revoke and regenerate.
3. On the target Mac:
   ```
   cp ~/Downloads/App.mobileprovision ~/Library/MobileDevice/Provisioning\ Profiles/
   # Keychain: double-click the .cer/.p12 to import
   ```
4. In the project, set `CODE_SIGN_STYLE=Manual`, `PROVISIONING_PROFILE_SPECIFIER=<exact profile name>`, `DEVELOPMENT_TEAM=<TeamID>`.
5. Build WITHOUT `-allowProvisioningUpdates` (that flag tries to fetch from Apple and will fail without account access):
   ```
   xcodebuild ... archive   # no -allowProvisioningUpdates
   ```
6. Profile expires in 12 months. Set a calendar reminder 30 days before expiry to redo this or migrate to path 1.

## Do

- Pick path 1 by default for any new client iOS engagement.
- Record which path is live in `clients/{slug}.md` with Key ID / Xcode-login-date / profile-expiry.
- Test the credential with a read-only API call (`altool --list-providers`) BEFORE kicking a 20-minute archive build.
- Schedule a 30-days-before-expiry reminder in `status_board` when the active path has a known expiry (paths 2 and 3).

## Do NOT

- Commit a `.p8` file to git. Store in kv_store, stage on-disk at build time, gitignore the target dir.
- Mix paths in a single build. Switching from Xcode-login to ASC API key mid-build produces opaque errors.
- Use `-allowProvisioningUpdates` on path 3. The flag tries to contact Apple servers and fails without an account.
- Assume a working session persists forever. Re-test the credential surface after every macOS update, every Xcode update, every team membership change.

## Origin

2026-04-21, Co-Exist iOS App Store submission pipeline. SY094 had the repo, Xcode 26.3, the archive build was ready. But no Apple ID session on the Mac (fresh MacInCloud instance, no `~/Library/Developer/Xcode/UserData` artefacts from a prior login). `xcodebuild ... archive -allowProvisioningUpdates` failed with the `No Accounts` error. All three unblock paths above were identified and emailed to Tate for his choice. Pipeline stayed blocked pending his decision; this pattern file exists so the next session faces the same situation with a pre-ranked answer and does not re-derive the options from scratch.

Related: `ios-signing-reconcile` task cancelled same day because the reconciliation itself did not matter until the credential surface existed.
