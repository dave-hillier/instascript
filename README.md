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

Standing instructions live in settings, so a preference is stated once rather than in every brief: one field for the **overall style** every script is written in, which rides the system prompt every writing request shares and the style rules the review pass judges against, and one for **imported material**, which rides the utility model's import passes. Either left empty sends the prompts exactly as they ship, and the import checks still discard a pass that reworded a script.

## Development

- `yarn dev` — start the development server
- `yarn build` — type-check and build for production
- `yarn lint` — run ESLint
- `yarn test` — run Vitest

Built with Vite, React, and TypeScript. Coding standards live in [CLAUDE.md](CLAUDE.md).

## Structure

- `src/pages` — home (composer + script library) and script reading page
- `src/services` — generation orchestration, providers, example retrieval, storage
- `src/prompts` — system, outline, and section prompts
- `src/contexts`, `src/reducers` — app and conversation state (event-driven reducers)

## Backlog

The single source of truth for what exists and what is planned is [docs/user-stories.md](docs/user-stories.md). Stories are marked Implemented, Partial, or Gap; design rationale (retrieval approach, generation pipeline, visual design) is recorded alongside the affected epics.
