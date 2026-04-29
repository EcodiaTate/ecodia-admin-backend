---
triggers: status_board-batch-update, CASE-WHEN-update, status_board-multi-row-update, status_board-splatter, status-corruption, directive-sweep, status_board-cross-row-leak, sql-update-many-rows, status_board-sweep-protocol
---

# Never apply a directive sweep to status_board as a single multi-row CASE-WHEN UPDATE - one statement per row

## The rule

When acting on a Tate directive sweep that mutates several distinct `status_board` rows, do NOT collapse the changes into one `UPDATE status_board SET status = CASE WHEN id = 'a' THEN ... WHEN id = 'b' THEN ...` statement. Each row's status, next_action, and priority are independent strings. CASE-WHEN multi-row updates are the documented splatter source: two adjacent CASE branches can mis-match IDs, identical-looking strings get reused across rows that should not share content, and the corruption is silent because every row appears to have *some* updated value.

**Discipline: one `UPDATE status_board SET ... WHERE id = '<single-id>'` statement per row, even if it makes the SQL block 5x longer. Verbosity is cheap. Cross-row content leak is not.**

## Symptoms (how to recognise an old splatter)

Drift audit finds two rows with `last_touched` matching to the millisecond AND one of them has status/next_action that semantically belongs to the other. Example: an "RLS decision - ROAM edges table" row carrying the exact status string "Unblocked. UI cleanup + ASC resubmit pending" - which clearly belongs to "Roam IAP Fix" not the RLS row.

When the audit confirms cross-row semantic leak, search the cohort by timestamp:

```sql
SELECT name, last_touched FROM status_board
WHERE last_touched BETWEEN '<ts>' - interval '2 seconds' AND '<ts>' + interval '2 seconds'
ORDER BY last_touched;
```

If 5+ rows share the timestamp to the millisecond, it was a single batch UPDATE. Inspect each for content that semantically fits a neighbour, not itself.

## Do

- For directive sweeps that mutate N rows: emit N separate `UPDATE ... WHERE id = '<id>'` statements. The MCP `db_execute` accepts multi-statement bodies; just terminate each with `;`.
- Re-read the actual current row content before drafting the UPDATE. The directive may already be reflected in some rows; a per-row update lets you skip those, a CASE-WHEN re-stamps everything.
- After the sweep, run a one-line verification: `SELECT name, status, next_action_by FROM status_board WHERE id IN (<all-touched-ids>);` - confirm each row's content semantically matches its name.
- For pure timestamp-only refreshes (no content change), `UPDATE status_board SET last_touched = NOW() WHERE id IN (...)` is fine. Splatter only applies to content fields.

## Do not

- Do not write `UPDATE status_board SET status = CASE WHEN id = 'a' THEN '...' WHEN id = 'b' THEN '...' END WHERE id IN ('a', 'b')` for content updates. Even if it parses cleanly, the next person reviewing the diff cannot tell which CASE branch goes with which row without cross-referencing the WHERE clause.
- Do not optimise for SQL brevity here. The audit cost of finding a splatter is minutes; the cost of writing 5 vs 1 UPDATE is seconds.
- Do not assume the splatter "doesn't happen because the SQL was correct" - the corruption observed Apr 26-27 happened despite the UPDATE being syntactically valid. Mechanism unconfirmed (likely a CASE-branch matching on a stale ID or a WHERE clause that was wider than intended).

## Origin

Apr 27 2026, 08:11 AEST meta-loop drift audit. Found two corrupted rows in `status_board`:
- `RLS decision - ROAM edges table` carrying status "Unblocked. UI cleanup + ASC resubmit pending" + next_action "Identify open UI decisions, dispatch Factory for cleanup, then resubmit to App Store Connect" - both verbatim from `Roam IAP Fix`.
- `Resonaverde Referral Agreement` carrying status "Tate handling directly via Angelica" - actually the status of `RLS decision - Resonaverde newsletter tables`, which IS Tate-handled but the Referral Agreement row's correct status was "draft staged for relay nudge".

Both corrupted rows shared `last_touched = 2026-04-26T21:52:15.462Z` with 7 other rows that were correctly updated in the same batch (DAO upgradeability, Co-Exist federation, SCEC Website, Airwallex, Landcare, Roam IAP Fix, RLS Resonaverde). The 21:52 sweep was applying Tate's standing-queue directive (drop Airwallex, sit on LCA, leave Resona, ROAM unblocked, balls-deep SCEC, RLS for ROAM + Resonaverde safely). Out of 9 rows touched, 7 came through correctly and 2 received content from neighbouring rows. Mechanism: presumed CASE-WHEN with mis-aligned ID matching.

Cleanup: per-row UPDATE statements at 08:11 AEST restored correct content. Pattern logged so the next directive sweep does not reproduce.
