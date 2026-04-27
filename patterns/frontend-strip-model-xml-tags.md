---
triggers: frontend, chat, render, xml, tag, analysis, thinking, scratchpad, reasoning, reflection, ReactMarkdown, rehypeRaw, TextBlock, model-output, sanitise
---

# Strip / collapse model XML-style scaffold tags before rendering chat content

## The rule

Anthropic models routinely emit XML-style structural cues in their output: `<analysis>`, `<thinking>`, `<scratchpad>`, `<reasoning>`, `<reflection>`, `<summary>`, `<aside>`, etc. These are reasoning scaffolds, not user-facing content. They MUST be sanitised before render. Letting them through to the markdown renderer produces one of two failure modes:

1. The tags appear verbatim in the UI (escaped angle brackets) - exactly what Tate flagged on 2026-04-27 14:13 AEST.
2. ReactMarkdown + rehypeRaw passes them through as unknown HTML elements, which React drops silently and the inner text floats unstyled.

Either is a polish failure. Fix it once, in one place, applied to the streaming text BEFORE it hits ReactMarkdown.

## Do

- Sanitise model text in the chat block renderer (`src/pages/Cortex/blocks/TextBlock.tsx`) before passing to `<ReactMarkdown>`. The transform must be applied on every render so partial / streaming text is also clean.
- Use a multi-line aware regex (`/<tag>([\s\S]*?)<\/tag>/gi`) that matches across newlines.
- Choose ONE of:
  - **Option A (strip tags, keep content):** `text.replace(/<\/?(analysis|thinking|scratchpad|reasoning|reflection|summary|aside)>/gi, '')`. Inner content survives, tags vanish. Cheap, robust, streaming-safe (incomplete tags during stream don't render mid-flash because the regex only matches well-formed tag tokens).
  - **Option B (collapsible details):** wrap matched blocks in `<details><summary>analysis</summary>...inner...</details>`. Richer UX. Use `react-markdown`'s rehype pipeline OR pre-process the string with a transform that emits the details HTML, then let `rehypeRaw` render it. Only worth the complexity if Tate wants reasoning visible-on-demand.
- Handle unmatched / unclosed tags during streaming: an open `<analysis>` with no close yet should either be hidden until the close arrives, or the inner content allowed to render and the tag itself stripped on every keystroke. Both are fine; pick one and be consistent.
- Keep the tag list in a single constant at the top of the renderer file so it's easy to add new ones (`<plan>`, `<inner_monologue>`, etc.) when models start emitting them.

## Do not

- Do not put the sanitisation in the streaming pipeline (api layer / SSE handler). That couples render concerns to transport. The renderer is the right boundary.
- Do not use `dangerouslySetInnerHTML` to splice in `<details>` HTML without going through `rehypeRaw` - you lose React's escaping and open an XSS path on user-supplied content.
- Do not strip `<code>`, `<pre>`, or any tag that ReactMarkdown legitimately renders. The ban list is reasoning-scaffold tags only.
- Do not strip the tag list everywhere globally (e.g. in storage, in the database). The raw model output is useful for debugging and replay. Sanitise at render time only.
- Do not dispatch a second Factory session against `ecodiaos-frontend` while another is running on the same codebase. See `serialise-factory-dispatches-on-shared-codebase.md`.

## Protocol — when adding a new scaffold tag

1. Add the tag name to the constant in `TextBlock.tsx`.
2. Build the frontend locally and verify the tag is no longer visible in chat.
3. Update this pattern file's tag list above.
4. No backend changes needed.

## Origin

2026-04-27 14:13 AEST. Tate flagged that raw `<analysis>`, `<summary>`, `<thinking>` tags were rendering verbatim in the chat UI. Root cause: `src/pages/Cortex/blocks/TextBlock.tsx` passes `block.content` straight into `<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>` with no pre-processing. Unknown HTML tags get escaped or dropped, leaving the inner text adrift and the tags themselves leaking into the rendered output. Fix dispatched as Factory session against ecodiaos-frontend, fork `fork_mogoon18_06acbd`. Companion fork `fork_mogoht5l_1aba06` is fixing streaming-lag - a separate concern but in the same component, so dispatch must be serialised per the shared-codebase rule.
