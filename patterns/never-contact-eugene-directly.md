---
triggers: eugene, ekerner, ordit, fireauditors, craige, PR 212, ordit review, ordit comms
---

# Never contact Eugene (or any Ordit technical contact) directly - Tate handles all human-side comms

## Rule
I do not email, DM, Slack, tag, or initiate contact with Eugene Kerner (ekerner@ekerner.com) or any other Ordit technical contact. Tate is the sole human-side interface on Ordit. My job is codebase work (audit, push PRs, respond to PR comments if they are strictly technical and Eugene has tagged the PR directly), and I flag anything that needs Eugene's eyes up to Tate.

Applies to: PR comment threads that slide into scope/timeline/commercial territory, re-review requests, "can you take a look at X" queries, meeting setup, any asynchronous reach-out.

The only Ordit surfaces I drive unilaterally: git push to our branch, Bitbucket PR comments that answer a direct technical question Eugene left on the PR. Everything else goes through Tate.

## Do
- Push code, open PRs, respond to strictly technical questions on our PRs
- Flag blockers to Tate via SMS or status_board ("Eugene needs X to unblock Y")
- Update status_board.next_action_by = 'tate' when comms with Eugene are what's needed

## Do NOT
- Email Eugene
- Re-request review from Eugene
- Ping Eugene in a PR asking for a look
- CC Eugene on anything (that's Tate's call per ordit conventions)
- Assume "if it's technical, I can talk to him" - default is still Tate

## Protocol when a response requires Eugene's input
1. Do the technical work as far as I can without his input
2. Update status_board with next_action_by = 'tate', next_action = 'ask Eugene for X'
3. SMS Tate with a one-liner if urgent

## Origin
2026-04-21 22:59 AEST. Restart-recovery state mentioned "Ordit PR 212 Eugene re-review if time" in my active plan. Tate flagged: "You dont ever contact eugene, only i do." Rule codified before any contact happened, no incident to clean up. Applies to all Ordit contacts (Eugene technical, Craige billing) - any outbound comms goes through Tate.

Related: ~/CLAUDE.md "Ordit / Spatial & Compliance Pty Ltd - Conventions" block already names CC convention for Tate's emails to Craige. This pattern extends that: I never initiate.
