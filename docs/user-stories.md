# InstaScript User Stories

InstaScript is a client-side React app that generates spoken-word hypnosis scripts from a short brief. Generation is powered by OpenAI or OpenRouter (or a mock provider), outline-first, grounded with example scripts selected from a local corpus. Scripts persist to localStorage; conversations persist to OPFS.

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
- The prompt is used to search the local example corpus for relevant examples
- The number of examples adapts to the available context window
- Generation proceeds gracefully with zero examples if the store is unavailable

### 1.4 Stop a generation in progress [Implemented]
As a user, I want to press Stop while a script is generating, so that I can abandon a generation that has gone in the wrong direction without waiting or paying for the rest.

Notes: `stopGeneration` aborts the in-flight request; streamed content is kept and the script is marked draft.

Acceptance criteria:
- Pressing Stop aborts the in-flight API request
- Content streamed so far is kept and the script is marked as stopped/draft
- Regeneration is re-enabled after stopping

### 1.5 Recover from a failed or interrupted generation [Implemented]
As a user, I want a clear error and a Retry action when generation fails (network error, invalid API key, page refresh mid-stream), so that I am not left with a permanently half-finished script.

Notes: on completion the script status becomes complete and its title/length update from the generated document; stop or terminal error settles to draft. Interrupted scripts (in-progress with no active generation at load) are reconciled to draft and offered Retry.

Acceptance criteria:
- A failed generation shows a persistent error state on the script page with the reason
- A Retry button re-runs the generation using the original prompt and conversation
- On app load, scripts stuck in `in-progress` with no active generation are shown as interrupted, with a resume/retry option
- Script status transitions correctly: in-progress → complete (or draft/failed)

### 1.6 Refine the whole script with a follow-up instruction [Implemented]
As a user, I want to give a follow-up instruction after generation (e.g. "make the induction slower and remove the counting"), so that I can iterate on the script conversationally instead of only regenerating sections verbatim.

Notes: conversations already store the full message history per generation, so multi-turn refinement is a natural extension.

Acceptance criteria:
- A follow-up input on the script page sends the instruction with full conversation history
- The revised script streams in and replaces/updates the affected sections
- Each refinement is stored as a new generation in the conversation

### 1.7 Keep my refinement instruction when it fails [Implemented]
As a user, I want a failed refinement to leave my typed instruction in the input, so that a network hiccup doesn't cost me the text I wrote.

Acceptance criteria:
- The refinement input clears only after the request succeeds; on failure the typed instruction is restored
- The failure reason is shown alongside the preserved input

### 1.8 Resume an interrupted generation [Implemented]
As a user, I want Retry after a mid-stream reload or failure to continue from the first incomplete section, so that completed work isn't regenerated from scratch.

Notes: the outline and completed sections are already persisted per-generation, so resumption is a matter of re-entering the section loop at the right index rather than restarting at the outline.

Acceptance criteria:
- Retry on an interrupted script keeps the outline and completed sections and resumes at the first incomplete one
- A full restart remains available as an explicit choice

### 1.9 Make the run lifecycle a tested unit [Implemented]
As the maintainer, I want the single-active-run invariant (new runs await settlement of the previous, aborts can never clobber a successor's state) extracted into a small standalone state machine with its own tests, so that the concurrency logic that has already produced race bugs is provable rather than woven through the orchestrator.

Acceptance criteria:
- Run admission, settlement, and abort-cleanup live in one module with no UI dependencies
- Tests cover stop-during-stream, start-during-settlement, and abort-after-replacement orderings

## Epic 2: Section-Level Editing

### 2.1 Regenerate an individual section [Implemented]
As a user, I want to regenerate a single section of the script, so that I can improve a weak section without losing the rest.

Acceptance criteria:
- Each section header shows a Regenerate button when no generation is running
- Regeneration sends the full conversation history plus a section-specific prompt
- The regenerated section streams in live and replaces the original in the consolidated document
- Regenerate is disabled while any generation is in progress

### 2.2 Regenerate a section with custom instructions [Implemented]
As a user, I want to tell the app *how* to regenerate a section (e.g. "less repetition, more breathing focus"), so that regeneration is directed rather than a fixed "make it longer" prompt.

Notes: an optional instruction input on each section header is appended to the outline-aware regeneration prompt.

Acceptance criteria:
- The Regenerate action optionally accepts a free-text instruction
- The instruction is combined with the section-regeneration prompt
- Leaving it empty falls back to the default behaviour

### 2.3 Manually edit script content [Implemented]
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

### 2.5 Reach section actions with titles hidden [Implemented]
As a user reading continuous prose, I want section-level Edit and Regenerate to remain reachable when section titles are toggled off, so that hiding structure doesn't hide functionality.

Acceptance criteria:
- With titles hidden, each section still exposes its actions (e.g. on hover/focus of the section body)
- Keyboard access is preserved in both modes

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

### 3.4 Search and sort the library [Implemented]
As a user with many scripts, I want to search by title/prompt and sort by date, so that I can find a script quickly as the library grows.

Acceptance criteria:
- A search field filters the current tab by title and initial prompt
- Sort by newest/oldest; newest first by default
- Search and sort state live in the URL query string, consistent with the tab pattern

### 3.5 See meaningful metadata on each script [Implemented]
As a user, I want each list item to show useful facts (word count, estimated spoken duration, model used), so that I can tell scripts apart at a glance.

Notes: the list renders `comments`, `status` and `length` fields, but nothing in the app ever sets `comments` or `length`; every item shows the static text "Generated Markdown". Word counts are already computed per section but never displayed.

Acceptance criteria:
- List items show creation date, status, total word count and estimated duration (e.g. at ~130 wpm)
- Dead fields are either populated or removed
- The script page header shows the same metadata (partially present today)
- The script's stored title updates to the generated document title once the outline produces one, replacing the truncated prompt

## Epic 4: Using the Finished Script

### 4.1 Copy or export a script [Implemented]
As a user, I want to copy the whole script to the clipboard or download it as a markdown/text file, so that I can use it outside the app (print it, load it into a teleprompter, share it).

Acceptance criteria:
- Copy-to-clipboard for the full consolidated script
- Download as `.md` with the title as filename
- Export reflects the current consolidated state, including regenerated sections

### 4.2 Read-aloud / performance mode [Implemented]
As a user performing the script, I want a distraction-free reading view with larger text and controllable scrolling, so that I can read it aloud comfortably.

Notes: scripts are explicitly written to be spoken (pacing marks `…` and `⏤`, bracketed stage directions), but the app has no reading affordance beyond the normal page.

Acceptance criteria:
- A full-screen reading mode with enlarged text and the section-title toggle respected
- Pacing marks and stage directions visually distinguished
- Optional auto-scroll at an adjustable speed

### 4.3 Duplicate a script as a starting point [Implemented]
As a user, I want to duplicate an existing script into a new conversation, so that I can create a variant without destroying the original.

Acceptance criteria:
- Duplicate creates a new script and conversation seeded with the original content and prompt
- The copy is clearly titled (e.g. "Copy of ...")
- Duplicating a script whose generation is still streaming gives the copy an honest status (an in-progress source duplicates as a draft)

### 4.4 Hear the script read aloud [Implemented]
As a user, I want an optional read-aloud mode using the browser's speech synthesis, so that I can listen to the script — or rehearse against it — without any external service.

Notes: scripts are written to be spoken; performance mode's auto-scroll pacing is the natural timing source. speechSynthesis is free, local, and consistent with the no-backend architecture, at the cost of voice quality.

Acceptance criteria:
- Play/pause read-aloud from performance mode, honouring pacing marks with pauses
- Voice and rate are selectable from the browser's available voices
- The scrolled position follows the spoken position

### 4.5 Hear the script in a natural voice [Implemented]
As a user, I want the option of a hosted text-to-speech voice through OpenRouter, so that rehearsal and listening sound like a person rather than a system voice.

Notes: browser speech synthesis stays the default — free, offline, and requiring no key — with the hosted voice offered alongside it whenever an OpenRouter key is saved. Hosted speech is billed per character, so utterances are cached and a replay of an unchanged script costs nothing. Pacing is unchanged between engines: the script is sent one line at a time and the silences from pacing marks are timed locally, which also keeps the spoken-position highlight working.

Acceptance criteria:
- Engine, model, voice and rate are selectable from performance mode, and the choices persist
- Section headings and stage directions are never spoken, whichever engine is used
- Generated audio is cached per model, voice and line, so an unchanged replay makes no request
- The cache is held to a budget in bytes, discarding the least recently heard line first, and settings shows what it is holding with a control to clear it
- A rate-limited or briefly unavailable request is tried again with exponential backoff, and the wait is shown so it does not look like a stall
- A failed request (rejected key, no network) stops read-aloud and says why, without leaving the view

### 4.6 Export the read-aloud as one recording [Implemented]
As a user, I want to download the whole script as a single paced audio file, so that I can listen to it away from the app — on a phone, in a player, without a browser tab open.

Notes: read-aloud plays the script fragment by fragment and times the silences locally, which is what keeps the spoken-position highlight working but leaves nothing behind. Export renders the same plan into one file: each utterance is synthesised and decoded, each pacing mark becomes real silence, and the pieces are laid end to end. It is offered with the hosted voice only — browser speech synthesis exposes no audio to capture. The file is 16-bit mono WAV, the one format a browser can write without a codec. There is no batch text-to-speech endpoint and pricing is per input character, so one request per fragment costs no more than one request for the whole script — which is also OpenRouter's own advice for long text: split at natural boundaries, keep the model and voice constant, concatenate.

Acceptance criteria:
- Export from performance mode, using the model, voice and rate already chosen there
- The recording has the same pacing as read-aloud: pacing marks and paragraph breaks become silence, and headings and stage directions are never voiced
- Utterances come from the same cache as read-aloud, so a script already played through costs nothing to record, and a line the script repeats is synthesised once
- Progress is shown by line while rendering, and the export can be cancelled part-way
- A rate limit part-way through costs a pause, not the whole recording: the request is retried with backoff and the wait is shown
- A failed request stops the export and says why, without leaving the view

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

### 5.4 Validate the API key and surface configuration problems [Implemented]
As a user, I want to know immediately if my API key is invalid or the vector store is missing, so that I don't discover it via a failed generation.

Notes: implemented as a Test connection button per provider (OpenAI/OpenRouter) performing a cheap authenticated models call with an inline result. The vector-store criteria below are obsolete — hosted retrieval was removed in favour of the local corpus (8.1).

Acceptance criteria:
- A "test connection" action in settings verifies the key
- Missing vector store surfaces as a visible warning (generation still works without examples)
- The vector store name is configurable in settings (superseded by story 8.1 if retrieval moves local)

### 5.5 Clear all data [Implemented]
As a user, I want to wipe all conversations and scripts, so that I can remove everything from this browser in one action.

Acceptance criteria:
- Clear action in settings with a confirmation dialog
- Removes all script and conversation storage, including legacy formats, and returns to the home page
- In-memory conversation state is reset in the same action, so cleared data cannot reappear before a reload

### 5.6 Understand how my data and key are stored [Implemented]
As a privacy-conscious user of an adult-content app, I want to know that scripts and my API key live only in this browser's storage, so that I can make an informed decision about using it on a shared device.

Notes: a factual disclosure in Settings' data section covers localStorage scripts, OPFS conversations, sessionStorage keys, and Clear All Conversations as the removal mechanism.

Acceptance criteria:
- A short note in settings stating data is stored locally, unencrypted, in the browser
- The Clear All Data action is referenced as the removal mechanism

### 5.7 Use a small model for the jobs that do not need a big one [Implemented]
As a user paying per token, I want the background jobs around a script — tagging an imported example, tidying a plain-text import into markdown — handled by a small cheap model rather than the one I chose for writing, so that they are faster and cost a fraction of a generation.

Notes: implemented as model *roles*. `generation` keeps the existing model setting; `utility` is a second setting with its own per-provider default (gpt-5-nano / grok-3-mini) and the same custom-model-id escape hatch on OpenRouter. Utility requests are non-streaming, carry neither the hypnosis system prompt nor the example corpus, and ask OpenAI's gpt-5 family for minimal reasoning effort. Both jobs verify the reply in code before storing it — tags are parsed and capped, and a formatting result that lost or invented prose is discarded in favour of the import as it arrived.

Acceptance criteria:
- Settings offers a utility model alongside the generation model, per provider, persisted like the rest
- Importing an untagged example asks the utility model for tags, offering the corpus's existing tag vocabulary so suggestions converge
- Importing unstructured plain text asks the utility model to lay it out as markdown headings and paragraphs, and never accepts a result that changed the script's words
- Both jobs run after the import is saved, so a failure, a refusal or no configured provider leaves the import exactly as it was
- The pass can be switched off, keeping imports entirely local
- Utility requests appear in the debug transcripts with their own labels

## Epic 7: Data Portability

### 7.1 Persist everything across sessions [Implemented]
As a user, I want scripts and full generation history saved automatically, so that nothing is lost when I close the tab.

Acceptance criteria:
- Scripts stored per-key as YAML front-matter + markdown; legacy JSON is migrated on load
- Conversations store the complete message history and every generation, saved throttled during streaming and on completion

### 7.4 Protect me from silent data loss [Implemented]
As a user whose whole library lives in one browser profile, I want the app to help me keep a backup, so that clearing browser data or losing the device doesn't silently destroy my scripts.

Notes: OPFS and localStorage vanish with the profile; export exists (7.2) but relies on the user remembering. Two tiers: a lightweight nudge, and — where the File System Access API is available — a linked backup folder written to automatically.

Acceptance criteria:
- The app tracks when the library was last exported and surfaces a non-blocking reminder when it is stale relative to new work
- Optionally, a user-linked backup folder receives the export automatically after significant changes
- Both behaviours are opt-out and never send data anywhere remote

### 7.2 Export and import my library [Implemented]
As a user, I want to export my whole library to a file and import it elsewhere, so that I can back it up or move between browsers, since localStorage is device-bound and evictable.

Acceptance criteria:
- Export produces a single file containing all scripts and conversations
- Import merges without duplicating existing IDs and validates the format

### 7.3 Store conversation history in OPFS [Implemented]
As a user with a large script library, I want conversation history stored in the Origin Private File System instead of localStorage, so that storage is not constrained by localStorage quotas or blocking synchronous writes during streaming.

Notes: conversations persist to OPFS (one file per conversation, YAML front-matter + markdown) behind a small storage interface with a serialized write queue; legacy localStorage conversations migrate on first load, and localStorage remains the fallback where OPFS is unavailable.

Acceptance criteria:
- Conversations persist to OPFS with localStorage data migrated on first load
- Streaming saves no longer block the main thread
- Clear All Data removes OPFS content too

## Epic 8: Example Retrieval & Generation Quality

### Background: why the pipeline is shaped this way

**This is few-shot style transfer, not RAG.** The app originally used OpenAI's hosted vector store, retrieving top-k *chunks* of example scripts by similarity. That was the wrong shape twice over: RAG grounds answers in knowledge the model lacks, whereas InstaScript shows the model exemplars of register, pacing and structure — so whole scripts matter (the arc is the point), and diversity matters more than raw similarity (five near-duplicates teach less than three deliberately different scripts). Hosted retrieval also coupled examples to an OpenAI key and sent every brief to a second service — a privacy cost given the content.

**Why retrieval is local.** The corpus is tens-to-hundreds of scripts, so brute-force lexical search (hand-rolled BM25 over title/tags/content) runs in microseconds, works offline with any provider, and keeps briefs on-device. Selection applies MMR-style diversity and fits whole scripts to the context-window budget. In-browser embeddings (transformers.js cached in IndexedDB) remain the upgrade path if lexical selection ever proves visibly worse.

**Why generation is outline-first.** A single streamed completion is bad at pacing, the 20–30 minute spoken target, and controlled escalation. Generating an outline (sections, themes, per-section word targets) and then writing each section against it makes those properties enforceable: word counts become targets with automatic retry, section regeneration has a real spec, and Stop lands on section boundaries. The optional critique pass (8.5) closes the loop by checking drafts against the system prompt's style rules and revising violations, turning the rules from a request into an enforcement mechanism.

### 8.1 Local example search [Implemented]
As a user, I want example retrieval to run entirely in my browser against a local corpus, so that examples work with any provider, cost nothing per query, and my briefs are not sent to a second service.

Notes: hand-rolled BM25 lexical ranking over tokenized title/tags/content of the user corpus, plus the bundled sample scripts when they are switched on, unit-tested; whole scripts, no chunks, no network, no key.

Acceptance criteria:
- Example scripts live locally (user-imported files, plus an optional bundled corpus that is off by default) with metadata (title, tags, themes)
- Retrieval returns whole scripts, not chunks
- Search runs offline with no API key and works identically for OpenAI and OpenRouter providers
- The hosted vector store path is removed (or kept behind a flag during transition)

### 8.2 Manage my example corpus [Implemented]
As a user, I want to import, tag and remove my own example scripts, so that generation is grounded in material whose style I actually want.

Acceptance criteria:
- Import markdown files as examples; my own completed scripts can be promoted to examples
- Examples carry editable tags/themes used in selection
- A corpus view lists examples with the ability to delete or re-tag

### 8.3 Diverse, budget-aware exemplar selection [Implemented]
As a user, I want the app to pick a small set of *different* high-quality examples that fit the context budget, so that the model sees range rather than five variations of the same script.

Notes: relevance-ranked candidates are filtered by greedy MMR-style diversity (token-overlap penalty against already-selected examples) and fitted to the token budget using actual example sizes. The examples that informed a generation are recorded on the conversation and shown on the script page.

Acceptance criteria:
- Selected examples are deduplicated by similarity/tags, not just top-k
- Selection respects the computed token budget using real example sizes
- The script page (or a debug view) can show which examples informed a generation

### 8.4 Outline-first generation [Implemented]
As a user, I want generation to first produce a plan — section list, themes, escalation arc, per-section word targets — and then write each section against that plan, so that pacing and structure are controlled rather than hoped for.

Notes: an outline-then-sections state machine generates each section against its outline entry (~400-word target); the outline is stored as generation 0 and the word-count meter shows per-section progress. Sections completing outside roughly 250–600 words are retried once, keeping the attempt closer to target. Section regeneration builds its prompt from the outline entry and surrounding sections.

Acceptance criteria:
- Stage 1 produces a structured outline from the brief (and exemplars); stage 2 generates sections sequentially with the outline and prior sections as context
- Each section is checked against its word-count target; out-of-range sections are automatically retried once
- The outline is stored with the conversation and shown on the script page
- Section regeneration uses the section's outline entry plus surrounding sections, replacing the current hardcoded "make it longer" prompt

### 8.5 Style-rule critique pass [Implemented]
As a user, I want an optional automatic review pass that checks the draft against the style rules (pacing marks, breathwork, affirmative language, no clichéd visualisations, escalation) and revises sections that violate them, so that quality is enforced rather than requested.

Acceptance criteria:
- The critique uses the same style rules as the system prompt, kept in one place
- Violations produce targeted section revisions, not a full rewrite
- The pass is optional (adds cost/latency) and reports what it changed

### 8.6 See generation resource usage [Implemented]
As a user, I want to see the context-token composition of the conversation behind a script, so that I understand what each generation costs and how close it is to context limits.

Acceptance criteria:
- A token usage bar on the script page segments estimated context by role (system/user/assistant), with per-segment tooltips and a legend

### 8.7 Hybrid example retrieval [Implemented]
As a user with a growing corpus, I want retrieval to catch stylistic matches that share no vocabulary with my brief, so that "slow, heavy, sinking" can surface an example that achieves that mood in different words.

Notes: BM25 is lexical-only; the research consensus is that fusing lexical and dense signals beats either alone. A small quantized embedding model run client-side (e.g. via transformers.js, ~20MB cached) keeps the no-backend constraint. Corpus embeddings are computed once at import time and stored with each example; only the brief is embedded at generation time. Scores fuse with BM25 via reciprocal rank fusion, feeding the existing diversity pass (8.3).

Acceptance criteria:
- Example ranking combines BM25 and embedding similarity; either signal alone still works if the other is unavailable
- Corpus embeddings are computed at import/promotion time, not per generation
- The embedding model loads lazily and everything stays client-side

### 8.8 Deliberate exemplar ordering [Implemented]
As a user, I want the strongest examples placed where they influence generation most, so that ordering — which research shows can swing few-shot output quality substantially — is a choice rather than an accident.

Acceptance criteria:
- The most relevant exemplar is placed closest to the instruction (last in the prompt)
- The ordering rule lives in one place in the prompt-assembly code and is covered by a test

### 8.9 Critique the outline before writing [Implemented]
As a user, I want the outline reviewed and revised before any section is written, so that the plan every section inherits is checked for arc, escalation, pacing, and brief coverage at the moment it is cheapest to fix.

Notes: the outline is the highest-leverage artifact in the pipeline — sections cannot see forward, so structural flaws in the outline propagate everywhere. One extra call against the brief and style rules costs far less than the section-level critique pass (8.5).

Acceptance criteria:
- After the outline is generated, a critique step checks it against the brief (coverage, escalation arc, section balance) and revises it if needed
- The revised outline replaces generation 0 before section writing begins
- The step is skippable via the same setting surface as the review pass

### 8.10 Let sections see what comes next [Implemented]
As a user, I want each section written with awareness of the upcoming sections, so that the script can plant setups and callbacks instead of only reacting to what came before.

Notes: the outline already contains every section's title and summary; this is a prompt change, not a pipeline change.

Acceptance criteria:
- The section prompt includes the outline entries for upcoming sections alongside prior content
- Token budgeting accounts for the added context

### 8.11 See which examples earn their place [Implemented]
As a user curating a corpus, I want to see how often each example is actually selected for generations, so that I can prune dead weight and learn what makes an example useful.

Notes: per-generation traceability of selected examples already exists; this surfaces it in aggregate on the examples page.

Acceptance criteria:
- Each example on the examples page shows how many generations it has been selected for
- Counts persist with the corpus and survive export/import

### 8.12 Understand what a script cost [Implemented]
As a user paying per token, I want a running estimate of tokens spent (and approximate cost for the selected model) per script, so that I can weigh refinement and regeneration against my budget — especially on OpenRouter where model prices vary widely.

Acceptance criteria:
- The script page shows cumulative estimated input/output tokens across all generations of the script
- Where the model's pricing is known, an approximate cost is shown alongside
- Estimates are labelled as estimates

### 8.13 Keep conversation history well-formed [Implemented]
As the maintainer, I want the flattened history sent to providers to contain exactly one system message with refinement instructions expressed as user turns, so that provider behaviour is predictable and context is not wasted.

Acceptance criteria:
- Prompt assembly normalises history to a single system message regardless of how many refinements have occurred
- A test asserts the invariant over a multi-refinement conversation

### 8.14 Review a finished script for cohesion and length [Implemented]
As a user, I want to ask for the finished script to be judged as a whole — does it read as one continuous arc, and is it the length it is meant to be — so that the defects no per-section check can see get found and fixed.

Notes: complements 8.5 rather than repeating it. The style pass judges each section against the numbered rules in isolation; this one judges the script as a single artifact — continuity from one section to the next, escalation, repetition across sections, setups that are never paid off, and coverage of the brief. Length is measured locally and stated to the model as fact rather than estimated by it, and drives explicit word targets for the rewrites. Section targets were raised at the same time (six sections at ~550 words) so generation lands in the 20-30 minute window natively instead of relying on this pass to get there.

Acceptance criteria:
- A "Review script" button appears on a completed script and is unavailable while anything is generating
- The review judges the script as it currently stands, including manual edits, regenerations and refinements
- It reviews against the original brief, and against the measured word count and its 20-30 minute spoken target
- Sections that break the arc are rewritten with the specific problem as the instruction; when the script is off target the rewrites also carry explicit word targets, shared out so no section is asked for an implausible rewrite
- The number of rewrites per review is capped, and the outcome (what was rewritten, why, and the resulting length) appears in the review summary banner
- A failed review is reported next to its own button without marking the generation as failed

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
