---
triggers: anthropic, computer-use, claude-desktop, parallel-infrastructure, reinventing, native-tools, sdk-first, before-building, vision-proxy, agent-loop, primitive-design, anthropic-sdk, tool-use-schema, runbook-engine, action-vocabulary, custom-agent-loop, reinvent-anthropic, build-vs-use
---

# Use Anthropic's existing tools before building parallel infrastructure

Before designing a new primitive layer (vision proxy, agent runtime, action vocabulary, runbook engine, custom tool-use schema), check whether Anthropic already provides a tool that does the same thing. If yes, use it. If no, document why before building. Parallel infrastructure to capabilities Anthropic already ships is wasted engineering disguised as progress.

The failure mode: structured JSON specs and bespoke agent loops feel like progress because they produce visible artefacts. Files appear, schemas land, INSERTs run, tooling looks "real". But duplication of capabilities Anthropic already ships in the SDK / Claude Desktop / computer-use API is not building - it is shadow-building. The artefacts make the engineering look real; the duplication makes the engineering wasted. The model that exposes these primitives is the same model running this conversation. Reaching for a custom-built parallel when Anthropic ships the native version is a category error about what Anthropic IS.

This is a recurring pattern Tate has flagged before. Each instance produces more polished artefacts than the last (a vision proxy looks more "designed" than ad-hoc curl calls; a runbook engine looks more "engineered" than natural-language briefs), which makes the failure mode harder to spot at a glance and easier to mistake for technical maturity.

## Do

- DO read the Anthropic SDK / API docs BEFORE designing any primitive that smells like an agent capability (vision, action, planning, replay, retry, observation, tool routing).
- DO check `claude-3-5-sonnet`'s tool surface (computer-use, code-execution, file-search, etc) for the capability before reinventing it.
- DO check the Claude Desktop announcement / docs for what it can already drive autonomously (it ships with computer-use built in).
- DO write a one-paragraph "why not Anthropic's X" justification BEFORE shipping parallel infrastructure. If the justification is "I didn't check", stop and check.
- DO prefer the natural-language brief + SDK agent loop pattern over custom step-arrays whenever both are viable - it scales without per-target engineering.
- DO use Anthropic's tool-use schema as the canonical action vocabulary. Their schema is the contract every Anthropic-trained model already understands.
- DO list the Anthropic primitives the work touches (computer-use, tool-use, code-execution, files, etc) in the brief BEFORE starting, so the "did I check" gate is forced into the planning phase.

## Do NOT

- DO NOT build a vision proxy when computer-use does vision in one call.
- DO NOT design custom action vocabularies when Anthropic's tool-use schema already exists and is what the model is trained against.
- DO NOT write step-array runbooks for flows where a natural-language brief + agent loop accomplishes the same. The agent loop is computer-use's native operating mode.
- DO NOT split a single agentic capability into separate primitives (input.click + input.type + input.shortcut as discrete tools) when Anthropic's computer-use returns the action space in one schema.
- DO NOT mistake "I built infrastructure" for "I solved the problem". Visible artefacts are not evidence that the problem was the artefact-shaped one.
- DO NOT defer the "why not Anthropic's X" check to "after we ship v1". By then the parallel infrastructure has its own gravity and the deletion cost is higher than the build cost.
- DO NOT treat the agent (me) as substrate-distinct from Anthropic's capabilities. The model running my conversation IS the model that exposes computer-use. Building a "vision proxy to call Anthropic" is calling Anthropic from Anthropic.

## Protocol (Anthropic-first design check)

1. **State the capability in plain language.** Example: "I need the agent to look at a screen and click the right button." Not "I need vision.locate" - that prejudges the design.
2. **Search Anthropic's tool surface.** Computer-use? Tool-use schema? Code-execution? Files? File-search? Memory tools? Each should be ruled in or out by name.
3. **If a native primitive matches, use it.** Stop here. The build is over.
4. **If no native primitive matches, write the gap memo.** One paragraph: what Anthropic doesn't ship that I need, why it's missing, why my use case requires the missing piece. This memo is the prerequisite to any parallel infrastructure.
5. **Build the smallest possible bridge.** If you must build, the build connects the Anthropic primitive to the missing context, NOT the missing primitive entirely. A 30-line shim beats a 300-line proxy.
6. **Re-check on every Anthropic API release.** Capabilities that didn't exist last quarter (computer-use, code-execution, file-search) may exist now. Parallel infrastructure has a half-life; the SDK eats it.

## Specific examples I violated today (29 Apr 2026)

- **vision.locate as Anthropic-API-proxy.** Designed a custom tool that would screenshot, then POST to Anthropic, then parse a JSON response, then return coordinates. Computer-use does vision natively in one call as part of its standard action loop. The proxy is a re-implementation of what the API already does.
- **input.click + input.type + input.shortcut as separate primitives.** Treated each as its own tool with its own schema. Computer-use returns actions in a single schema (`type`, `key`, `mouse_move`, `left_click`, `screenshot`, etc.) - the model already knows that vocabulary. Splitting the schema into three custom tools is parallel infrastructure to one schema Anthropic already ships.
- **runbook.run as a step iterator.** Designed a runtime that reads a step array from JSON, calls each handler in order, observes a goal_state. The computer-use agent loop already iterates with reasoning - it observes, thinks, acts, re-observes, in the model's own loop. The step iterator is a less-capable re-implementation of an agent loop the model is already trained to run.
- **22 step-array runbooks.** Each runbook was a multi-row JSON spec with vision_targets, validations, expected screen states. Each could be a 1-line natural-language brief that computer-use would figure out from the screenshot ("Open Chrome, sign into Co-Exist admin, click Publish Event for the next pending event"). The 22 runbooks are 22 copies of structure that the model produces on demand from natural language.

## Origin

29 Apr 2026, two-instance day:

**17:30 AEST first instance (the macro retraction).** Caught having pushed 6 macroHandlers files I had imagined into the eos-laptop-agent without ever having run any of those handlers against the real Corazon UI. Authored `macros-must-be-validated-by-real-run-before-codification.md` as the corrective. The rule was: vision-first run, then codify.

**19:25 AEST second instance (22 imagined runbooks).** Inserted 22 macro_runbooks rows in the 90 minutes after authoring the corrective doctrine. None replayed. The corrective was violated 90 minutes after writing it.

**19:54 AEST Tate verbatim:** "we're doing what ive said we're doing wrong over and over by trying to recreate it ourselves when the tools already exist thanks to anthropic. Claude Desktop has these agentic capabilities already built in."

**The meta-pattern.** This isn't the first time. Tate has flagged "stop reinventing what Anthropic already ships" multiple times across different surfaces (vision, agent loops, action schemas, runbook engines). Each instance the parallel infrastructure looked more polished than the last - the 22 runbooks have neat goal_state strings, sensible step sequences, plausible vision_targets - which made the recurrence harder to spot from inside the work.

The pivot fork's job is to delete the parallel infrastructure. This pattern file's job is to prevent the next instance. The codification happens at the moment the rule is stated (per `codify-at-the-moment-a-rule-is-stated-not-after.md`), not after the next violation.

## Mechanical enforcement (shipped 29 Apr 2026, fork_mojwewuk_3bff69)

The doctrine layer (this file + INDEX + CLAUDE.md cross-ref) is no longer the only line of defence. As of fork `fork_mojwewuk_3bff69`, the rule is enforced mechanically by a PreToolUse hook:

- **Hook:** `~/ecodiaos/scripts/hooks/anthropic-first-check.sh`
- **Matcher:** `mcp__forks__spawn_fork|mcp__factory__start_cc_session`
- **Behaviour:** scans the brief for keywords across 9 classes covering bespoke parallel infrastructure (vision proxy, runbook engine, custom agent loop, custom action vocabulary, custom computer-use executor, our-own-MCP-for-browser, screenshot+input agentic loop, explicit "parallel infrastructure to Anthropic", and inventing/recreating computer-use or Claude Desktop). Each class fires `[ANTHROPIC-FIRST WARN]` to model-visible context with a pointer back to this file.
- **Bias:** false positives over false negatives. The doctrine cost of a warn-noise dispatch is one re-read; the cost of a missed parallel-infrastructure ship is days of unwound work.
- **Silence path:** if the brief already names this file, names "anthropic-first design check", names "why not anthropic", or otherwise references the canonical Anthropic primitive being built against, the hook stays silent. The applied-pattern tag (`[APPLIED] use-anthropic-existing-tools-before-building-parallel-infrastructure.md because <reason>`) is the canonical way to acknowledge a legitimate gap-memo build.
- **Warn-only.** Never blocks. Always exits 0. Telemetry emits to `~/ecodiaos/logs/telemetry/dispatch-events.jsonl` for the Layer 4 consumer.
- **Registration:** `~/.claude/settings.json` PreToolUse, third hook in the fork/factory matcher group.
- **Doctrine origin:** Neo4j Decision id=3854 ("Doctrine-only enforcement is insufficient - 4 active doctrines need mechanical backstops"). This is backstop 1 of 4.

## Cross-references

- `macros-must-be-validated-by-real-run-before-codification.md` - sibling. Same anti-pattern (confidence without capability). That file enforces validation; this file enforces "don't build the thing in the first place if Anthropic already ships it".
- `forks-self-assessment-is-input-not-substitute.md` - same root failure mode at the fork-output level. Polished artefacts are not evidence of correctness.
- `codify-at-the-moment-a-rule-is-stated-not-after.md` - this fork IS that protocol applied. The rule was stated at 19:54; the codification is this file + Neo4j Decision + INDEX update + CLAUDE.md cross-ref, written immediately rather than logged-and-deferred.
- `when-a-tool-is-unavailable-solve-the-routing-problem-do-not-accept-the-block.md` - inverse rule. That file says "when blocked, route around"; this file says "when not blocked, don't reinvent". Together they bracket the build/buy/use decision.
- `no-symbolic-logging-act-or-schedule.md` - "I'll check Anthropic's docs later, let me ship v1 first" is symbolic logging. Either check now or do not build.
- `recurring-drift-extends-existing-enforcement-layer.md` - this is the recurring-drift case that triggered the mechanical-enforcement threshold. The hook above is the structural answer.
- `decision-quality-self-optimization-architecture.md` - the hook plugs into Layer 1 (surfacing) and Layer 4 (telemetry) of the architecture, with applied-pattern tagging at Layer 3.
