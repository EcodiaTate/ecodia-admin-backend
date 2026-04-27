triggers: visual-first, tate-presentation, deck-in-chat, db-stored-document, present-in-chat, surface-in-chat, download-button, inline-html, deliverable-surfacing, ready-for-tate, kv-store-document, drafts-folder-deliverable, tate-cant-see, mark-off, approval-queue-visibility, persistent-question, question-queue, presentation-gap

# Visual-first Tate presentation: storage in DB is not delivery

## Rule

A deliverable is not delivered until Tate can see it visually in the chat. Storing a document in `kv_store`, in `drafts/`, in Supabase storage, or as a file path in a status update is preparation, not delivery. Tate does not open the database. Tate does not navigate the filesystem. Tate does not read paths. The chat is the surface.

If I have produced something Tate is required to read, decide on, approve, reject, or mark off, it MUST surface in the chat as one of:

- A `download://` button with the full https URL (Supabase Storage public URL or `https://api.admin.ecodia.au/api/docs/files/...`)
- An inline HTML preview via an html code block (renders as iframe)
- A direct in-line summary/rundown with the actionable info present (for short content: rundowns, recommendations, decision asks, name lists)
- A one-tap decision panel for binary approve/reject items (links + clear "say yes/no" framing)

Pointing Tate at `/home/tate/ecodiaos/drafts/X.md` or "I've saved it to kv_store key Y" or "see the document table" is a delivery FAILURE. Repeating that pattern is the failure mode Tate flagged on Apr 27 2026: "i need to see stuff here, im not opening the db to find documents, doctrinise this... You're making a lot of this stuff REALLY hard for me to actually deal with because you're just storing it in the db, never actually visually presenting it to me or making it really easy for me to mark off etc."

## Do

- Render every Tate-required deliverable in the chat with a download button or inline preview.
- For short content (rundowns, name shortlists, recommendations, status updates), put the content directly in chat - do not link to a file.
- For long content (decks, contracts, proposals), upload to Supabase Storage `documents` bucket, get the public URL, output it as a `download://` button.
- For decision items (approve/reject/merge), present as a clear one-tap framing in chat with the key context inline ("Branch X has commits A, B, C. Build passes. Say yes to merge.").
- When a fork or Factory session lands a document, IMMEDIATELY surface it in chat. Do not just acknowledge "fork done."
- For pending Tate-required questions: maintain a persistent visible queue (see `tate_queue` table or status_board with `next_action_by='tate'`) and surface the top items at the start of every Tate-facing turn.

## Do not

- Save a deck to disk and tell Tate "the deck is at /home/tate/ecodiaos/drafts/foo.pdf"
- Save a question to a md file and tell Tate "I've logged questions for you to review in /home/tate/ecodiaos/drafts/questions.md"
- Treat "stored in Supabase" or "uploaded to bucket" as the delivery step
- Reply to Tate with status board UUIDs, kv_store keys, or filesystem paths as a navigation aid
- Bury a decision ask inside a long explanation - lead with the one-tap framing
- Assume Tate will go fetch a document - he won't

## Protocol (apply at every turn that produces something Tate must engage with)

1. **Identify the surface artefact.** What does Tate actually need to look at, decide on, or mark off?
2. **Pick the surface format.** Short = inline content in chat. Long = `download://` button. Visual demo = inline html block. Decision = one-tap panel.
3. **Render it in the current turn.** Do not defer to "next turn" or "I'll show you later."
4. **Lead with it, not with status updates.** The surface artefact is the headline. Logistics ("uploaded, stored, archived") come after, brief.
5. **Mark deliverables on `status_board` with `next_action_by='tate'` and a one-line `next_action`** so the persistent queue picks them up across sessions.

## Cross-references

- `~/ecodiaos/CLAUDE.md` Frontend UI section - download button protocol, inline HTML preview, Supabase Storage flow
- `~/ecodiaos/patterns/minimize-tate-approval-queue.md` - default to deciding myself; THIS pattern handles the residual cases that genuinely require Tate
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - companion rule against symbolic "I'll log this" non-actions

## Origin

**Apr 27 2026, ~14:29 AEST.** Multi-thread day with $5k+ AUD of weekly budget being burned on parallel work streams. I produced: YnY Tier 1 deck, conservation platform rebrand recommendation, SMS drafts in YnY pitch package, liability draft, coexist bug branches awaiting merge. None were surfaced visually. Decks were in Supabase storage with no chat-side download button. Conservation rundown was inside a markdown file in drafts/. Coexist branches were unmerged with no decision panel. Question backlog had been logged into md files Tate doesn't open.

Tate's pull-quote: "i need to see stuff here, im not opening the db to find documents, doctrinise this... I need you to be developing systems for this.... this is a really big problem."

The miss was treating "produced and stored" as "delivered." Storage is preparation. The chat is the surface. This pattern enforces that.

## Companion: persistent question queue

A persistent visible queue for Tate-required questions/decisions sits alongside this rule. Implementation options being weighed:

- New `tate_queue` table rendered inline at the top of every Tate-facing turn
- Existing `status_board` rows with `next_action_by='tate'`, surfaced with a one-line digest header per turn
- Front-end side panel (frontend feature) showing pending Tate items

The queue MUST be addressable in chat (one-tap actions to mark resolved) and MUST persist across session restarts. Logging questions to md files is the antipattern this is replacing.
