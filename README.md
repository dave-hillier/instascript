# InstaScript

InstaScript generates long-form hypnosis scripts for adults from a short brief. It is a client-side React app: scripts stream in section by section, can be regenerated per section, and everything persists in the browser — there is no backend.

**Content note:** the app generates erotic hypnosis scripts and is intended for adults.

## How it works

An optional briefing stage sits in front of generation: switched on from the composer, it asks three to five multiple-choice questions about what the brief leaves open — a trigger word, what should persist after the session, who is speaking to whom — each with concrete suggestions, a free-text answer and a "decide for me". The answers are appended to the brief; everything after that is unchanged.

A brief is expanded in two stages: the model first produces an outline (section list with per-section word targets), then writes each section against that outline with example scripts as few-shot style exemplars. Examples are whatever you import (markdown or text files, individually or a whole folder) or promote from your own scripts; a small bundled placeholder corpus ships with the app and can be switched on from the Examples page, but is off by default so generation is grounded only in your own material. Generation streams live into a sectioned reading view, with per-section word-count and context-token meters. Each section can be regenerated individually using the full conversation history.

Providers: OpenAI, OpenRouter (any model id), or a mock provider for development — selected in settings along with the model and API key. API keys are held in sessionStorage; scripts and conversations are stored in localStorage as YAML front-matter + markdown.

Two models are configured, not one: the **generation** model writes the scripts, and a small, cheap **utility** model handles the short jobs around them — suggesting tags for an imported example and laying an unstructured plain-text import out as markdown. Both run after the import is saved and verify the model's reply before storing it, so a formatting pass that reworded the script is discarded and the import kept as it was. The pass can be switched off in settings to keep imports entirely local.

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
