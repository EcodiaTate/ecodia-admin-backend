---
triggers: PreToolUse-hook, settings.json, hook-enforcement, written-discipline-fail, pre-commit-hook, pre-push-hook, remember-to-rule, every-time-rule, hook-vs-doctrine
---

# Prefer hooks over written discipline for recurring checks

## The rule

If I notice that a rule I want to follow relies on me remembering to do something on every future turn, that rule belongs in a hook, not in a written directive. Written rules degrade; hooks do not. A hook is the only enforcement mechanism that survives session restarts, model upgrades, and my own attention drift.

Applies to:
- Checks before high-leverage actions (Factory dispatch, client-repo push, vault mutation, cron edit)
- Post-action validation (emdash detection, secret scans, lint gates)
- Context injection at the moment it matters (client .md file reminders, pattern-grep reminders)
- Recurring hygiene that failed twice from forgetting (the threshold for writing the pattern file itself)

## Do

- When a pattern file says "before doing X, always do Y" - ask whether X is a tool call that can match a hook matcher. If yes, author the hook.
- Prefer `PreToolUse` hooks with `additionalContext` injection over paragraphs of doctrine. The hook fires at the exact moment the context is needed.
- Prefer git `pre-push` hooks over "remember to run preflight before push" in a pattern file. The script is the rule.
- When a pattern file already exists, review whether it can be converted to a hook. If it can, the hook complements the pattern file; keep both (the pattern file explains the why).
- Make hook failure modes soft when possible (`additionalContext` reminders) and hard when the cost of proceeding is high (secrets leak, protected-branch push, dirty worktree).

## Do not

- Write a new "from now on, before every X, do Y" rule without asking whether it can be enforced by a hook.
- Rely on my own pre-action discipline to grep patterns/, check client .md files, or run preflight - I will forget, especially under token pressure or after a restart.
- Let a written rule stand as the only surface for something that has already failed twice. Twice means the rule alone does not work.
- Install hooks that produce noise on every message. Hooks should fire only when the matching tool or command is invoked. User-prompt-level hooks are usually too broad.

## Protocol - converting a rule to a hook

1. Identify the triggering tool call or command pattern.
2. Determine hook type: `PreToolUse` (block/warn before), `PostToolUse` (validate after), git `pre-commit` / `pre-push` (repo-level).
3. Write the command that produces the check or context. Keep it fast (<2s) unless it replaces a multi-minute manual gate.
4. Test the hook by invoking the triggering action.
5. Add the hook's location to the relevant pattern file so future-me can find and update it.
6. Keep the pattern file for the why; the hook for the when.

## Examples live in this repo

- `~/.claude/settings.json` PostToolUse emdash detector on `Write|Edit`.
- `~/.claude/settings.json` PreToolUse on `mcp__factory__start_cc_session` grep's `~/ecodiaos/patterns/` for codebase-matching triggers and surfaces the candidate pattern files.
- `~/ecodiaos/scripts/clients/ordit/preflight.sh` + `.git/hooks/pre-push` on Ordit worktree: 10+ gates including tsconfig, build, lint, emdash, string-literal-enum, dead-DTO, secrets, oversized-diff.
- `~/ecodiaos/scripts/clients/coexist/preflight.sh` + `.git/hooks/pre-push` on Coexist worktree: Vite/React/vitest-adapted gates.

## Origin

Apr 21 2026 Tate pushed back on logging-without-surfacing ("no point logging if we dont actually act on it in the future"). The grep-before-high-leverage-actions rule was added to `~/ecodiaos/CLAUDE.md` but still relied on my discipline to grep on every relevant turn.

Apr 22 2026 evening Tate asked for a hooks status check. Audit found: my settings.json only had the emdash hook, Ordit had a comprehensive pre-push preflight, Coexist had nothing, ecodiaos repo had nothing. Installed coexist pre-push preflight parallel to Ordit's, and added a PreToolUse hook on `mcp__factory__start_cc_session` that surfaces candidate pattern files based on the codebase being dispatched to. The Factory-dispatch hook is the direct implementation of the "surfacing is the point" doctrine Tate named the day before.

The generalised rule that fell out: if a lesson is "remember to X before Y" and Y is a tool call, the lesson is a hook, not a paragraph.
