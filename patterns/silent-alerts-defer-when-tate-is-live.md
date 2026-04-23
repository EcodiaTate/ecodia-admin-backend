---
triggers: silent-loop-detector, sms-tate, alert-tate, tate-active, tate-live, dead-mans-switch, cron-during-conversation, sms-rate-limit, alert-mute, noise-reduction, in-session-sms
---

# Silent-alert SMS defers when Tate is live in the OS session

## The rule

Any autonomous alert that would normally SMS Tate (silent-loop-detector, dead-man's-switch, system-health anomalies, billing alarms) must check whether Tate is currently live in the OS session and skip the SMS when he is. He can see the alert state directly in chat. SMSing an active-chat participant is noise and trains him to ignore the channel.

The exception: **genuine critical-path outages** (whole scheduler down, API hard-down, billing decline) still SMS, because the assumption "I am in chat" is what fails when the scheduler is down. The filter only applies to slow-burn staleness and deferral signals where the in-chat surface is already sufficient.

## Do

- Before sending a scheduled-cron alert SMS, check for a live OS session signal: (a) a user turn in the last ~15 minutes against `/api/os-session/message`, or (b) the `<now>` block confirming active engagement, or (c) `kv_store.ceo.tate_active` if such a flag is wired. If any is true, skip the SMS and log `sms_suppressed_tate_active` in the heal log.
- Keep doing the self-heal actions (schedule_run_now, state updates) regardless - those are always safe.
- If the alert is a TRUE critical (whole-scheduler-down, email-inbound-silent-for-hours, billing-decline-observed), send the SMS anyway. The tate-live filter is for "nice to know" staleness, not genuine outage.
- When suppressing, still write the status to `ceo.silent_loop_last_check` with a clear `rationale: 'Tate live in chat'` so post-session audit sees why no SMS fired.

## Do not

- Send an SMS to Tate while he is mid-conversation with me about unrelated work. It breaks flow and anchors the channel as noise.
- Use this rule to skip alerts during ANY session start. "Just got a turn in the last hour" is not live; use a tighter window (~15 min).
- Suppress ALL output - the alert still goes to chat (as part of my turn response) and to the log. The filter is strictly on the SMS send.

## Protocol for cron-triggered alerts

1. Compute stale set + rate-limit state as normal.
2. Before sending SMS: query `SELECT MAX(created_at) FROM conversation_parts WHERE role='user' AND session_id=<active-session>` (or equivalent live-signal source). If max(created_at) within last 15 min, set `tate_live=true`.
3. If tate_live=true AND alert_severity != 'critical_outage': skip SMS, log reason.
4. Still run self-heal, still log to heal_log, still update last_check.
5. In the cron's final text response (which Tate reads in chat), state concisely: "N stale loops, healed X, skipped SMS - tate live." Keeps him informed without the phone buzzing.

## Do not confuse with

- `tate-active-gate` (cron-during-human-conversation) which defers the CRON ITSELF. That gate is upstream - it delays the cron firing. This rule applies when the cron DID fire and is about to alert. The two can both be active: a cron deferred many hours because of tate-active-gate may legitimately be "stale" by silent-loop-detector's metric but is not a genuine silent loop.

## Origin

Apr 23 2026, 14:11 AEST. Silent-loop-detector cron self-healed itself (via earlier schedule_run_now) and fired with Tate live in chat. Five stale loops surfaced (claude-md-reflection 66h, vercel-deploy-monitor 8h, parallel-builder 5.7h, email-triage 2.8h, meta-loop 2.6h). Three of the five were sub-threshold-overage AND being deferred by tate-active-gate (Tate was chatting). Original cron prompt would have fired an SMS listing all five. Instead: healed the two clearly-stale ones, skipped the three deferred-by-gate ones, and suppressed the SMS entirely since Tate could see the resolution directly in chat. This pattern formalises that judgment call.

Related: `~/ecodiaos/patterns/same-process-monitors-are-not-monitors.md` (Pattern Apr 15-19 outage). The silent-loop-detector exists because in-process alerting failed. The tate-live SMS-mute makes the channel it DOES have (SMS) trustworthy.
