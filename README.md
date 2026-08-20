# InstaScript

InstaScript generates long-form hypnosis scripts for adults from a short brief. It is a client-side React app: scripts stream in section by section, can be regenerated per section, and everything persists in the browser — there is no backend.

**Content note:** the app generates erotic hypnosis scripts and is intended for adults.

## How it works

An optional briefing stage sits in front of generation: switched on from the composer, it asks three to five multiple-choice questions about what the brief leaves open — a trigger word, what should persist after the session, who is speaking to whom — each with concrete suggestions, a free-text answer and a "decide for me". The answers are appended to the brief; everything after that is unchanged.

A brief is expanded in two stages: the model first produces an outline (section list with per-section word targets), then writes each section against that outline with example scripts as few-shot style exemplars. Examples are whatever you import (markdown or text files, individually or a whole folder) or promote from your own scripts. They are filed into folders — created outright, or arriving with an import, which files each script under the folder it sits in unless you pick a destination — and exactly one folder grounds generation at a time, so several bodies of material can live side by side, be switched between, renamed, and deleted as a unit. A small bundled placeholder corpus ships with the app and can be switched on from the Examples page, but is off by default so generation is grounded only in your own material. Examples carry tags of two kinds: free topic tags, and a short standard vocabulary — how explicit the script is, whether it is written for a woman, a man or anyone, and whether it installs triggers, post-hypnotic suggestions, amnesia or aftercare — picked from controls rather than typed, so a corpus can be grouped and searched on those properties however they were originally worded. Generation streams live into a sectioned reading view, with per-section word-count and context-token meters. Each section can be regenerated individually using the full conversation history.

Providers: OpenAI, OpenRouter (any model id), or a mock provider for development — selected in settings along with the model and API key. API keys are held in sessionStorage; scripts and conversations are stored in localStorage as YAML front-matter + markdown.

Two models are configured, not one: the **generation** model writes the scripts, and a small, cheap **utility** model handles the short jobs around them — suggesting tags for an imported example and laying an unstructured plain-text import out as markdown. Both run after the import is saved and verify the model's reply before storing it, so a formatting pass that reworded the script is discarded and the import kept as it was. The pass can be switched off in settings to keep imports entirely local.

The same model does that work on demand over a corpus already collected: a **clean up** button on each folder — and on each example's row — names the scripts still titled after the file they arrived in, divides the ones with no sections into sections with a spec each, and brings tags from before the standard vocabulary up to it. It is offered only where one of those three has something to do, the words of every script are checked to have survived before anything is stored, and a failed request leaves that job undone rather than the example damaged.

A corpus is quoted to the model in full but never described to it, so what its scripts have in common is left to be inferred — and an inference from examples loses to a rule written down. **Read the corpus** on a folder closes that gap: the utility model reads each script for the devices it uses, then says which of them the collection has in common, and the handful that come back are sent with the exemplars as a short numbered supplement, and judged against by the style review as well as the rules. Where a device and the app's own style rules disagree about wording, rhythm or register the device wins; where following one would drop something a rule requires, the rule does. Nothing in the corpus is changed by the pass, quotes are checked to be really in it before they are stored, and a folder that has moved on since it was read says so.

The same pass then reads the devices it found for what in them belongs to that collection and to nobody else — a hypnotist's or a character's name, a coined trigger word, a phrase this writer minted — and says each of those moves again without them. **Corpus style** on the composer picks which of the two a generation gets. *Faithful* sends the devices as they were read, cue words and names and all. *Generic* sends the moves without the particulars: a marked device is sent in its restated form, one that could not be said without the collection's own words is left out rather than smuggling them through, and the exemplars are prefaced with what they are being read for. The ordinary words of the craft — drop, deeper, breathe, let go — belong to nobody and are used either way, as is anything the brief itself asks for by name. Every word claimed to be the collection's own is checked to be in the device that claimed it, and a restatement that still carries one is discarded while the marking is kept, so a generic run drops that device instead of trusting it.

Standing instructions live in settings, so a preference is stated once rather than in every brief: one field for the **overall style** every script is written in, which rides the system prompt every writing request shares and the style rules the review pass judges against, and one for **imported material**, which rides the utility model's import passes. Either left empty sends the prompts exactly as they ship, and the import checks still discard a pass that reworded a script.

## Functionality inventory

An audit of everything the app does today, for use as a porting checklist. It
describes the code as it stands, not the backlog — [docs/user-stories.md](docs/user-stories.md)
remains the record of intent, and every story in it is currently marked
Implemented.

### Shape

A single-page React app with **no backend of any kind**. Every request goes
from the browser straight to the model provider with a key the user pasted;
everything else — the corpus, the scripts, the conversations, the retrieval,
the embeddings — runs and lives in the browser. Ported to a new harness, the
app needs a static host and nothing else, but it is unusually dependent on
browser storage and media APIs (see [Platform APIs](#platform-apis-required)).

- ~32k lines of TypeScript across `src`, of which ~9k is tests
- Router basename `/instascript`, `vite.config.ts` `base: '/instascript/'`, and
  the build copies `dist/index.html` to `dist/404.html` for GitHub Pages SPA
  fallback. **All three must change together when the deploy path changes.**
- Deployed by `.github/workflows/deploy.yml` to GitHub Pages on push to `main`

### Surfaces

| Route | Page | What it holds |
| --- | --- | --- |
| `/` | `HomePage` | Composer (brief, length, briefing toggle, corpus-style select) and the script library (tabs, search, sort) |
| `/script/:id` | `ScriptPage` | Conversation thread, sectioned script document, per-section actions, progress/usage meters, performance mode |
| `/examples` | `ExamplesPage` | Corpus folder rail and folder view, import forms, cleanup and device passes, library promotion |
| — | `SettingsModal` | Global dialog reachable from the header on every route |

The header is shared: back, script title (inline rename), copy, download,
performance mode, section-title visibility, corpus link, settings.

### Feature inventory

#### Generation

| Feature | Notes |
| --- | --- |
| Brief → script | Free-text brief; script id, title (first 50 chars), provider and model recorded at creation |
| Target length | Slider, 10–60 min in 5-min steps, default 25; drives a `LengthPlan` (130 wpm, 3–12 sections, ±15%/25% tolerance) |
| Briefing stage | Optional. One pre-generation request asks 3–6 multiple-choice questions with suggestions, free text and "decide for me"; answers are appended to the brief. Uses the **generation** model, stored nowhere |
| Outline-first pipeline | Outline → optional outline critique → section-by-section writing → optional style review |
| Streaming | Sections stream into the document live; conversation saves throttled to 1/s |
| Short-section retry | A section under 400 words is retried once and the better of the two attempts kept |
| Corpus grounding | Exemplars retrieved once per run and reused for later rewrites in the same session |
| Corpus style fidelity | `faithful` (devices as read) or `generic` (devices restated without the corpus's own names and cue words) |
| Stop / retry / start over | `AbortController` behind `RunLifecycle`; `KeyedRunGuard` prevents two runs on one conversation |
| Resume | `findResumeState` recovers an interrupted run from the stored outline plus completed sections; an outline that is the last generation is distrusted as possibly truncated |
| Phase machine | `idle → generating_outline → generating_section → reviewing → complete \| error`, with section index/total and per-section word counts |

#### Section and script editing

Regenerate one section; regenerate with a custom instruction; edit a section's
text by hand; refine the whole script with a follow-up instruction (the
instruction survives a failure); review the finished script for cohesion and
length (up to 3 revisions); show or hide section titles.

#### Library

Browse active/archived tabs, search by title and prompt, sort newest/oldest —
all three held in the URL query (`state`, `q`, `sort`). Duplicate a script
(copies the conversation), archive/unarchive, delete.

#### Using the finished script

Copy consolidated markdown to the clipboard; download as `.md`; performance
mode — a modal `<dialog>` with enlarged reading text, muted pacing marks and
stage directions, auto-scroll with adjustable speed (a discrete step per
second under `prefers-reduced-motion`), read-aloud through either browser
speech synthesis or an OpenRouter TTS model with voice and rate controls, a
visible wait when a request is rate-limited, and export of the hosted read as
a single paced WAV.

#### Example corpus

| Feature | Notes |
| --- | --- |
| Folders | Create, rename, delete; exactly one folder is *active* and grounds generation |
| Bundled corpus | 5 placeholder scripts shipped in `src/data/bundledExampleScripts.ts`, **off by default** |
| Import | Individual markdown/text files, a whole folder (recursive, non-text ignored), or session transcripts; destination is either the folder each file came from or one chosen folder |
| Import assist | After saving: suggest tags, lay unstructured text out as markdown, and (opt-in per import) rewrite into direct address. Every pass verifies the words survived and discards the result if not |
| Transcript split | The utility model splits a transcript into sections with a spec each, dropping speaker labels, timestamps and the client's replies |
| Clean up | Per folder or per example, offered only when there is work: retitle file-named scripts, section unsectioned ones, migrate pre-vocabulary tags |
| Corpus devices | Read each script for its devices, consolidate what recurs (≥2 sources, ≤10 devices), then read those for terms bound to the collection and how each is said without them. Quotes are verified against the corpus; staleness is detected by corpus signature |
| Tagging | Free topic tags plus a fixed three-facet standard vocabulary: explicitness (one of 3), written-for (one of 3), contains (any of triggers / post-hypnotic / amnesia / aftercare) |
| Promotion | Save a library script into a folder as an example; re-saving the same script offers replacement rather than duplicating |
| Open as script | Any example opens as a new script to rework, perform or export |
| Selection counts | How often each example has been chosen by retrieval, shown per example and merged (max-wins) on library import |

#### Retrieval

Entirely local. BM25 lexical ranking (k1 1.2, b 0.75, title and tag tokens
weighted ×3) fused by reciprocal rank fusion with dense cosine ranking over
stored sentence embeddings, then greedy MMR selection (λ 0.7) under a token
budget, dropping near-duplicates at Jaccard ≥ 0.8. Embeddings come from
`Xenova/all-MiniLM-L6-v2` run in-browser via transformers.js, loaded by
dynamic import and computed at import/promotion time; **every dense path
degrades to pure BM25** when the model or an embedding is unavailable.
Budget: 120k context, 20k reserved, 3–6 examples at ~4k tokens each.

#### Settings

Theme (light/dark/system); provider (OpenAI / OpenRouter / mock); generation
and utility models from presets or a custom id; API keys with a connection
test; import-assist toggle; review-pass toggle; standing instructions for
overall style and for imported material; debug transcript capture with JSON or
text download; library export/import; backup reminder and linked auto-backup
folder; voice audio cache usage and clear; clear all data.

### Model calls

Two model roles, both on the same provider and key. **Generation** writes;
**utility** is a small cheap model for the short jobs. Every prompt is a
`.txt` file in `src/prompts` assembled by `src/services/prompts.ts`.

| Call | Role | Prompt | Streamed | Verified |
| --- | --- | --- | --- | --- |
| Briefing questions | generation | `brief-questions.txt` | yes | falls back to canned questions on unparseable reply |
| Outline | generation | `outline-generation.txt` | yes | parsed to `ScriptOutline` |
| Outline critique | generation | `outline-critique.txt` | yes | opt-in |
| Section | generation | `section-generation.txt` | yes | word-count retry |
| Section regeneration | generation | `section-regeneration.txt` | yes | — |
| Script refinement | generation | `script-refinement.txt` | yes | — |
| Style critique + revisions | generation | `style-critique.txt` | yes | max 2 revisions |
| Script review + revisions | generation | `script-review.txt` | yes | max 3 revisions |
| Tag suggestion | utility | `example-tagging.txt` | no | tags canonicalised, capped at 9 |
| Markdown formatting | utility | `import-formatting.txt` | no | discarded if words changed |
| Direct-address rewrite | utility | `direct-address.txt` | no | discarded if words lost or padded |
| Transcript split | utility | `transcript-split.txt` | no | discarded unless well-formed and faithful |
| Sectioning | utility | `example-sectioning.txt` | no | same faithfulness check |
| Retitling | utility | `example-title.txt` | no | — |
| Device extraction / consolidation / generalisation | utility | `device-*.txt` | no | quotes verified present in corpus |

The system prompt (`hypnosis-system.txt`) plus style rules, exemplars and any
corpus devices ride every writing request; standing instructions are appended
at assembly time so a saved instruction applies to the next request with
nothing else notified.

Provider resolution is explicit: `resolveProviderStatus` returns `live`,
`mock`, or `missing-key`. A real provider with no key returns a service that
**fails with that reason** rather than silently falling through to the mock,
and scripts record the provider that actually served them.

### State and data flow

| Layer | Where | Notes |
| --- | --- | --- |
| Services | `ServiceProvider` | Script, example and utility services, rebuilt when settings change |
| Scripts | `AppProvider` | Reducer over `Script[]`, persisted to localStorage |
| Conversations | `ConversationProvider` + `rawConversationReducer` | Generations, the phase machine and the review report |
| Settings | `configStore` | Storage is not observable by React, so writers call `configChanged()` and readers subscribe via `useSyncExternalStore` |
| UI | `uiReducer` in `App.tsx`, local reducers in pages | Theme, modal, section titles, performance mode; `briefingReducer`, `regenerationReducer`, and a page-local reducer in `ExamplesPage` |

Reducer actions are past-tense events (`SECTION_EDITED`, `FOLDER_VIEWED`,
`REVIEW_PASS_COMPLETED`) per the standards in [CLAUDE.md](CLAUDE.md).

A read-only virtual filesystem (`scriptFs`, `exampleFs`) is projected over a
conversation — the outline is the mount table, generations supply the bodies,
retrieved exemplars mount under `/examples/` — so the model can be shown a
tree and asked for one path at a time.

### Persistence

Nothing leaves the browser except model requests. **A port must carry this map
or existing users lose their libraries.**

| Store | Key / location | Contents |
| --- | --- | --- |
| sessionStorage | `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | API keys, deliberately not persisted across browser sessions (migrated out of localStorage on load) |
| localStorage | `script_<id>` | One script per key, YAML front matter + markdown |
| localStorage | `example_<id>` | One example per key, YAML front matter + markdown (title, tags, folder, createdAt, sourceScriptId, sections, rounded embedding) |
| localStorage | `theme`, `apiProvider`, `model`, `utilityModel`, `showSectionTitles` | Core settings |
| localStorage | `importAssist`, `importVoicing`, `reviewPass`, `briefingStage`, `styleFidelity`, `debugTranscripts` | Feature toggles |
| localStorage | `instructions.style`, `instructions.import` | Standing instructions |
| localStorage | `readAloudEngine`, `readAloudVoice.<engine>`, `ttsModel` | Read-aloud preferences |
| localStorage | `exampleFolders`, `activeExampleFolder`, `bundledExamplesEnabled`, `exampleSelectionCounts` | Corpus organisation |
| localStorage | `corpusDevices` | Per-folder device sets with their corpus signature |
| localStorage | `libraryExportSnapshot`, `backupReminderEnabled`, `backupReminderDismissal`, `autoBackupEnabled`, `autoBackupLastWrittenAt`, `autoBackupSignature` | Backup staleness tracking |
| localStorage | `debugTranscripts` | Captured provider transcripts, capped at 100 |
| OPFS | `conversations/<encoded script id>.md` | Conversations as YAML + markdown, written through a queued store; **falls back to localStorage `conversation_<id>` transparently** when OPFS or writable streams are missing |
| IndexedDB | `instascript-backup` | The linked backup folder's `FileSystemDirectoryHandle` |
| IndexedDB | `instascript-speech` | Synthesised utterance audio, LRU-evicted, capped at 200 MB |
| Picked folder | `instascript-library-backup.json` | Automatic backup, throttled to one write per 5 min and skipped when the library signature is unchanged |

Legacy migrations run on load and must be preserved: the single `scripts` JSON
blob → per-script keys, the single `conversations` JSON blob → per-conversation
entries, localStorage conversations → OPFS, and the API key out of
localStorage into sessionStorage. Retired model ids are remapped on read
(`RETIRED_MODELS`) so a stale saved model still names something callable.

Export/import is one JSON file (`instascript-library`, version 1) carrying
scripts, conversations and selection counts. Import merges by id and never
overwrites what is already present.

### Platform APIs required

These are the porting hazards — each has a defined degradation path, and a
harness that lacks one should follow it rather than fail:

| API | Used for | Without it |
| --- | --- | --- |
| OPFS (`navigator.storage.getDirectory`) + writable streams | Conversation storage | Falls back to localStorage |
| IndexedDB | Backup folder handle, speech audio cache | Handle lasts the session only; audio re-synthesised |
| File System Access (`showDirectoryPicker`) | Linked auto-backup folder | Feature-detected and hidden |
| `webkitdirectory` on file input | Whole-folder corpus import | Individual file import still works |
| WebAssembly + transformers.js | Embeddings for dense retrieval | Retrieval degrades to BM25 |
| `speechSynthesis` | Free read-aloud | OpenRouter TTS offered instead when a key exists |
| Web Audio (`AudioContext.decodeAudioData`) | WAV export of the hosted read | Export hidden |
| `navigator.clipboard` | Copy script | Download still works |
| `matchMedia` | System theme, `prefers-reduced-motion` | — |
| `<dialog>.showModal` | Settings and performance mode | No fallback |

### Network endpoints

`api.openai.com/v1` (chat completions, and `/models` for the connection test),
`openrouter.ai/api/v1` (chat completions, `/audio/speech`, `/models/user`),
Google Fonts for Cormorant Garamond and Spectral, and the transformers.js
model download for the embedding model. The OpenAI SDK runs with
`dangerouslyAllowBrowser: true` — inherent to the no-backend design.

### Module map

```
src/
  pages/       home (composer + library), script, examples
  components/  settings modal, performance mode, conversation panel,
               script document, folder rail and view, meters, editors
  services/    generation orchestration, providers, prompts, retrieval,
               corpus, import passes, storage, speech, backup, cost
  prompts/     18 .txt prompt templates, imported with ?raw
  contexts/    service, app (scripts), conversation providers
  reducers/    conversation, briefing, regeneration
  utils/       context window, metrics, export, library filters
  types/       script, example, conversation, regeneration
  data/        bundled example scripts, mock scripts
```

Notable single-purpose modules worth reading before a port:
`rawScriptGenerationOrchestrator.ts` (the whole pipeline), `prompts.ts`
(request assembly), `exampleRanking.ts` (BM25/RRF/MMR), `conversationStore.ts`
(OPFS with fallback), `corpusDevices.ts` (device extraction and verification),
`speechExport.ts` (WAV assembly).

### Current state

Verified on this branch: `yarn lint` clean, `yarn build` succeeds,
`yarn test` — **890 tests across 53 files, all passing**. Test coverage is
concentrated on the services and utils; there are no component or end-to-end
tests, so UI behaviour is the part of a port that will need manual checking.

The build emits a 712 kB main chunk plus a 549 kB transformers chunk and a
23.5 MB ONNX runtime WASM file. The WASM and transformers chunks are loaded
only by dynamic import when an embedding is first needed, but the raw asset
size is worth knowing before choosing a host.

## Development

- `yarn dev` — start the development server
- `yarn build` — type-check and build for production
- `yarn lint` — run ESLint
- `yarn test` — run Vitest

Built with Vite, React, and TypeScript. Coding standards live in [CLAUDE.md](CLAUDE.md).

## Structure

The directory layout and the modules worth reading first are in the
[module map](#module-map) above.

## Backlog

The single source of truth for what exists and what is planned is [docs/user-stories.md](docs/user-stories.md). Stories are marked Implemented, Partial, or Gap; design rationale (retrieval approach, generation pipeline, visual design) is recorded alongside the affected epics.
