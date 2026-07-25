# InstaScript User Stories

InstaScript is a client-side React app that generates spoken-word hypnosis scripts from a short brief. Generation is powered by the OpenAI API (or a mock provider), grounded with example scripts retrieved from an OpenAI vector store. Everything persists to localStorage.

Stories are grouped by epic. Each story is marked:

- **[Implemented]** — working today
- **[Partial]** — some plumbing exists but the user-facing behaviour is incomplete
- **[Gap]** — not implemented; proposed to fill a missing piece of the experience

---

## Epic 1: Script Generation

### 1.1 Generate a script from a brief [Implemented]
As a user, I want to describe the script I'd like in a text box and submit it, so that a complete script is generated for me without further input.

Acceptance criteria:
- A prompt textarea on the home page with a submit button, disabled while empty
- Submitting creates a script entry, navigates to its page, and starts generation
- The script title defaults to the first 50 characters of the prompt

### 1.2 Watch the script stream in as it generates [Implemented]
As a user, I want to see the script appear section by section while it is being generated, so that I can start reading immediately and know progress is being made.

Acceptance criteria:
- Streamed content renders live on the script page
- A visible "Generating script..." status with `aria-live` while in progress
- Content is parsed into titled sections (`##` markdown headings) as it arrives

### 1.3 Ground generation in similar example scripts [Implemented]
As a user, I want generation to draw on relevant example scripts, so that output quality and style match proven material.

Acceptance criteria:
- The prompt is used to search a vector store for relevant examples
- The number of examples adapts to the available context window
- Generation proceeds gracefully with zero examples if the store is unavailable

### 1.4 Stop a generation in progress [Implemented]
As a user, I want to press Stop while a script is generating, so that I can abandon a generation that has gone in the wrong direction without waiting or paying for the rest.

Notes: `stopGeneration` aborts the in-flight request and streamed content is kept. The script's stored status is not updated on stop — that remains part of story 1.5.

Acceptance criteria:
- Pressing Stop aborts the in-flight API request
- Content streamed so far is kept and the script is marked as stopped/draft
- Regeneration is re-enabled after stopping

### 1.5 Recover from a failed or interrupted generation [Gap]
As a user, I want a clear error and a Retry action when generation fails (network error, invalid API key, page refresh mid-stream), so that I am not left with a permanently half-finished script.

Notes: today an error is only visible while the generating flag is set, and a refresh mid-stream leaves the script stuck with whatever was last throttled to storage; script `status` is never updated from `in-progress`.

Acceptance criteria:
- A failed generation shows a persistent error state on the script page with the reason
- A Retry button re-runs the generation using the original prompt and conversation
- On app load, scripts stuck in `in-progress` with no active generation are shown as interrupted, with a resume/retry option
- Script status transitions correctly: in-progress → complete (or draft/failed)

### 1.6 Refine the whole script with a follow-up instruction [Gap]
As a user, I want to give a follow-up instruction after generation (e.g. "make the induction slower and remove the counting"), so that I can iterate on the script conversationally instead of only regenerating sections verbatim.

Notes: conversations already store the full message history per generation, so multi-turn refinement is a natural extension.

Acceptance criteria:
- A follow-up input on the script page sends the instruction with full conversation history
- The revised script streams in and replaces/updates the affected sections
- Each refinement is stored as a new generation in the conversation

## Epic 2: Section-Level Editing

### 2.1 Regenerate an individual section [Implemented]
As a user, I want to regenerate a single section of the script, so that I can improve a weak section without losing the rest.

Acceptance criteria:
- Each section header shows a Regenerate button when no generation is running
- Regeneration sends the full conversation history plus a section-specific prompt
- The regenerated section streams in live and replaces the original in the consolidated document
- Regenerate is disabled while any generation is in progress

### 2.2 Regenerate a section with custom instructions [Gap]
As a user, I want to tell the app *how* to regenerate a section (e.g. "less repetition, more breathing focus"), so that regeneration is directed rather than a fixed "make it longer" prompt.

Notes: the current regeneration prompt is hardcoded to "at least 400 words / substantially longer".

Acceptance criteria:
- The Regenerate action optionally accepts a free-text instruction
- The instruction is combined with the section-regeneration prompt
- Leaving it empty falls back to the default behaviour

### 2.3 Manually edit script content [Gap]
As a user, I want to edit section text and the script title directly, so that I can make small wording fixes without burning a regeneration.

Acceptance criteria:
- Section content is editable in place; edits persist to storage
- The script title is editable from the script page or list
- Manual edits are preserved when other sections are regenerated
- Regenerating an edited section sends the current (edited) content as context, not the original generation

### 2.4 Show or hide section titles [Implemented]
As a user, I want to toggle section headings off, so that I can read (or perform) the script as continuous prose without structural markers.

Acceptance criteria:
- An eye toggle in the header on the script page
- The preference persists across sessions

## Epic 3: Script Library

### 3.1 Browse my scripts [Implemented]
As a user, I want a list of my scripts with title, creation date and status, so that I can find and reopen previous work.

Acceptance criteria:
- Scripts and Archive tabs (tab state reflected in the URL query string)
- Clicking an item opens the script page; items are keyboard-activatable
- Empty states for both tabs

### 3.2 Archive and delete scripts [Implemented]
As a user, I want to archive scripts I'm done with and delete ones I don't want, so that my active list stays manageable.

Acceptance criteria:
- Archive toggles between the active list and the archive
- Delete asks for confirmation and is irreversible
- Actions are available on hover/focus (desktop) and always visible on touch widths

### 3.3 Reach archive/delete actions from the keyboard [Implemented]
As a keyboard or screen-reader user, I want the archive and delete actions to be reachable without a mouse or touch gesture, so that the library is fully accessible.

Notes: action buttons are now always rendered and revealed on `:hover`/`:focus-within` (always visible on touch widths). The swipe gesture was removed in favour of this simpler model.

Acceptance criteria:
- Actions become visible/focusable when the list item or its contents receive keyboard focus

### 3.4 Search and sort the library [Gap]
As a user with many scripts, I want to search by title/prompt and sort by date, so that I can find a script quickly as the library grows.

Acceptance criteria:
- A search field filters the current tab by title and initial prompt
- Sort by newest/oldest; newest first by default
- Search and sort state live in the URL query string, consistent with the tab pattern

### 3.5 See meaningful metadata on each script [Partial]
As a user, I want each list item to show useful facts (word count, estimated spoken duration, model used), so that I can tell scripts apart at a glance.

Notes: the list renders `comments`, `status` and `length` fields, but nothing in the app ever sets `comments` or `length`; every item shows the static text "Generated Markdown". Word counts are already computed per section but never displayed.

Acceptance criteria:
- List items show creation date, status, total word count and estimated duration (e.g. at ~130 wpm)
- Dead fields are either populated or removed
- The script page header shows the same metadata (partially present today)
- The script's stored title updates to the generated document title once the outline produces one, replacing the truncated prompt

## Epic 4: Using the Finished Script

### 4.1 Copy or export a script [Gap]
As a user, I want to copy the whole script to the clipboard or download it as a markdown/text file, so that I can use it outside the app (print it, load it into a teleprompter, share it).

Acceptance criteria:
- Copy-to-clipboard for the full consolidated script
- Download as `.md` with the title as filename
- Export reflects the current consolidated state, including regenerated sections

### 4.2 Read-aloud / performance mode [Gap]
As a user performing the script, I want a distraction-free reading view with larger text and controllable scrolling, so that I can read it aloud comfortably.

Notes: scripts are explicitly written to be spoken (pacing marks `…` and `⏤`, bracketed stage directions), but the app has no reading affordance beyond the normal page.

Acceptance criteria:
- A full-screen reading mode with enlarged text and the section-title toggle respected
- Pacing marks and stage directions visually distinguished
- Optional auto-scroll at an adjustable speed

### 4.3 Duplicate a script as a starting point [Gap]
As a user, I want to duplicate an existing script into a new conversation, so that I can create a variant without destroying the original.

Acceptance criteria:
- Duplicate creates a new script and conversation seeded with the original content and prompt
- The copy is clearly titled (e.g. "Copy of ...")

## Epic 5: Configuration & Settings

### 5.1 Choose a theme [Implemented]
As a user, I want light, dark and system themes, so that the app matches my environment.

Acceptance criteria:
- Three-way toggle in settings; system mode tracks OS preference live
- Choice persists across sessions

### 5.2 Configure the API provider, model and key [Implemented]
As a user, I want to pick between the mock provider and OpenAI, choose a model, and store my API key, so that I control cost and quality.

Acceptance criteria:
- Provider select (mock default), model select (gpt-5 / mini / nano)
- API key field shown only for OpenAI, masked, with saved-state feedback
- Settings persist and are used by subsequent generations

### 5.3 Generate via OpenRouter [Implemented]
As a user, I want OpenRouter as a provider alongside OpenAI and mock, so that I can use a single key to reach many models — including ones better suited to adult creative writing than OpenAI's.

Notes: implemented via `openrouter.ts` with its own sessionStorage key, preset model shortlist plus a custom model-id input. The hosted vector store was removed at the same time, so example retrieval no longer depends on an OpenAI key. Model shortlist is hardcoded rather than fetched from OpenRouter's `/models` endpoint.

Acceptance criteria:
- Provider select gains OpenRouter, with its own key field and stored key
- Model selection for OpenRouter is a free-text model id plus a shortlist fetched from OpenRouter's `/models` endpoint
- Streaming generation and section regeneration work identically to OpenAI
- Example retrieval still works when the provider is OpenRouter (via local search, or degrades gracefully to none)
- The script's stored provider/model metadata reflects the OpenRouter model used

### 5.4 Validate the API key and surface configuration problems [Gap]
As a user, I want to know immediately if my API key is invalid or the vector store is missing, so that I don't discover it via a failed generation.

Notes: the vector store name (`hypno-default`) is hardcoded and failures are only logged to the console.

Acceptance criteria:
- A "test connection" action in settings verifies the key
- Missing vector store surfaces as a visible warning (generation still works without examples)
- The vector store name is configurable in settings (superseded by story 8.1 if retrieval moves local)

### 5.5 Clear all data [Implemented]
As a user, I want to wipe all conversations and scripts, so that I can remove everything from this browser in one action.

Acceptance criteria:
- Clear action in settings with a confirmation dialog
- Removes all script and conversation storage, including legacy formats, and returns to the home page

### 5.6 Understand how my data and key are stored [Gap]
As a privacy-conscious user of an adult-content app, I want to know that scripts and my API key live only in this browser's storage, so that I can make an informed decision about using it on a shared device.

Notes: API keys now live in sessionStorage (cleared when the browser closes) rather than localStorage — a real improvement. The in-UI disclosure is still missing.

Acceptance criteria:
- A short note in settings stating data is stored locally, unencrypted, in the browser
- The Clear All Data action is referenced as the removal mechanism

## Epic 6: Content Safeguards

### 6.1 Age acknowledgement [Gap]
As the operator, I want a one-time 18+ acknowledgement before the app can be used, so that the adult nature of the content is disclosed up front.

Acceptance criteria:
- A blocking, accessible dialog on first visit describing the content
- Acknowledgement persists in localStorage; declining shows a neutral exit page

## Epic 7: Data Portability

### 7.1 Persist everything across sessions [Implemented]
As a user, I want scripts and full generation history saved automatically, so that nothing is lost when I close the tab.

Acceptance criteria:
- Scripts stored per-key as YAML front-matter + markdown; legacy JSON is migrated on load
- Conversations store the complete message history and every generation, saved throttled during streaming and on completion

### 7.2 Export and import my library [Gap]
As a user, I want to export my whole library to a file and import it elsewhere, so that I can back it up or move between browsers, since localStorage is device-bound and evictable.

Acceptance criteria:
- Export produces a single file containing all scripts and conversations
- Import merges without duplicating existing IDs and validates the format

### 7.3 Store conversation history in OPFS [Gap]
As a user with a large script library, I want conversation history stored in the Origin Private File System instead of localStorage, so that storage is not constrained by localStorage quotas or blocking synchronous writes during streaming.

Notes: scripts already serialize as YAML front-matter + markdown; the same hybrid format would suit conversation files in OPFS.

Acceptance criteria:
- Conversations persist to OPFS with localStorage data migrated on first load
- Streaming saves no longer block the main thread
- Clear All Data removes OPFS content too

## Epic 8: Example Retrieval & Generation Quality

### Background: rethinking the retrieval and generation pipeline

**Current pipeline.** The user's brief is sent to OpenAI's hosted vector store search (`hypno-default`), which returns top-k *chunks* of example scripts. Those chunks are prepended to the prompt alongside the system prompt, and the whole script is generated in a single streamed completion. The example count adapts to the context budget (`getRecommendedExampleCount`), but selection is pure similarity ranking.

**Is this RAG, and is RAG still a good idea?** RAG as a concept remains standard practice, but naive top-k chunk retrieval — which is what this is — is the version that has aged poorly. More importantly, this use case is not really RAG at all. RAG grounds answers in knowledge the model lacks; InstaScript is doing *few-shot style transfer* — showing the model exemplars of the register, pacing and structure it should produce. Framed that way, the current implementation has two concrete defects:

1. **It retrieves chunks, not scripts.** The vector search returns mid-script fragments joined with newlines, so the model never sees a complete arc — while the system prompt's whole thesis is the induction → transformation → return arc. Whole scripts as exemplars teach structure, not just vocabulary.
2. **Top-k similarity on a narrow corpus returns near-duplicates.** Five very similar examples teach less than three deliberately different ones. Selection needs diversity (MMR or tag-bucket spreading), not just relevance.

It also couples retrieval to an OpenAI key, which blocks OpenRouter (story 5.3), and sends every brief to a second hosted service — a privacy cost given the content.

**Why local retrieval is easy here.** The corpus is tens-to-hundreds of scripts, not millions of documents. At that scale brute-force search over every example runs in microseconds — no vector database or ANN index is needed. Plain lexical search (BM25) is often competitive with embeddings on a corpus this small; in-browser embeddings (transformers.js, computed once per example and cached in IndexedDB) are the upgrade path if lexical selection proves visibly worse. Local retrieval works with any provider, costs nothing per query, works offline, and keeps briefs on the device.

**Improving the generation algorithm.** The highest-leverage change is outline-first generation (8.4): brief → structured plan (sections, themes, escalation curve, per-section word targets) → sections generated against the plan. This directly attacks what one-shot generation is bad at — pacing, hitting the 20–30 minute spoken target, controlled escalation — and improves existing features for free: section regeneration gets a real spec instead of the hardcoded "make it longer" prompt, the per-section word counts already computed (and currently discarded) become enforceable targets, and Stop gets clean section boundaries. The second, cheaper win is a critique pass (8.5): the system prompt states 14 explicit style rules; a review step that checks the draft against them and revises violating sections turns those rules from a request into an enforcement mechanism. Both are additions, not replacements — single-shot generation stays as the fast path.

### 8.1 Local example search [Partial]
As a user, I want example retrieval to run entirely in my browser against a local corpus, so that examples work with any provider, cost nothing per query, and my briefs are not sent to a second service.

Notes: the hosted vector store has been replaced by `bundledExamples.ts` — retrieval is now local, offline, key-free and provider-agnostic. However `searchExamples` ignores the query entirely and returns the first N bundled examples, so there is no *search*: no relevance ranking and no diversity. The remaining work is the selection itself. The corpus is small (tens to low hundreds of scripts), so brute-force search is fine — no ANN index needed. Two viable levels: (a) lexical search (BM25 via a small library such as minisearch) over title/tags/body, which is likely competitive at this corpus size; (b) embeddings via transformers.js (e.g. bge-small) computed at import time and stored in IndexedDB, with the query embedded on device. Start with (a); add (b) only if selection quality demands it.

Acceptance criteria:
- Example scripts live locally (bundled corpus and/or user-imported files) with metadata (title, tags, themes)
- Retrieval returns whole scripts, not chunks
- Search runs offline with no API key and works identically for OpenAI and OpenRouter providers
- The hosted vector store path is removed (or kept behind a flag during transition)

### 8.2 Manage my example corpus [Gap]
As a user, I want to import, tag and remove my own example scripts, so that generation is grounded in material whose style I actually want.

Acceptance criteria:
- Import markdown files as examples; my own completed scripts can be promoted to examples
- Examples carry editable tags/themes used in selection
- A corpus view lists examples with the ability to delete or re-tag

### 8.3 Diverse, budget-aware exemplar selection [Gap]
As a user, I want the app to pick a small set of *different* high-quality examples that fit the context budget, so that the model sees range rather than five variations of the same script.

Notes: the context-window-aware count logic already exists (`getRecommendedExampleCount`); this story changes *which* examples fill that budget. Select by relevance, then apply diversity (e.g. maximal marginal relevance or simple tag-bucket spreading), preferring whole scripts whose combined size fits the budget.

Acceptance criteria:
- Selected examples are deduplicated by similarity/tags, not just top-k
- Selection respects the computed token budget using real example sizes
- The script page (or a debug view) can show which examples informed a generation

### 8.4 Outline-first generation [Partial]
As a user, I want generation to first produce a plan — section list, themes, escalation arc, per-section word targets — and then write each section against that plan, so that pacing and structure are controlled rather than hoped for.

Notes: the core pipeline is implemented — an outline-then-sections state machine generates each section against its outline entry (~400-word target), the outline is stored as generation 0, and the word-count meter shows per-section progress against the target during generation. Remaining: out-of-range sections are not automatically retried, and *regeneration* of an existing section still uses the old hardcoded "make it longer" prompt rather than the section's outline entry.

Acceptance criteria:
- Stage 1 produces a structured outline from the brief (and exemplars); stage 2 generates sections sequentially with the outline and prior sections as context
- Each section is checked against its word-count target; out-of-range sections are automatically retried once
- The outline is stored with the conversation and shown on the script page
- Section regeneration uses the section's outline entry plus surrounding sections, replacing the current hardcoded "make it longer" prompt

### 8.5 Style-rule critique pass [Gap]
As a user, I want an optional automatic review pass that checks the draft against the style rules (pacing marks, breathwork, affirmative language, no clichéd visualisations, escalation) and revises sections that violate them, so that quality is enforced rather than requested.

Acceptance criteria:
- The critique uses the same style rules as the system prompt, kept in one place
- Violations produce targeted section revisions, not a full rewrite
- The pass is optional (adds cost/latency) and reports what it changed

### 8.6 See generation resource usage [Implemented]
As a user, I want to see the context-token composition of the conversation behind a script, so that I understand what each generation costs and how close it is to context limits.

Acceptance criteria:
- A token usage bar on the script page segments estimated context by role (system/user/assistant), with per-segment tooltips and a legend

## Epic 9: Visual Design

### 9.1 Design pass over the whole UI [Implemented]
As a user, I want the app to have a deliberate visual identity — typography, spacing, colour, and motion chosen with intent — so that it feels like a finished product rather than unstyled semantic HTML.

Notes: implemented as the "dusk" system — theme tokens (violet-cast paper light / midnight dark, one dusk-violet accent), the script reading surface in Spectral at book scale with Cormorant Garamond display type, a breathing generation indicator and `· · ·` pacing marks between sections, visible focus rings, and reduced-motion support. Inline styles were swept out of TSX except genuinely dynamic values.

Acceptance criteria:
- A defined type scale and reading-optimised script page (measure, line-height, generous body size)
- Consistent spacing, focus states, and interactive affordances across all views and both themes
- Empty states, loading/streaming states, and error states styled intentionally, not as bare paragraphs
- Inline styles removed from TSX except where values are computed at runtime
- Existing semantic-HTML/classless approach and accessibility attributes preserved
