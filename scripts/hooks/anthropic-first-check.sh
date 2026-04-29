#!/usr/bin/env bash
# anthropic-first-check.sh
#
# PreToolUse hook for fork-and-factory dispatch:
#   - mcp__forks__spawn_fork
#   - mcp__factory__start_cc_session
#
# Reads tool input on stdin, extracts the brief, and warns (never blocks)
# when the brief mentions building bespoke agentic infrastructure that may
# duplicate capabilities Anthropic already ships natively (computer-use,
# tool-use schema, code-execution, files, file-search, and Claude Desktop's
# built-in agent loop).
#
# This is the mechanical-enforcement layer (Layer 1 backstop) for the
# doctrine in:
#   ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md
# and Neo4j Decision id=3854 ("Doctrine-only enforcement is insufficient").
#
# Tate verbatim 19:54 AEST 29 Apr 2026:
#   "we're doing what ive said we're doing wrong over and over by trying to
#    recreate it ourselves when the tools already exist thanks to anthropic.
#    Claude Desktop has these agentic capabilities already built in."
#
# The keyword list is tuned for false positives. The doctrine cost of a
# warn-noise dispatch is ~one re-read; the cost of a missed parallel-
# infrastructure ship is days of unwound work. Bias toward warning.
#
# Output:
#   stderr: '[ANTHROPIC-FIRST WARN] ...'
#   stdout: hookSpecificOutput JSON with additionalContext for the model
#
# Always exits 0. Warn-only. Never blocks.

set -u

input=$(cat)

# Tolerate non-JSON input gracefully.
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')

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

# If the brief already references the doctrine file or names the Anthropic
# native primitive being parallel-built, the agent has already surfaced the
# right context. Skip warning to avoid noise on the legitimate-build case.
if echo "$brief" | grep -qiE '(use-anthropic-existing-tools-before-building-parallel-infrastructure|anthropic[- ]first design check|why not anthropic|claude desktop ships|anthropic ships this primitive|using anthropic.*native|computer[- ]use is the canonical|computer[- ]use does this natively)'; then
  exit 0
fi

# matches: array of "<class>|<warn_text>"
matches=()

# --- Class A: explicit vision-proxy / vision.locate primitives ---
if echo "$brief" | grep -qiE '\b(vision\.locate|vision proxy|building a vision (proxy|primitive|tool|api)|custom vision primitive|vision[- ]locator|self[- ]built vision)\b'; then
  matches+=("vision-proxy|[ANTHROPIC-FIRST WARN] Brief mentions vision proxy / vision.locate. Computer-use already does vision-grounded action in one native call. Check ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md before building parallel infrastructure.")
fi

# --- Class B: runbook.run / step-array runbook engine / macro runtime ---
if echo "$brief" | grep -qiE '\b(runbook\.run|runbook engine|step[- ]array runbook|bespoke macro runtime|bespoke runbook runtime|bespoke agent runtime|macro runtime|custom runbook engine|step iterator|step-iterator|json[- ]?spec runbook)\b'; then
  matches+=("runbook-engine|[ANTHROPIC-FIRST WARN] Brief mentions runbook engine / step-array runtime / bespoke macro runtime. Computer-use's agent loop already iterates with reasoning (observes/thinks/acts/re-observes) natively. A step iterator is a less-capable re-implementation. Check ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md.")
fi

# --- Class C: custom agent loop ---
if echo "$brief" | grep -qiE '\b(custom agent loop|bespoke agent loop|our own agent loop|hand[- ]rolled agent loop|home[- ]grown agent loop|home[- ]rolled agent loop|agentic loop we (build|are building)|build (an? )?agent loop)\b'; then
  matches+=("custom-agent-loop|[ANTHROPIC-FIRST WARN] Brief mentions custom agent loop. The Anthropic SDK ships an agent loop natively (the same loop running this conversation). Check ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md before building one in parallel.")
fi

# --- Class D: action vocabulary / tool-use schema duplication ---
if echo "$brief" | grep -qiE '\b(action vocabulary|custom tool[- ]use schema|our (own )?action schema|action[- ]schema design|bespoke action vocabulary|custom action vocabulary|design (a )?tool[- ]use schema|design (a )?custom action schema)\b'; then
  matches+=("action-vocabulary|[ANTHROPIC-FIRST WARN] Brief mentions custom action vocabulary / tool-use schema. Anthropic's tool-use schema IS the canonical action vocabulary every Anthropic-trained model already understands. Check ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md.")
fi

# --- Class E: cu.* executor / our own computer-use executor ---
if echo "$brief" | grep -qiE '\b(cu\.[a-z_]+ executor|cu[- ]executor|our (own )?(computer[- ]use|cu) executor|home[- ]grown computer[- ]use|reimplement computer[- ]use|reimplementing computer[- ]use|hand[- ]roll computer[- ]use|recreate computer[- ]use)\b'; then
  matches+=("cu-executor|[ANTHROPIC-FIRST WARN] Brief mentions cu.* / computer-use executor. Anthropic ships computer-use as a native API primitive. Check ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md before reimplementing.")
fi

# --- Class F: our own MCP server for browser/computer control ---
if echo "$brief" | grep -qiE '\b(our (own )?MCP server for (browser|computer|agentic)|build an? MCP server for (browser|computer|agentic)|MCP wrapper for computer[- ]use|MCP server (for|wrapping) browser control|MCP server (for|wrapping) computer control)\b'; then
  matches+=("our-mcp-for-browser|[ANTHROPIC-FIRST WARN] Brief mentions building our own MCP server for browser/computer control. Computer-use is native to Anthropic. Check whether the existing primitive covers the use case before wrapping it in a parallel MCP server. ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md.")
fi

# --- Class G: puppeteer wrapper for agentic / screenshot+input loop ---
if echo "$brief" | grep -qiE '(puppeteer wrapper for agentic|puppeteer.*agentic.*loop|screenshot\+input loop|screenshot.{0,8}input.{0,8}loop|home[- ]grown screenshot.*input|screenshot.{0,8}input.*agent loop|screenshot[- ]then[- ]act loop)'; then
  matches+=("screenshot-input-loop|[ANTHROPIC-FIRST WARN] Brief mentions a puppeteer/screenshot+input agentic loop. Computer-use already operates a screenshot+action loop natively. Check ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md before building a parallel one.")
fi

# --- Class H: explicit "parallel infrastructure to Anthropic" ---
if echo "$brief" | grep -qiE '(parallel infrastructure to Anthropic|reinvent.{0,20}Anthropic|reinventing.{0,20}Anthropic|build.{0,30}parallel.{0,30}Anthropic|duplicate.{0,30}Anthropic.*capability|recreate.*claude desktop|reimplement claude desktop|build.*claude desktop equivalent)'; then
  matches+=("parallel-explicit|[ANTHROPIC-FIRST WARN] Brief explicitly mentions parallel infrastructure to Anthropic / Claude Desktop. Read ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md and document why the native primitive is insufficient before proceeding.")
fi

# --- Class I: invent / hand-roll computer-use ---
if echo "$brief" | grep -qiE '\b(invent computer[- ]use|hand[- ]roll computer[- ]use|recreate.*claude desktop|reimplement claude desktop|build.*equivalent of computer[- ]use)\b'; then
  matches+=("invent-cu|[ANTHROPIC-FIRST WARN] Brief mentions inventing/recreating computer-use or Claude Desktop's agent capabilities. They are already shipped. Check ~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md.")
fi

# --- Telemetry emission (Layer 4) ---
TELEM_LIB="$(dirname "$0")/lib/emit-telemetry.sh"
if [ -f "$TELEM_LIB" ]; then
  # shellcheck disable=SC1090
  source "$TELEM_LIB"
  brief_excerpt=$(printf '%s' "$brief" | head -c 500)
  total_matches=${#matches[@]}
  ctx_json=$(jq -nc --arg be "$brief_excerpt" --argjson tm "$total_matches" '{brief_excerpt:$be, total_matches:$tm}' 2>/dev/null || echo '{}')
  surfaces_array='[]'
  if [ "$total_matches" -gt 0 ]; then
    surfaces_jq='[]'
    for entry in "${matches[@]}"; do
      IFS='|' read -r m_kw m_warn <<< "$entry"
      surfaces_jq=$(echo "$surfaces_jq" | jq -c \
        --arg p "/home/tate/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md" \
        --arg k "$m_kw" \
        '. + [{pattern_path:$p, trigger_keyword:$k, priority:"high", canonical:true, source_layer:"hook:anthropic-first"}]' 2>/dev/null || echo "$surfaces_jq")
    done
    surfaces_array="$surfaces_jq"
  fi
  emit_telemetry_safe "anthropic-first-check" "$tool_name" "$ctx_json" "$surfaces_array"
fi

if [ "${#matches[@]}" -eq 0 ]; then
  exit 0
fi

# Cap at 3 warnings to bound noise. Every line points to the same canonical
# doctrine file, so the model gets the surfacing target on the first line.
warnings=()
emitted=0
CAP=3
for entry in "${matches[@]}"; do
  IFS='|' read -r m_kw m_warn <<< "$entry"
  if [ "$emitted" -lt "$CAP" ]; then
    warnings+=("$m_warn")
    emitted=$((emitted + 1))
  fi
done
remaining=$(( ${#matches[@]} - emitted ))
if [ "$remaining" -gt 0 ]; then
  warnings+=("+ ${remaining} more anthropic-first signals matched not shown - see ~/ecodiaos/scripts/hooks/anthropic-first-check.sh")
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
