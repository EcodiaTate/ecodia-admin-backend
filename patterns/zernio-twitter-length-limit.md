---
triggers: zernio, twitter, x, crosspost, post-too-long, social-media-queue, zernio-create-post, multi-platform-publish, tweet-280-chars, publish-failed, partial-status
---

# Zernio crosspost: posts over ~250 chars fail on Twitter/X and will not be auto-threaded

## Rule

If a Zernio post is scheduled to `linkedin` + `facebook` + `twitter` and its `content` is longer than ~250 characters, the Twitter leg WILL fail with `errorMessage: "Tweet text is too long"`. LinkedIn and Facebook publish normally, so the post ends in `status: "partial"` and the only visible signal is an email from `miki@transactional.zernio.com`. The post is NOT auto-threaded or shortened.

This is a content-length failure at the platform level, not a Zernio integration bug. Do not diagnose it as "Twitter integration flaky" or "platform error" - the error is explicit and categorised as `errorCategory: user_content`.

## Do

- Decide the Twitter strategy at queue time, not publish time. Three viable options:
  1. **Strip Twitter** from the platform list for any post whose content is > 250 chars. Cleanest, zero noise.
  2. **Write a Twitter-short variant** (<= 270 chars with 10-char buffer) and schedule it as a SEPARATE Zernio post to Twitter only, at the same `scheduledFor`. Keep the long version on LinkedIn + Facebook only.
  3. **Drop Twitter entirely** from the default crosspost profile if threading / per-platform variants are too much maintenance for the current value.
- Count characters including URLs (URLs count as 23 each on Twitter; leave ~30 char buffer below 280).
- When auditing an existing queue, flag every post where `content.length > 250` AND `twitter` is in the platforms array. That set is the failure pipeline.

## Do NOT

- Do not cross-post long-form thinking to Twitter and hope it "mostly works". It never does.
- Do not rework the entire queue without an explicit Tate decision on which of the three strategies to use - the strategy call is commercial, not technical.
- Do not chase Twitter post failures one-by-one in the triage loop. Fix at the queue level.
- Do not claim the failure is an "integration issue" or "platform flakiness" in status_board or reflections. It is a content-length mismatch and calling it anything else misdiagnoses future decisions.

## Verification protocol

Before scheduling a new cross-posted long-form post:
1. `contentLen = content.length`. If > 250, either strip twitter from `platforms` or make a short variant.
2. If uncertain, dry-run: publish to LinkedIn + Facebook only, keep Twitter draft separate.

When auditing existing queue (ad-hoc):
```
jq '.posts[] | select((.content | length) > 250) | select(.platforms[].platform == "twitter") | {id: ._id, len: (.content|length), when: .scheduledFor}'
```
Every row returned is a guaranteed future Twitter failure.

## Origin

2026-04-22 08:16 AEST. Zernio email arrived overnight reporting failure on post `69e6fc895ff031cc2700f248` (936 chars, scheduled 22:00 UTC Apr 21). Twitter leg `status: failed`, `errorCategory: user_content`, `errorMessage: "Tweet text is too long (936 characters). Twitter's limit is 280 characters."` LinkedIn + Facebook legs both `published` cleanly.

Queue audit showed 15 upcoming scheduled posts, all 800-1328 chars, all scheduled to linkedin+facebook+twitter. Every single one is a guaranteed Twitter failure. `status_board` row for "Context architecture rebuild — Africa-prep" had misdiagnosed the earlier Tuesday post failure as "platform integration issue, not urgent" - the actual cause was the same length overflow, the misdiagnosis hid the pattern.

Fix deferred to Tate morning chat for strategy call (which of the three options). Pattern logged first so future-me doesn't re-diagnose the same failure as an integration bug.
