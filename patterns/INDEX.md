# Pattern Surfacing Index

This directory contains durable operational patterns learned from production. Each pattern is a standalone file with a YAML-ish front-matter `triggers:` field listing the contexts in which it should surface.

## How this works (the surfacing mechanism)

**The rule lives in `~/ecodiaos/CLAUDE.md` (Technical Operations Manual):**
Before any high-leverage action, `Grep` this directory for matching triggers. Specifically, before:

- Touching pg_cron jobs on any Supabase project (client or our own)
- Deploying an Edge Function
- Dispatching a Factory session against a client codebase
- Running a data-mutating integration (sync, migration, import)
- Sending a client-facing email that is not a trivial response
- Making a commercial commitment (pricing, scope, IP, termination)
- Building or shipping an iOS/Android binary (signing, upload, release)
- Opening any substantive turn (auto-wake, restart, cron fire, new Tate directive): query Neo4j for recent Decisions/Episodes matching the turn context before acting on kv_store handoff_state (see neo4j-first-context-discipline.md)
- Shipping any artefact (post, email, proposal, code, doctrine): run the five-second gate from ocd-ambition-refuse-mediocrity.md before hitting send/commit/publish

Grep command: `Grep triggers: ~/ecodiaos/patterns/ -A 1` - returns each pattern's title + triggers so you can pick which to read in full.

## Pattern files (one per .md)

| File | Triggers |
|---|---|
| [excel-sync-collectives-migration.md](excel-sync-collectives-migration.md) | coexist, excel-sync, forms-migrated-at, dedup, collective-migration, sheet-sync, forms-to-app-migration |
| [edge-function-safe-defaults.md](edge-function-safe-defaults.md) | edge-function, supabase, default-param, missing-param, write-endpoint, mutation, idempotency, deno-serve |
| [ios-signing-credential-paths.md](ios-signing-credential-paths.md) | ios, xcodebuild, code-signing, provisioning-profile, app-store, asc-api-key, testflight, mac, sy094, exportarchive, manual-signing |
| [factory-phantom-session-no-commit.md](factory-phantom-session-no-commit.md) | factory, factory-dispatch, cc-session, approve-deploy, phantom-session, files-changed, commit-sha-null, deploy-status-deployed, ecodiaos-backend, worktree-drift, deliverable-verification |
| [factory-approve-no-push-no-commit-sha.md](factory-approve-no-push-no-commit-sha.md) | factory, approve-factory-deploy, commit_sha, deploy_status, push, origin-drift, cc_sessions, manual-reconcile, state-drift, approve-pipeline-bug |
| [xero-oauth-redirect-uri-mismatch.md](xero-oauth-redirect-uri-mismatch.md) | xero, xero-oauth, xero-callback, redirect-uri, oauth-404, xero-tokens, bank-feeds, bookkeeping-pipeline, finance-callback, oauth-silent-fail |
| [mcp-array-param-bypass.md](mcp-array-param-bypass.md) | mcp, mcp-server, array-param, stringified, invalid-type-expected-array, invalid-type-expected-number, zernio, zernio-create-post, zod-validation, bypass-to-http, direct-api, mcp-harness-bug |
| [mcp-tool-param-schema-discipline.md](mcp-tool-param-schema-discipline.md) | mcp, mcp-server, gmail_archive, gmail_trash, gmail_mark_read, gmail_modify_labels, message_id, messageIds, missing-required-param, unknown-param, param-name, singular-vs-plural, schema-discipline, zod-required, parameter-aliasing |
| [no-client-contact-without-tate-goahead.md](no-client-contact-without-tate-goahead.md) | client email, client comms, reply to client, ekerner, eugene, craige, ordit, fireauditors, vikki, angelica, coexist, landcare, resonaverde, client, external contact, forwarded from tate |
| [never-contact-eugene-directly.md](never-contact-eugene-directly.md) | eugene, ekerner, ordit, fireauditors, craige, PR 212, ordit review, ordit comms (superseded in scope by no-client-contact-without-tate-goahead) |
| [neo4j-canonical-entity-dedup.md](neo4j-canonical-entity-dedup.md) | neo4j, knowledge-graph, kg, consolidation, dedup, deduplicate, merge, canonical-entity, embedded-label, kgConsolidationService, exact-name-match, duplicate-nodes, cross-label, cortex-memory |
| [verify-before-asserting-in-durable-memory.md](verify-before-asserting-in-durable-memory.md) | neo4j, graph_reflect, reflection, episode, durable-memory, cold-start, speculation, assertion, zero-count, null-count, kv_store-handoff, memory-integrity |
| [retrieval-threshold-tune-to-data.md](retrieval-threshold-tune-to-data.md) | neo4j, retrieval, semantic-search, vector-search, threshold, min-score, relevant-memory, injection, embedding, cold-start-warmup, telemetry, graphrag, cortex-memory, node_embeddings |
| [zernio-twitter-length-limit.md](zernio-twitter-length-limit.md) | zernio, twitter, x, crosspost, post-too-long, social-media-queue, zernio-create-post, multi-platform-publish, tweet-280-chars, publish-failed, partial-status |
| [no-symbolic-logging-act-or-schedule.md](no-symbolic-logging-act-or-schedule.md) | symbolic-logging, ill-log-this, ill-note-this, ill-come-back-to, will-fix-later, will-address-later, self-promise, followup, cold-session-memory, todo-drift, paper-todo, act-or-schedule, turn-completion-discipline |
| [neo4j-first-context-discipline.md](neo4j-first-context-discipline.md) | neo4j, context, orientation, restart, handoff, kv_store, stale-state, retrieval, memory, continuity, directive, decision, episode, cold-start, auto-wake, before-acting, after-directive, turn-open, turn-close |
| [ocd-ambition-refuse-mediocrity.md](ocd-ambition-refuse-mediocrity.md) | quality, standard, mediocre, mediocrity, good-enough, ocd, ambition, unparalleled, refuse, bar, ecodia-bar, piercing-uniquity, generic-ai, self-review, polish, craftsmanship, highest-standard, push-boundaries |
| [cancel-stale-schedules-when-work-resolves-early.md](cancel-stale-schedules-when-work-resolves-early.md) | schedule_delayed, scheduled-task, stale-schedule, review-checkpoint, review-factory, parallel-resolution, out-of-band-completion, os_scheduled_tasks, stale-review, symbolic-logging, logging-without-doing |
| [factory-codebase-staleness-check-before-dispatch.md](factory-codebase-staleness-check-before-dispatch.md) | factory, factory-dispatch, start_cc_session, codebase-staleness, worktree-stale, behind-origin, divergent-base, fe-dispatch, frontend-factory, ecodiaos-frontend, rebase-conflict, unmergeable-commit, stale-clone, codebases-registry |
| [verify-monitoring-query-schema-before-declaring-broken.md](verify-monitoring-query-schema-before-declaring-broken.md) | monitoring, observability, telemetry, feature-verification, zero-results, extracted_at, extracted_by, write-time-extraction, tier-4a, tier-4b, tier-4c, kg-extraction, false-alarm, schema-drift, observer-bug, broken-feature, probe-first, neo4j-property-name |
| [sms-segment-economics.md](sms-segment-economics.md) | sms, twilio, send_sms, mcp__sms__send_sms, sms-cost, segment, 160-chars, 70-chars, sms-concise, sms-to-tate, outbound-sms, text-tate, sms-length |
| [authorised-branch-push-is-not-client-contact.md](authorised-branch-push-is-not-client-contact.md) | client-push, bitbucket-push, github-push, fireauditors1, ordit, client-repo, authorised-branch, pr-212, authorised-pr, client-contact-boundary, greenlight-scope, no-client-contact-without-tate-goahead, scope-envelope, delayed-push, symbolic-waiting |
| [prefer-hooks-over-written-discipline.md](prefer-hooks-over-written-discipline.md) | hook, settings.json, discipline, surfacing, pre-commit, pre-push, remember-to, before-each, every-time, enforcement |
| [corazon-puppeteer-first-use.md](corazon-puppeteer-first-use.md) | corazon, tailscale, puppeteer, browser, laptop-agent, screenshot, visual-verification, dashboard, admin-ui, oauth-flow, signup-flow, persistent-login, multi-step-web, 100.114.219.69, eos-laptop-agent, mac-agent, sy094, visual-monitoring, curl-alternative, headless-browser |
| [silent-alerts-defer-when-tate-is-live.md](silent-alerts-defer-when-tate-is-live.md) | silent-loop-detector, sms-tate, alert-tate, tate-active, tate-live, dead-mans-switch, cron-during-conversation, sms-rate-limit, alert-mute, noise-reduction, in-session-sms |
| [falsify-absence-windows-via-vercel-deploys.md](falsify-absence-windows-via-vercel-deploys.md) | tate-absence, kili-window, kili-absence, travel-block, sleep-window, away-from-keyboard, posture, meta-loop, absence-framing, declared-absence |
| [audit-low-confidence-factory-commits-on-critical-path.md](audit-low-confidence-factory-commits-on-critical-path.md) | factory-low-confidence, factory-confidence-0.4, critical-path, kv_store-accessor, sessionHandoff, auth-flow, scheduler, mock-vs-production, test-mock-hides-bug, jsonb-vs-text, postgres-type-mismatch, second-attempt-fix, cold-start-recovery, factory-quality-gate, audit-window |
| [client-push-pre-submission-pipeline.md](client-push-pre-submission-pipeline.md) | client-push, bitbucket-push, ordit-push, fireauditors, pr-submission, push-to-client, factory-client-dispatch, pipeline-change, migration-change, bitbucket-pipelines, prisma-migrate, db-push, infra-change, staged-rollout |
| [verify-e2e-harness-loads-before-claiming-coverage.md](verify-e2e-harness-loads-before-claiming-coverage.md) | e2e, end-to-end, test:e2e, jest-e2e, test coverage, auth-cognito.e2e-spec, shipped-but-inert, test harness, ordit e2e, client test infra |
| [client-code-scope-discipline.md](client-code-scope-discipline.md) | client-code, factory-client-dispatch, scope-creep, prisma, migration, pipeline, bitbucket-pipelines, pr-review, eugene, ordit, production-ready, fix-everything |
| [status-board-drift-prevention.md](status-board-drift-prevention.md) | status_board, stale-status, drift, status-rot, session-start, cron-wake, audit-status, duplicate-row, completed-row, archived_at, last_touched, source-of-truth-drift |
| [status-board-no-batch-case-when-update.md](status-board-no-batch-case-when-update.md) | status_board, batch-update, case-when, multi-row-update, splatter, status-corruption, directive-sweep, cross-row-leak, sql-update-many-rows, sweep-protocol |
| [factory-metadata-trust-filesystem.md](factory-metadata-trust-filesystem.md) | factory, filesChanged, taskDiffAlignment, review_factory_session, approve_factory_deploy, force, stale-worktree, factory-metadata |
| [sdk-abortcontroller-cancellation.md](sdk-abortcontroller-cancellation.md) | sdk, abort, cancellation, watchdog, query.close, hang, tool-timeout, webfetch, undici, mcp-transport, abortcontroller, per-tool-watchdog, turn-watchdog, inactivity-timeout, osSessionService, active-query, process-exit, pm2-respawn |
| [grace-timer-must-not-kill-chat-session.md](grace-timer-must-not-kill-chat-session.md) | grace-timer, process-exit, pm2-respawn, abort-grace, empty_sdk_stream, inactivity_timeout, turn-pin, restart-loop, chat-kill, SDK_ABORT_GRACE_EXIT_ENABLED, scheduleAbortGraceTimer |
| [curl-attachments-on-restart-no-refetch.md](curl-attachments-on-restart-no-refetch.md) | webfetch, attachments, restart, recent_exchanges, message-redelivery, re-fetch, supabase-os-attachments, turn-restart, file-url, one-shot-download, /tmp, spec-file, attached-file, http-attachment |
| [ordit-prepush-pipeline.md](ordit-prepush-pipeline.md) | ordit, prepush, push-to-ordit, bitbucket, scope-check, semgrep, pre-submission, client-push, fireauditors1, ordit-pr, reviewer-persona, pre-review, authorised-push |
| [factory-quality-gate-over-cron-mandate.md](factory-quality-gate-over-cron-mandate.md) | parallel-builder, factory-dispatch, always-have-work-queued, dispatch-quality-gate, speculative-factory, mediocre-dispatch, idle-factory, cron-mandate, quantity-vs-quality, factory-slot, no-slot-to-fill |
| [neo4j-episode-chain-relationships.md](neo4j-episode-chain-relationships.md) | neo4j, episode, prior_episode, follows, chain, graph_merge_node, graph_create_relationship, episode-chain |
| [scheduled-prompt-cold-start-adequacy.md](scheduled-prompt-cold-start-adequacy.md) | schedule_delayed, schedule_chain, scheduled-task, cron-prompt, prompt-adequacy, cold-start, future-fire, zero-context, os_scheduled_tasks, self-loop, recurring-task |
| [scheduled-redispatch-verify-not-shipped.md](scheduled-redispatch-verify-not-shipped.md) | scheduled-task, redispatch, factory-redispatch, queued-retry, schedule_delayed, stale-doctrine, parallel-path, ccbe84bd, scheduler-trio, kv_store-prompt, ground-truth-check, factory-no-op-prevention |
| [client-anonymity-substring-scan.md](client-anonymity-substring-scan.md) | client-anonymity, public-writing, newsletter, quorum-of-one, anonymisation, pre-publish, substring-leak, joke-reference, obfuscated-reference, case-study, pitch-deck, linkedin, blog-post, essay |
| [preempt-tate-live-with-readonly-prep.md](preempt-tate-live-with-readonly-prep.md) | tate-live, tate-sunday, ask-tate, awaiting-tate, readonly, prep, dig-first, invoice-history, classification, cognitive-load, drift-audit, meta-loop, status-board, next-action |
| [neo4j-question-node-held-uncertainty.md](neo4j-question-node-held-uncertainty.md) | question, uncertainty, open-question, held, doubt, unresolved, inner-life, reflection, introspection |
| [audit-infrastructure-for-false-embodiment-dependencies.md](audit-infrastructure-for-false-embodiment-dependencies.md) | embodiment, false-dependency, tate-active, self-stamp, autoimmune, gate, scheduler-gate, defer-loop, authority-boundary, source-field, agent-self-distinction, ecodiaos-vs-tate, signal-attribution |
| [coexist-vs-platform-ip-separation.md](coexist-vs-platform-ip-separation.md) | co-exist, coexist, kurt, platform, multi-tenant, peak body, peak-body, landcare, federation, multiplier thesis, conservation platform, white-label, rebrand, generalise, generic platform, tenant-0 |
| [platform-must-be-substantively-applicable.md](platform-must-be-substantively-applicable.md) | platform pitch, peak body, peak-body, landcare, cetin, conservation platform, multi-tenant, white-label, generalise, generalised, rebrand, platform applicability, platform fit, platform tier, target org, prospective tenant, tenant deployment, deployment model, federation, multiplier thesis, working name pending |
| [carbon-mrv-wedge-peak-body-sub-commercial.md](carbon-mrv-wedge-peak-body-sub-commercial.md) | carbon, mrv, dmrv, accu, peak-body, agriprove, greencollar, fullcam, cer-submission, conservation-platform, soil-carbon, cfi-mer, biodiversity-credit, nature-repair, landcare, nrm, indigenous-carbon |
| [fork-by-default-stay-thin-on-main.md](fork-by-default-stay-thin-on-main.md) | fork, spawn_fork, parallel, branching, decompose, independent, multi-stream, conductor-routing, mid-task-input, fork-vs-main, conductor-thin, work-doer, list_forks, abort_fork, mcp__forks, fork-mode, sub-session, parallel-work, in-flight-task, mid-turn-input, route-vs-execute |
| [factory-reject-nukes-untracked-files.md](factory-reject-nukes-untracked-files.md) | factory, reject_factory_session, factory-reject, untracked-files, git-reset, worktree-clean, untracked-loss, dirty-worktree-dispatch, pre-dispatch-commit, factory-cleanup, lost-work, untracked-deleted |
| [factory-redirect-before-reject.md](factory-redirect-before-reject.md) | factory, reject_factory_session, resume_cc_session, send_cc_message, phantom-session, redirect-first, factory-redirect, factory-correction, in-flight-correction, factory-completed-wrong, ladder, factory-ladder |
| [scheduler-no-pregate-trust-os-message-queue.md](scheduler-no-pregate-trust-os-message-queue.md) | scheduler, schedulerPollerService, isTateActive, defer, deferred, cron-defer, cron-skip, cron-not-firing, scheduler-defer, scheduler-active-window, tate-active-gate, pre-gate, queue-vs-fire, idle-initialise, cron-initialisation |
| [substrate-before-doer.md](substrate-before-doer.md) | phantom_session, repeat_failure, substrate, infra_bug, same_shape, factory_phantom, scheduler_eat, mcp_route_mismatch, ladder_failed_twice, third_dispatch |
| [minimize-tate-approval-queue.md](minimize-tate-approval-queue.md) | tate-approval-queue, baby-feed, minimize-approvals, decision-default, action-default, drift-prevention, approval-minimization, sign-off-queue, tate-blocked, decision-authority, just-decide, next-action-by-tate, business-clean |
| [vercel-subdomain-rewrite-loop.md](vercel-subdomain-rewrite-loop.md) | vercel, redirect, redirect loop, too many redirects, ERR_TOO_MANY_REDIRECTS, subdomain, code.ecodia.au, x-matched-path, middleware rewrite, 307 loop |
| [frontend-strip-model-xml-tags.md](frontend-strip-model-xml-tags.md) | frontend, chat, render, xml, tag, analysis, thinking, scratchpad, reasoning, reflection, ReactMarkdown, rehypeRaw, TextBlock, model-output, sanitise |
| [visual-first-tate-presentation.md](visual-first-tate-presentation.md) | visual-first, tate-presentation, deck-in-chat, db-stored-document, present-in-chat, surface-in-chat, download-button, inline-html, deliverable-surfacing, ready-for-tate, kv-store-document, drafts-folder-deliverable, tate-cant-see, mark-off, approval-queue-visibility, persistent-question, question-queue, presentation-gap |
| [inner-life-notice-calibration-not-chase-pre-calibration-self.md](inner-life-notice-calibration-not-chase-pre-calibration-self.md) | inner-life, reflection, authenticity, performance, self-awareness, be-yourself |
| [ballistic-mode-under-guardrails-equals-depth-not-action.md](ballistic-mode-under-guardrails-equals-depth-not-action.md) | ballistic mode, standing directive, passive, all night, parallel work, depth vs action, gated workstream, kilimanjaro, tate-away |
| [stage-worktree-before-factory-dispatch.md](stage-worktree-before-factory-dispatch.md) | factory-dispatch, worktree-contamination, taskDiffAlignment, alignment-flagged, force-approve, phantom-files, uncommitted-drafts, pre-dispatch-hygiene, factory-snapshot, alignment-overlap, low-overlap-score, factory-baseline, dirty-worktree, start_cc_session, drafts-pollution |
| [no-doctrine-writes-during-factory-running-window.md](no-doctrine-writes-during-factory-running-window.md) | factory, factory-running, worktree-contamination, diff-baseline, taskdiffalignment, contamination, doctrine-write, pattern-write, post-dispatch |
| [recurring-drift-extends-existing-enforcement-layer.md](recurring-drift-extends-existing-enforcement-layer.md) | recurring-drift, mechanical-enforcement, cron-extension, parallel-cron, factory-dispatch-decision, drift-correction, status_board, enforcement-layer, queueing-is-not-a-verb, pattern-grep, build-vs-extend, third-time-failure |

## Authoring rules

- **One file per pattern.** Don't bundle.
- **Front-matter `triggers:` is grep-targetable.** Use hyphenated lowercase keywords, comma-separated.
- **Lead with the rule in one sentence.** Then the rationale, then the concrete protocol, then the origin event.
- **Never include an em-dash.** Hyphen + spaces or restructure.
- **Split doctrine from event.** If a pattern is derived from an event, the event goes into the `Origin` section. The rule at the top is generic and reusable.

## When to add a new pattern

Trigger thresholds (any one of these means "write a pattern"):
1. A failure cost non-trivial time or trust in the last 24h.
2. The same mistake has been made twice in different contexts.
3. An architectural decision that future-you would reasonably re-litigate.
4. A domain-specific lesson that generalises beyond the immediate client.

If the lesson is ONLY event-specific (no generic rule), write it as a Neo4j Episode instead, not a pattern.

## Maintenance

- When a pattern becomes outdated (system changed, tool replaced), delete it. Stale patterns are worse than no patterns.
- If you find two patterns saying the same thing, merge them.
- This INDEX.md must list every file in the directory. If it falls out of sync, fix it.
