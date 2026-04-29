#!/usr/bin/env bash
# cred-mention-surface.sh
#
# PreToolUse hook for mcp__forks__spawn_fork and mcp__factory__start_cc_session.
# Reads tool input on stdin, scans the brief for cred-keyword signals, and
# warns (never blocks) when a brief mentions credential-related work but does
# not reference the secrets registry at ~/ecodiaos/docs/secrets/.
#
# Surfaces:
#   ~/ecodiaos/docs/secrets/INDEX.md
#   ~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md
#
# Output:
#   stderr: '[CRED-SURFACE WARN] brief mentions <keyword>, no secrets/ ref'
#   stdout: hookSpecificOutput JSON with additionalContext for the model
#
# Always exits 0. Warn-only.

set -u

input=$(cat)

# Tolerate non-JSON input gracefully.
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# The brief lives in different fields depending on the tool. Try the common ones.
brief=$(echo "$input" | jq -r '
  .tool_input.brief
  // .tool_input.prompt
  // .tool_input.message
  // .tool_input.task
  // empty
')

if [ -z "$brief" ] || [ "$brief" = "null" ]; then
  exit 0
fi

# If the brief already references the secrets registry, the agent has surfaced
# the right context. Skip warning.
if echo "$brief" | grep -qiE '(docs/secrets/|secrets-registry|secrets/INDEX\.md|/secrets/[a-z0-9_-]+\.md)'; then
  exit 0
fi

warnings=()

# --- High-leverage cred-keyword groups ---
# Each group maps a category of work to the secrets/ files it should surface.

# iOS / TestFlight / App Store Connect
if echo "$brief" | grep -qiE '\b(ios|testflight|app store connect|\basc\b|xcodebuild|transporter|altool|fastlane|ipa|provisioning profile|signing identity|developer\.apple\.com|appstoreconnect|team_id|p8 file|asc api key)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions iOS / ASC / TestFlight work but does not reference ~/ecodiaos/docs/secrets/. Read: apple.md, apple-asc-keys.md, asc-api-fallback.md, macincloud.md before dispatching. The GUI-macro doctrine in ~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md says Apple uploads use the macro path, NOT the API-key path.")
fi

# Android / Play Console / keystore
if echo "$brief" | grep -qiE '\b(android|play console|google play|keystore|\.jks|aab|fastlane supply|gradle.*sign|upload key|coexist[- ]?android|roam[- ]?android)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Android / Play Console work but does not reference ~/ecodiaos/docs/secrets/. Read: _pending-android-keystores.md, _pending-google-play-service-account.md before dispatching. Keystores are PENDING (NEEDS-TATE) and the Play SA is DEMOTED to fallback under the GUI-macro doctrine.")
fi

# Bitbucket / Ordit / git push to fireauditors1
if echo "$brief" | grep -qiE '\b(bitbucket|fireauditors1|fireauditors|ordit.*push|ATATT|atlassian.*token|api\.bitbucket\.org)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Bitbucket / Ordit work but does not reference ~/ecodiaos/docs/secrets/. Read: bitbucket.md before dispatching. Note the two-context auth split (git remote uses x-bitbucket-api-token-auth username; REST API uses code@ecodia.au).")
fi

# Supabase Management / Edge Function deploy
if echo "$brief" | grep -qiE '\b(supabase.*deploy|edge function deploy|npx supabase functions|sbp_|supabase access token|supabase management api)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Supabase Management / Edge Function deploy but does not reference ~/ecodiaos/docs/secrets/. Read: supabase-access-token.md before dispatching.")
fi

# Co-Exist Graph API / Microsoft Graph / excel-sync
if echo "$brief" | grep -qiE '\b(coexist[- ]?graph|microsoft graph|graph api|entra|azure ad|excel-sync|excel sync|coexistaus\.org|client_secret.*tenant)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Microsoft Graph / Co-Exist excel-sync work but does not reference ~/ecodiaos/docs/secrets/. Read: coexist-graph-api.md, coexist-excel-file.md, coexist-supabase.md before dispatching.")
fi

# MacInCloud / SY094 / Mac SSH
if echo "$brief" | grep -qiE '\b(macincloud|sy094|sshpass.*mac|ssh.*mac|mac.*ssh|user276189|MacInCloud\.com)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions MacInCloud / SY094 / Mac SSH work but does not reference ~/ecodiaos/docs/secrets/. Read: macincloud.md before dispatching. Note: MacInCloud auto-rotates passwords on certain panel events; if SSH fails with Permission denied, the password is stale.")
fi

# Corazon laptop agent / Tailscale / browser.* / screenshot.*
if echo "$brief" | grep -qiE '\b(corazon|laptop[- ]?agent|tailscale|100\.114\.219\.69|eos-laptop-agent|/api/tool|browser\.enableCDP|screenshot\.screenshot|input\.click|input\.type)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Corazon / laptop-agent work but does not reference ~/ecodiaos/docs/secrets/. Read: laptop-agent.md, laptop-passkey.md before dispatching. The 5-point check (~/CLAUDE.md 'Tate-blocked is a last resort') uses laptop_passkey to clear Windows Hello prompts.")
fi

# Resend / transactional email
if echo "$brief" | grep -qiE '\b(resend\.com|resend api|re_[a-z0-9]|transactional email|smtp.*setup|coexist.*email)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Resend / transactional email work but does not reference ~/ecodiaos/docs/secrets/. Read: resend.md before dispatching.")
fi

# Canva / design automation
if echo "$brief" | grep -qiE '\b(canva|canva connect|canva api|design automation|brand asset)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Canva work but does not reference ~/ecodiaos/docs/secrets/. Read: canva-connect-api.md, canva-mfa-backup-codes.md before dispatching.")
fi

# Xero
if echo "$brief" | grep -qiE '\b(xero\.com|xero api|xero login|xero org|xero dashboard|xero category)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions Xero work but does not reference ~/ecodiaos/docs/secrets/. Read: xero-code-login.md before dispatching. Note: bookkeeping MCP uses a separate OAuth integration not held in kv_store today.")
fi

# RevenueCat / IAP
if echo "$brief" | grep -qiE '\b(revenuecat|iap|in-app purchase|subscription paywall|roam[- ]?iap)\b'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief mentions IAP / RevenueCat work but does not reference ~/ecodiaos/docs/secrets/. Read: _pending-revenuecat.md before dispatching.")
fi

# Generic 'creds.*' mention without registry ref
if echo "$brief" | grep -qiE 'creds\.[a-z_][a-z_0-9.]+'; then
  warnings+=("[CRED-SURFACE WARN] ${tool_name} brief references kv_store creds.* keys directly but does not consult ~/ecodiaos/docs/secrets/INDEX.md. The registry catalogues all 24+ creds with their schemas, classes (gui-macro-replaces vs programmatic-required), rotation cadence, and drift status. Grep ~/ecodiaos/docs/secrets/ for trigger keywords matching the workflow before authoring the brief.")
fi

# --- Telemetry emission (Layer 4) ---
# Each [CRED-SURFACE WARN] line is one logical surface event. We extract the
# cred-class keyword and emit one surface entry per warning. The warnings
# already cite the secrets/ files by name in their text; the consumer can
# normalise by cred class.
TELEM_LIB="$(dirname "$0")/lib/emit-telemetry.sh"
if [ -f "$TELEM_LIB" ]; then
  # shellcheck disable=SC1090
  source "$TELEM_LIB"
  brief_excerpt=$(printf '%s' "$brief" | head -c 500)
  ctx_json=$(jq -nc --arg be "$brief_excerpt" '{brief_excerpt:$be}' 2>/dev/null || echo '{}')
  surfaces_array='[]'
  if [ "${#warnings[@]}" -gt 0 ]; then
    surfaces_jq='[]'
    for w in "${warnings[@]}"; do
      # Extract cred class from the warn (the last word before "work" usually,
      # but we just use the whole warn excerpt as the trigger_keyword for now).
      kw=$(echo "$w" | grep -oE 'mentions [^[:space:]]+( /[^[:space:]]+)?' | head -1 | sed -E 's/^mentions //')
      [ -z "$kw" ] && kw="cred-class"
      # Pick a reasonable pattern_path; many warns point at multiple files,
      # surface the warn text itself as the pattern_path marker (consumer
      # uses pattern_path = "secrets/<class>" since we don't always have a
      # single file).
      surfaces_jq=$(echo "$surfaces_jq" | jq -c \
        --arg p "secrets:${kw}" \
        --arg k "$kw" \
        '. + [{pattern_path:$p, trigger_keyword:$k, source_layer:"hook:cred-mention"}]' 2>/dev/null || echo "$surfaces_jq")
    done
    surfaces_array="$surfaces_jq"
  fi
  emit_telemetry_safe "cred-mention-surface" "$tool_name" "$ctx_json" "$surfaces_array"
fi

if [ "${#warnings[@]}" -eq 0 ]; then
  exit 0
fi

ctx=""
for w in "${warnings[@]}"; do
  echo "$w" >&2
  if [ -z "$ctx" ]; then
    ctx="$w"
  else
    ctx="${ctx}
${w}"
  fi
done

jq -n --arg ctx "$ctx" '{hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$ctx}}'

exit 0
