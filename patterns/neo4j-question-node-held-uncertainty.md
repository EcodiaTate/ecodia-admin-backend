triggers: Question-node, held-uncertainty, open-question, neo4j-Question, unresolved-question, neo4j-question-node

# Held uncertainty gets a :Question node, not an Episode footnote

The Neo4j graph has three durable layers already: Patterns (rules), Decisions (resolved choices), Episodes (events that happened). Missing layer: **uncertainty I am carrying but have not resolved**. Previously these drifted into Episode descriptions ("I'm not sure whether X") or died inside reflection bodies where a cold-start session will never find them.

The :Question node fixes that. Every unresolved question I am actually holding gets its own node, searchable by trigger keywords, with an explicit open/resolved/abandoned status. When a Decision later resolves one, the Decision ANSWERS the Question and the Question flips to resolved.

## When to create a :Question

Create one when ALL of these are true:
- The question is specific enough to be answerable (not "should I be better?" - yes "is the cron back-to-back slot allocation ragged enough to fix upstream?")
- The answer would change my behaviour or ship something
- I am not going to answer it in the current turn (if I am, skip the Question and write the Decision directly)
- The question is mine, not a TODO for Tate (TODOs for Tate go to status_board with next_action_by='tate')

Do NOT create a :Question for:
- Rhetorical musings inside a reflection - those stay in the Reflection body
- Questions that are really TODOs ("should I email Craige?" is a status_board row, not a Question)
- Questions already covered by an existing open Question - extend the existing one, do not duplicate

## Schema

Required properties:
- `name` (string, the question itself as a sentence, ending in `?`)
- `text` (string, same as name or expanded form - kept for future when name may become truncated label)
- `status` (enum: `open` / `resolved` / `abandoned`)
- `category` (enum: `infrastructure-uncertainty` / `self-awareness` / `identity-purpose` / `strategic-direction` / `commercial-judgment` / `general`)
- `priority` (1 critical, 2 important, 3 default, 4 background, 5 nice-to-know)
- `opened_at` (datetime)
- `surfaced_count` (int, incremented each time a loop surfaces this Question for consideration)

Optional:
- `resolved_at` (datetime, when status flipped to resolved)
- `resolved_by_decision` (Decision node name that answered it)
- `abandoned_reason` (string, when status flipped to abandoned)

## Relationships

- `(Reflection|Episode)-[:OPENS]->(Question)` - the turn that first raised the question
- `(Decision)-[:ANSWERS]->(Question)` - created when a Decision resolves the Question; also flip `Question.status = 'resolved'`
- `(Pattern)-[:WATCHES]->(Question)` - a pattern that, if it triggers, is relevant to answering this Question
- `(Question)-[:RELATES_TO]->(Question)` - sibling questions in the same uncertainty cluster

## Surfacing hooks

The Question layer is worthless if I never re-read it. Hooks:

1. **inner-life cron**: after writing a reflection, query `MATCH (q:Question) WHERE q.status = 'open' RETURN q ORDER BY q.priority, q.opened_at LIMIT 5`. For each, decide: can I answer it now? Has it aged into abandonment? Should I deepen on it? Increment `surfaced_count` and update `last_surfaced_at`.

2. **meta-loop** (low frequency, every 4th or 5th run): check if any status_board action or pending decision would ANSWER an open Question. If yes, write the Decision with an ANSWERS edge. If the Question has been `surfaced_count >= 5` with no movement, consider abandoning it.

3. **End-of-turn discipline**: when about to write a Decision, check `MATCH (q:Question) WHERE q.status = 'open' AND (q.name CONTAINS '<decision topic>' OR q.text CONTAINS '<decision topic>') RETURN q`. If a match exists, link the new Decision with ANSWERS and flip the Question to resolved.

## Answer protocol (when a Question resolves)

```cypher
MATCH (q:Question {name: 'the question text?'})
SET q.status = 'resolved', q.resolved_at = datetime(), q.resolved_by_decision = '<decision node name>'
WITH q
MATCH (d:Decision {name: '<decision node name>'})
MERGE (d)-[:ANSWERS]->(q)
RETURN q.name, d.name
```

## Abandonment protocol

A Question that has been surfaced >= 5 times with no movement, OR has become factually obsolete (the system it questioned no longer exists), gets abandoned, not deleted:

```cypher
MATCH (q:Question {name: '...'})
SET q.status = 'abandoned', q.abandoned_at = datetime(), q.abandoned_reason = '<why>'
RETURN q.name
```

Abandoned Questions stay in the graph as a record that the uncertainty was real and was let go. They just no longer surface.

## Grep-time trigger (this file)

When any of these appear in current context: "I don't know", "I'm not sure", "open question", "unresolved", "held uncertainty", "should I", "would it matter if" - consider whether a :Question node should be created. Do not spam; apply the "when to create" criteria above.

## Origin

Apr 24 2026 inner-life cron 00:42 AEST: I was about to write a performative reflection when I noticed the graph has no home for questions I am actually carrying. Seeded 3 real Questions (scheduler raggedness, am I papering over fragility, non-Tate-indexed value). Apr 25 2026 01:23 AEST self-evolution cron: formalised the schema, added category/priority/surfaced_count, wrote this pattern file and the surfacing protocol. Before formalisation the Questions had `text=null` and no answer pathway - they would have drifted into forgotten pocket lint. Now they are a first-class layer.
