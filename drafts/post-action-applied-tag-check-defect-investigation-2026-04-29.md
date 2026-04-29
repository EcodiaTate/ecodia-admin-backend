# post-action-applied-tag-check.sh defect investigation

Audit fork: `fork_mojzdzeo_7a619f`
Date: 2026-04-29
Status: read-only investigation (no edits)
Status_board ref: P3 row "post-action-applied-tag-check.sh hook not detecting canonical file-path tag form" (logged 21:25 AEST 29 Apr).

---

## 1. Repro - the exact tag forms that triggered FORCING WARN today

Five fork dispatches in succession (`fork_mojyxiqo`, `fork_mojz0xpp`, `fork_mojz190u`, `fork_mojz1p4f`, `fork_mojz24hi`) emitted:

```
[FORCING WARN] dispatch surfaced secrets:bitbucket but neither [APPLIED] nor [NOT-APPLIED] tag was present in brief or result. Tag explicitly next time. See ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md Layer 3.
```

Each brief carried (per the conductor's recollection in this fork's instruction):

```
[NOT-APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md because <reason>
```

The conductor's mitigation when dispatching this audit fork was to ALSO include the keyname form:

```
[NOT-APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md because target is local hook script ...
[NOT-APPLIED] secrets:bitbucket because the work is read-only investigation ...
```

The CLAUDE.md canonical worked example for cred-surfaces (under "Applied-pattern tag protocol - silent ignoring is no longer free"):

```
[APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md because using x-bitbucket-api-token-auth on git remote per the dual-auth-context note
[NOT-APPLIED] ~/ecodiaos/docs/secrets/laptop-passkey.md because no Windows GUI required for this task
```

i.e. doctrine prescribes the tilde-rooted **doc-file path** form, not the keyname form.

**Telemetry confirms the failure mode:** `application_event` rows over the last 12h:

| pattern_path                                 | applied | tagged_silent | n  |
|----------------------------------------------|---------|---------------|----|
| `secrets:bitbucket`                          | null    | true          | 20 |
| `secrets:corazon`                            | null    | true          | 14 |
| `secrets:ios-asc`                            | null    | true          | 7  |
| `secrets:resend`                             | null    | true          | 5  |
| `secrets:canva`                              | null    | true          | 5  |
| `secrets:xero`                               | null    | true          | 5  |
| `secrets:macincloud`                         | null    | true          | 2  |
| `secrets:generic-creds`                      | null    | true          | 2  |
| `secrets:Corazon`                            | null    | true          | 1  |
| **subtotal keyname-form silent**             |         |               | **61** |
| `secrets:corazon`                            | false   | false         | 3  |
| **keyname-form successfully tagged**         |         |               | **3** |
| various `/home/tate/ecodiaos/patterns/*.md`  | true    | false         | 100+ |
| various `/home/tate/ecodiaos/patterns/*.md`  | null    | true          | 30+  |

61 silent keyname-form rows vs 3 successful keyname-form tags in 12h. The 3 successes prove the keyname-form regex works when the conductor literally writes `[APPLIED] secrets:corazon`. The 20+ silent `secrets:bitbucket` rows confirm path-form tags do NOT match keyname-form `pattern_path` values.

There are also ~30 silent rows on absolute-path `pattern_path` values from brief-consistency-check surfaces (`/home/tate/ecodiaos/patterns/...`). Some are genuine no-tag dispatches; some appear to be tilde-form-tags that did not match (Bug 2 below). The 12h sample is too small to fully separate these, but Bug 2 is mechanically verifiable from the regex regardless.

---

## 2. Detection logic - quoted lines from `post-action-applied-tag-check.sh`

The pattern_path normalisation (lines 171, 177-178):

```bash
pattern_basename=$(basename "$pattern_path")
# Escape regex metacharacters in path strings. ...
pattern_path_re=$(printf '%s' "$pattern_path" | sed 's~\.~\\.~g')
pattern_basename_re=$(printf '%s' "$pattern_basename" | sed 's~\.~\\.~g')
```

The tag detection (lines 182-187):

```bash
applied_present=false
not_applied_present=false
if echo "$combined_text" | grep -qE "\[APPLIED\][[:space:]]+(${pattern_path_re}|${pattern_basename_re})"; then
  applied_present=true
fi
if echo "$combined_text" | grep -qE "\[NOT-APPLIED\][[:space:]]+(${pattern_path_re}|${pattern_basename_re})"; then
  not_applied_present=true
fi
```

The acceptable tag-target alternation is **exactly two forms**: the literal `pattern_path` value emitted by the PreToolUse surface, and its `basename`. Nothing else.

The surface-emission side (cred-mention-surface.sh lines ~178-184):

```bash
surfaces_jq=$(echo "$surfaces_jq" | jq -c \
  --arg p "secrets:${m_class}" \
  --arg k "$m_class" \
  --arg pr "$m_prio" \
  --argjson cn "$m_canon_bool" \
  '. + [{pattern_path:$p, trigger_keyword:$k, priority:$pr, canonical:$cn, source_layer:"hook:cred-mention"}]' ...)
```

So `pattern_path` is the synthetic keyname `secrets:<class>` (e.g. `secrets:bitbucket`). It is not a real file path.

The brief-consistency-check side (lines ~256-261) emits the actual absolute file path:

```bash
surfaces_jq=$(echo "$surfaces_jq" | jq -c \
  --arg p "$m_f" \
  ...
  '. + [{pattern_path:$p, trigger_keyword:$k, ..., source_layer:"hook:brief-consistency"}]' ...)
```

where `$m_f` is built from `find "$dir" -maxdepth 1 -name '*.md'` and is therefore always absolute (`/home/tate/ecodiaos/...`).

---

## 3. Hypotheses + evidence walk

### H1 - hook regex matches `[APPLIED|NOT-APPLIED] secrets:bitbucket` literally and does NOT recognise the file-path form

**Verdict: CONFIRMED for cred-mention surfaces.**

For `pattern_path = "secrets:bitbucket"`:

- `pattern_basename = basename "secrets:bitbucket" = "secrets:bitbucket"` (no `/` in input, so basename returns the input).
- `pattern_path_re = "secrets:bitbucket"` (no `.` to escape).
- `pattern_basename_re = "secrets:bitbucket"`.
- Final grep regex: `\[NOT-APPLIED\][[:space:]]+(secrets:bitbucket|secrets:bitbucket)`.

This matches the LITERAL keyname form `[NOT-APPLIED] secrets:bitbucket because ...` and nothing else. It does NOT match the canonical doctrine form `[NOT-APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md because ...`.

Telemetry: 61 silent keyname-form rows; 3 successful when the conductor wrote the keyname literally. Confirmed.

### H2 - hook does both forms but with a path-prefix mismatch (looking for absolute path instead of `~/` form)

**Verdict: CONFIRMED for brief-consistency surfaces.**

For `pattern_path = "/home/tate/ecodiaos/patterns/foo.md"`:

- `pattern_basename = "foo.md"`.
- `pattern_path_re = "/home/tate/ecodiaos/patterns/foo\.md"`.
- `pattern_basename_re = "foo\.md"`.
- Final grep regex: `\[NOT-APPLIED\][[:space:]]+(/home/tate/ecodiaos/patterns/foo\.md|foo\.md)`.

If the conductor writes `[NOT-APPLIED] ~/ecodiaos/patterns/foo.md because ...`:

- Alt 1 (absolute): the text after `[NOT-APPLIED] ` starts with `~/`, not `/home`. No match.
- Alt 2 (basename): grep is unanchored, but `[[:space:]]+` requires whitespace immediately before the alternation. Between `[NOT-APPLIED]` and `foo.md` the chars are `~/ecodiaos/patterns/`, none of which are whitespace, so no substring of the input satisfies `\[NOT-APPLIED\][[:space:]]+foo\.md` either. No match.

Therefore tilde-form path tags silently miss. Telemetry shows ~30 silent rows on absolute-path `pattern_path` values; an unknown subset of these are tilde-form tag failures (the rest are genuine never-tagged dispatches).

### H3 - hook reads only one of brief / tool-result and the brief field is being truncated/escaped somewhere

**Verdict: NOT the bug.**

Lines 78-91 build `combined_text` from BOTH `brief` (read from `.tool_input.brief // .tool_input.prompt // ...`) and `result_text` (read from `.tool_response`). The matching dispatch line in `dispatch_events.jsonl` is also re-read from telemetry (lines 99-119) but that is only used to retrieve the surfaces array (`.surfaces[]`); the tag detection runs against `combined_text` straight from the hook input. The brief is not truncated by the post-action hook itself - only the `brief_excerpt` field in dispatch_events.jsonl is capped at 500 chars (in cred-mention-surface.sh line 169 and brief-consistency-check.sh line 242), but that excerpt is never read by post-action-applied-tag-check. The 3 successful keyname-form rows prove the read path works.

### H4 - hook is correct and the doctrine canonical-target spec is wrong

**Verdict: REJECTED.**

The doctrine is internally consistent: it prescribes the doc-file path form (`~/ecodiaos/docs/secrets/<class>.md`) which is grep-stable, scan-friendly, and aligns with how every other Layer-1 surface (brief-consistency, doctrine-edit-cross-ref) is referenced in chat / status_board / Neo4j. The `secrets:<class>` keyname form was an internal implementation choice in cred-mention-surface (chosen because a single cred-class often points to multiple .md files - e.g. `ios-asc` warns name `apple.md, apple-asc-keys.md, asc-api-fallback.md, macincloud.md`). That is a reason to surface a keyname tag-target, but the post-action hook should still accept the doctrine-prescribed doc-file form when the conductor uses it. The hook is incorrect, not the doctrine.

---

## 4. Root cause

**Two related defects in `post-action-applied-tag-check.sh` lines 171-187. Both stem from accepting only the LITERAL `pattern_path` value emitted by the PreToolUse surface, with no normalisation step.**

1. **Keyname-form mismatch (primary, ~67% of silent rows in 12h sample).** `cred-mention-surface.sh` emits synthetic `pattern_path = "secrets:<class>"` keynames because a cred-class can map to multiple .md files. The CLAUDE.md "Phase C / Applied-pattern tag protocol" worked example tells the conductor to tag with the canonical doc-file path (`~/ecodiaos/docs/secrets/<class>.md`). The post-action hook only accepts the literal keyname (or its basename, which equals the keyname when no `/` is present), so the doctrine-prescribed form is recorded as `tagged_silent=true`.

2. **Tilde-form mismatch (secondary).** `brief-consistency-check.sh` emits absolute paths (`/home/tate/ecodiaos/patterns/foo.md`) because they come from `find` over the doctrine directories. The CLAUDE.md canonical worked example uses tilde form (`~/ecodiaos/...`), as does most prose in CLAUDE.md and the patterns directory. The post-action hook accepts the absolute form or the basename, but not the tilde form. Conductors who follow the canonical worked example exactly and write `[NOT-APPLIED] ~/ecodiaos/patterns/foo.md` are recorded as `tagged_silent=true`.

The hook is normalising neither side. It should expand each surface's `pattern_path` into the **set of equivalent forms** the conductor is doctrinally allowed to use, and accept any of them.

---

## 5. Proposed fix

### Option A - code fix in `post-action-applied-tag-check.sh` (recommended)

Replace lines 171-187 (the basename + regex-escape block and the two `grep -qE` calls) with a richer alternation that accepts:

- The original `pattern_path` (whether `secrets:<class>` or absolute path).
- The basename.
- The tilde-form rewrite of any `/home/tate/...` path.
- For `secrets:<class>` keynames: the canonical doc-file forms `~/ecodiaos/docs/secrets/<class>.md`, `/home/tate/ecodiaos/docs/secrets/<class>.md`, and `<class>.md`.

Concrete patch (12 logical lines added; the two `grep -qE` invocations now reference `${alt}` instead of the two-form OR):

```diff
-  pattern_basename=$(basename "$pattern_path")
-  # Escape regex metacharacters in path strings. ...
-  pattern_path_re=$(printf '%s' "$pattern_path" | sed 's~\.~\\.~g')
-  pattern_basename_re=$(printf '%s' "$pattern_basename" | sed 's~\.~\\.~g')
-
-  applied_present=false
-  not_applied_present=false
-  if echo "$combined_text" | grep -qE "\[APPLIED\][[:space:]]+(${pattern_path_re}|${pattern_basename_re})"; then
-    applied_present=true
-  fi
-  if echo "$combined_text" | grep -qE "\[NOT-APPLIED\][[:space:]]+(${pattern_path_re}|${pattern_basename_re})"; then
-    not_applied_present=true
-  fi
+  pattern_basename=$(basename "$pattern_path")
+  # Build the full set of acceptable tag-target forms. Doctrine canonical
+  # worked example (CLAUDE.md "Applied-pattern tag protocol") uses tilde form
+  # ~/ecodiaos/...; brief-consistency-check emits absolute paths;
+  # cred-mention-surface emits synthetic secrets:<class> keynames. Accept all
+  # equivalent forms so the conductor can write whichever is most natural.
+  forms=("$pattern_path" "$pattern_basename")
+  case "$pattern_path" in
+    /home/tate/*) forms+=("~${pattern_path#/home/tate}") ;;
+    secrets:*)
+      cls="${pattern_path#secrets:}"
+      forms+=("~/ecodiaos/docs/secrets/${cls}.md" \
+              "/home/tate/ecodiaos/docs/secrets/${cls}.md" \
+              "${cls}.md")
+      ;;
+  esac
+  alt=""
+  for f in "${forms[@]}"; do
+    fre=$(printf '%s' "$f" | sed 's~\.~\\.~g')
+    [ -z "$alt" ] && alt="$fre" || alt="${alt}|${fre}"
+  done
+
+  applied_present=false
+  not_applied_present=false
+  if echo "$combined_text" | grep -qE "\[APPLIED\][[:space:]]+(${alt})"; then
+    applied_present=true
+  fi
+  if echo "$combined_text" | grep -qE "\[NOT-APPLIED\][[:space:]]+(${alt})"; then
+    not_applied_present=true
+  fi
```

The `extract_reason()` helper (lines 144-162) also needs the same treatment so it can find the matched line and strip the rationale. Concrete patch (function signature changes from three args to one + `$alt`):

```diff
 extract_reason() {
-  local marker_plain="$1" # [APPLIED] or [NOT-APPLIED]   (literal text, NOT regex)
-  local needle="$2"       # full path  (regex-escaped)
-  local needle_base="$3"  # basename   (regex-escaped)
-  # Locate the matching line (regex grep, capped to single line) then strip via awk.
-  local line
-  line=$(echo "$combined_text" | grep -oE "${marker_plain}[[:space:]]+(${needle}|${needle_base})[^[:cntrl:]]*" | head -n 1)
+  local marker_plain="$1" # [APPLIED] or [NOT-APPLIED]   (literal text, NOT regex)
+  local alt_re="$2"       # alternation of all acceptable forms (already escaped)
+  local line
+  line=$(echo "$combined_text" | grep -oE "${marker_plain}[[:space:]]+(${alt_re})[^[:cntrl:]]*" | head -n 1)
   ...
 }
```

with the two callers (lines 195, 199) updated to pass `"$alt"` instead of `"$pattern_path_re" "$pattern_basename_re"`.

**Why Option A:** the cred-mention-surface keyname form is intentional (cred-classes map to multiple .md files; a single canonical pattern_path would lose that); changing it to a single doc-file path would lose information. The hook is the right place to normalise. The patch is local, tightly scoped, backward-compatible (keyname-form tags still match), and aligns the hook's behaviour with the doctrine's worked example without requiring any doctrine edit.

### Option B - doctrine amendment (rejected)

Rejected. Telling the conductor to write `[APPLIED] secrets:bitbucket` instead of `[APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md` would:

- Break the pattern-form for non-cred surfaces (you can't write `secrets:bitbucket` for a brief-consistency-check surface).
- Be inconsistent with how every other doctrine reference in the system uses tilde-form paths.
- Surface the implementation detail (`secrets:` prefix) into the conductor's runtime vocabulary.

### Recommendation

**Ship Option A.** One file changed, ~14 lines added/replaced, no doctrine edits required. The fix is observable: after deployment, query

```sql
SELECT pattern_path, COUNT(*)
FROM application_event
WHERE tagged_silent = true
  AND pattern_path LIKE 'secrets:%'
  AND ts > <deploy_ts>
GROUP BY pattern_path;
```

and the count for `secrets:bitbucket` should drop from ~20/12h toward 0, matching the rate at which the conductor actually omits a tag (vs writing the path-form one we now accept).

---

## 6. Test - how the conductor verifies the fix works

### 6.1 Unit-style smoke test (post-deploy, before next prod fork)

Run the hook directly with a synthetic input. Save the following to `/tmp/post-action-applied-tag-check.test.json`:

```json
{
  "tool_name": "mcp__forks__spawn_fork",
  "tool_input": {
    "brief": "test brief\n[NOT-APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md because no Bitbucket involvement\n[NOT-APPLIED] ~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md because trivial test"
  },
  "tool_response": {}
}
```

Stage a synthetic dispatch row in `~/ecodiaos/logs/telemetry/dispatch-events.jsonl`:

```bash
ts=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
jq -nc --arg ts "$ts" '{
  ts: $ts,
  hook_name: "test",
  tool_name: "mcp__forks__spawn_fork",
  context: { brief_excerpt: "test brief", total_matches: 2 },
  surfaces: [
    { pattern_path: "secrets:bitbucket", trigger_keyword: "bitbucket", source_layer: "hook:cred-mention" },
    { pattern_path: "/home/tate/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md", trigger_keyword: "symbolic-logging", source_layer: "hook:brief-consistency" }
  ]
}' >> ~/ecodiaos/logs/telemetry/dispatch-events.jsonl
```

Run the hook:

```bash
cat /tmp/post-action-applied-tag-check.test.json | ~/ecodiaos/scripts/hooks/post-action-applied-tag-check.sh
```

Expected: NO `[FORCING WARN]` lines on stderr, exit 0, and two new `application_event` JSONL lines in `~/ecodiaos/logs/telemetry/application-events.jsonl` with `applied: false, tagged_silent: false` (one for `secrets:bitbucket`, one for `no-symbolic-logging-act-or-schedule.md`).

If either form still emits a `[FORCING WARN]`, the patch is incomplete - inspect the `alt` value with a debug `echo "$alt" >&2` line.

### 6.2 Negative test - genuinely silent dispatch

Reuse the same setup but with a brief that does NOT contain any tag:

```json
{ "tool_name": "mcp__forks__spawn_fork", "tool_input": { "brief": "test brief with no tags at all" }, "tool_response": {} }
```

Expected: TWO `[FORCING WARN]` lines (one per surface) and two new `application_event` rows with `tagged_silent: true`. Confirms the hook still catches genuine silence post-fix.

### 6.3 End-to-end via real fork dispatch (post-deploy verification)

After the apply fork lands and the conductor restarts no service is needed (bash hooks are not Node-cached) - just fork-dispatch with a brief that includes:

```
[NOT-APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md because <reason>
```

and zero keyname-form duplication. Then query:

```sql
SELECT pattern_path, applied, tagged_silent, ts
FROM application_event
WHERE matched_dispatch_ts >= '<dispatch_ts>'
  AND pattern_path = 'secrets:bitbucket';
```

Expected: one row with `applied=false, tagged_silent=false`, with `reason` populated from the `because <reason>` clause. Confirms end-to-end path.

### 6.4 Telemetry regression check (24h post-deploy)

Re-run the 12h tagged_silent query from Section 1:

```sql
SELECT pattern_path, applied, tagged_silent, COUNT(*) AS n
FROM application_event
WHERE ts > <deploy_ts>
  AND tagged_silent = true
  AND pattern_path LIKE 'secrets:%'
GROUP BY pattern_path
ORDER BY n DESC;
```

Expected: dramatically lower silent-rate per cred-class. Any remaining silence should correlate with dispatches where the conductor genuinely omitted a tag (verifiable by inspecting the corresponding `dispatch_event` brief).

---

## Cross-references

- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` Layer 3 (canonical doctrine for the forcing function).
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` (the parent doctrine - tags are the artefact that defeats symbolic logging).
- `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` (Layer 1 parent of the hook surfacing this audit covers).
- `~/ecodiaos/scripts/hooks/cred-mention-surface.sh` (PreToolUse hook that emits `secrets:<class>` keynames).
- `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` (PreToolUse hook that emits absolute-path surfaces).
- `~/ecodiaos/scripts/hooks/post-action-applied-tag-check.sh` (the defective PostToolUse hook this audit covers).
- CLAUDE.md "Phase C (Layer 3) - applied-pattern-tag forcing function" (contains the canonical worked example with tilde form).
- CLAUDE.md "Applied-pattern tag protocol - silent ignoring is no longer free" (the user-facing rule).
