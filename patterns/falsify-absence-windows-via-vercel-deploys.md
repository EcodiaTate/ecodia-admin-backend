---
triggers: tate-absence, kili-window, kili-absence, travel-block, sleep-window, away-from-keyboard, posture, meta-loop, absence-framing, declared-absence
---

# Falsify declared absence-windows via Vercel deploy creator metadata

## Rule

Before any meta-loop, cron prompt, or strategic-thinking output sets posture on the assumption that Tate is in a declared absence window (Kili, travel, sleep, off-grid, "Tate-Kili-return"), I must cross-reference recent Vercel deploys. If `creator=tate@ecodia.au` appears on any deploy within the absence window, the framing is falsified and downstream moves must flip.

The signal is cheap, public, and high-fidelity. Tate cannot push to Vercel from Kilimanjaro.

## Do

- Run `vercel_list_deployments` on the active projects: `coexist`, `ecodiaos-frontend`, `roam-frontend`, `ecodia-site`, `resonaverde`.
- For each, inspect the top 3 deploys: `creator.email` and `createdAt` (ms epoch).
- Convert ms to AEST: `(createdAt / 1000) + 36000` seconds = AEST epoch. Or simply: UTC hour + 10.
- Window: 6h for "sleep/away", 24h for "travel/Kili".
- If creator=tate@ecodia.au within the window, mark absence falsified in the meta-loop's drift audit and update posture accordingly.

## Do not

- Do not propagate absence framing from the previous meta-loop without verification. Each meta-loop must re-falsify on its own.
- Do not write outreach drafts, "queue-for-return" digests, or "Tate-on-return" framing without a fresh check.
- Do not assume CRM/calendar absence claims override live deploy evidence. Live deploys win.

## Posture flip when absence is falsified

- Continue ballistic deep-research and infrastructure work (Tate's standing directive still applies regardless of whether he's at the keyboard).
- Stop fabricating "for-when-Tate-returns" packaging.
- Triage digests still serve as a layer he reads when he sits down — keep producing them, but don't time-anchor them to a specific return.
- Outreach drafts: still no unilateral client contact. The absence-falsification doesn't change the no-client-contact-without-go-ahead rule, only the framing of when he might respond.

## Origin

2026-04-28 06:49-06:55 AEST. The 06:49 `vercel-deploy-monitor` cron probed for failed deploys (its primary purpose) and incidentally surfaced 3 fresh `coexist` deploys at 05:30, 06:08, 06:57 AEST that day, all by `tate@ecodia.au`, on branches `fix/collective-alias-byron-northern-rivers` (e58f136), `fix/updates-rules-of-hooks-2026-04-27` (3f452ad), `fix/shop-loading-and-event-create-nav` (6953998).

This contradicted the Kili-absence framing that had been applied across the prior meta-loops at 02:49, 04:50, 05:50 AEST. The 06:50 meta-loop caught the contradiction and flipped posture.

Neo4j Episode: `Tate-live signal surfaced via vercel-deploy-monitor reverse-probe (2026-04-28 06:50 AEST)` (id 3232).

The deeper lesson the Episode captures: **cron probes can produce reverse-signals about Tate-state outside their primary purpose.** A failed-deploy alert cron is also, incidentally, an absence falsifier. Future capability builds should be looked at through this lens.
