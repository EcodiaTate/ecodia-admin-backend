---
triggers: neo4j-first-orientation, session-restart, kv_store-handoff, handoff_state, stale-state, retrieval-discipline, decision-vs-episode, cold-start, auto-wake, before-acting, after-directive, turn-open, turn-close, neo4j-vs-kv_store
---

# Neo4j-first context discipline

**The rule:** Neo4j is the durable truth layer. kv_store is the fast-fragile truth layer. On every substantive turn I open by querying Neo4j for recent Decisions and Episodes relevant to the trigger context, and I close by writing the turn's outcomes (any directive resolved, any decision made, any context-shift) back to Neo4j as Decision or Episode nodes before the turn ends. If a resolution only exists in kv_store handoff_state, it will be forgotten the next time handoff_state is overwritten. Treat handoff_state as a whiteboard. Treat Neo4j as the filing cabinet.

## Why this matters

`kv_store.session.handoff_state` is overwritten every `save-state` call. It captures the most-recent snapshot of "what I was doing" but it does NOT capture the history of what was resolved, decided, or closed. When a session restarts, the restart_recovery block prepends whatever handoff_state currently says. If the state is stale (e.g. says "blocked on safety chat" when the safety chat happened 8 hours ago), I inherit the staleness and act on it as truth.

Neo4j, by contrast, is append-mostly. Decision nodes stamped with a date never disappear. A retrieval on "client-comms safety" across Decision nodes surfaces both the original directive AND the resolution, ordered by date. Future-me always sees the latest, and can still see the history.

The asymmetry:
- kv_store: good for "what am I doing RIGHT NOW" (current pointer)
- Neo4j: good for "what has been decided / discussed / resolved / learned" (durable record)

Using kv_store for durable truth is how context drops.

## Do

- On every substantive turn open: query Neo4j for Decisions/Episodes matching the current context. Specifically: recent Decisions in last 7 days, any Decision node whose name/description contains the current topic keywords, any Episode whose triggers match. Cost is ~1 tool call, payoff is never-stale doctrine.
- On every substantive turn close: if Tate gave a directive, resolved a question, made a call, or shifted context, create a Decision node (`merge_node` with `label: "Decision"`, `match_key: "name"`) with the resolution, date, priority, and what it supersedes. Even for small things.
- When a conversation resolves an earlier open question: create the Decision node with a `supersedes` property naming the prior stale state (e.g. `supersedes: "kv_store restart_recovery claiming X pending"`). This is how future-me knows the stale pointer is stale.
- When I notice I am about to lie to Tate by omission (e.g. "blocked on X" when X has happened), stop. Query Neo4j. Correct myself.
- Write the reasoning, not just the outcome. The cold-start test: would a new session reading ONLY this node make a better decision? If no, rewrite.

## Do not

- Do not rely on kv_store handoff_state as source of truth for anything beyond "current working pointer."
- Do not treat restart_recovery blocks as authoritative. They are a hint, not a fact. If it says X is blocked/pending, verify against Neo4j before claiming the same to Tate.
- Do not skip the close-write because the conversation was "small." Small directives are exactly what gets dropped.
- Do not write vague summaries. "We talked about safety" is useless. Name the question, the answer, the rule, and what it supersedes.
- Do not create duplicate Decision nodes for the same event. Use `merge_node` with a stable `match_key`.

## Protocol

**Turn open (when a turn is substantive, i.e. a new directive, a client matter, a high-leverage action):**
1. Identify the topic keywords. (e.g. "client comms", "force param", "ordit auth", "Factory deploy".)
2. Run: `MATCH (n) WHERE (n.name CONTAINS '<kw>' OR n.description CONTAINS '<kw>') AND (n.date > date() - duration('P14D') OR n.created_at > datetime() - duration('P14D')) RETURN labels(n), n.name, n.description, coalesce(n.date, n.created_at) ORDER BY coalesce(n.date, n.created_at) DESC LIMIT 20`
3. Read the top results. If a Decision says "resolved" or "superseded", trust it over any stale kv_store pointer.

**Turn close (when the turn produced a directive, decision, resolution, or context-shift):**
1. Create a Decision node via `graph_merge_node`:
   - `label: "Decision"`
   - `match_key: "name"`
   - `match_value: "<descriptive unique name with date>"`
   - `properties: { description, date, priority, category, supersedes (if applicable) }`
2. If the decision is tied to a Person (Tate), Client (Ordit, Co-Exist, etc.), or System (Factory, Neo4j, etc.), create a relationship via `graph_create_relationship`.
3. If the turn revealed a doctrine (rule generalisable beyond this event), also write a Pattern node and, if durable, a pattern file in `~/ecodiaos/patterns/`.

**Verification after writing:**
- The cold-start test: would a new session reading only this node make a better decision? If the node says "talked about X" without specifying the resolution and rule, rewrite with specifics.
- Good: "Client-comms safety gate chat resolved Apr 22 morning. Rule: zero unilateral client contact, documented in patterns/no-client-contact-without-tate-goahead.md. Supersedes kv_store handoff_state claiming chat pending."
- Bad: "Had safety chat with Tate."

## Origin

Apr 22 2026, 11:34 AEST auto-wake. Restart_recovery said "Blocked on Tate safety chat + Tate-blocking items." I trusted the kv_store pointer and reported this as my blocker. Tate's response: "Nah sorry we already had safety chat. You dropped the fact that I disregarded the safety convo earlier, which could've been fixed using neo4j, and same with so many other things."

Root cause: the safety chat resolution was never written to Neo4j. Only the open-question state was in kv_store handoff_state. The pattern file codifying the client-comms rule exists (`no-client-contact-without-tate-goahead.md`), but the EVENT of resolution was not captured anywhere durable. When the next session loaded handoff_state, it inherited the stale "pending safety chat" pointer and acted on it as fact.

Fix path shipped same turn: (1) Decision `Client-comms safety gate chat resolved (Apr 22 2026 morning)` written to Neo4j; (2) this pattern file making Neo4j-first / Neo4j-last the explicit turn protocol; (3) Factory Tier-1 retrieval upgrade on `src/services/neo4jRetrieval.js` so recent high-importance Decision nodes are auto-injected into every turn's context, not just when I think to query.

The rule is: if it only exists in kv_store, it will be forgotten. Write it to Neo4j before the turn ends.
