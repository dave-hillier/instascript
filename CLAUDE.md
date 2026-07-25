# Project Instructions

## Development Commands

- `yarn dev` - Start development server - assume that already is running
- `yarn build` - Build for production
- `yarn lint` - Run linting
- `yarn preview` - Preview production build

## Tech Stack

- Vite
- React
- TypeScript

## React Coding Standards

- Prefer `useReducer` for complex state management
- Don't use `useRef` unless absolutely necessary for DOM access
- Don't use `useCallback` and `useMemo` as optimizations unless proven necessary through profiling
- Use event-driven approach with reducers (past-tense events)
- Don't use `index.ts` files
- Don't use style blocks in TSX
- No direct DOM manipulation
- Don't use emojis in React apps

## HTML & Accessibility Standards

- Use semantic HTML elements (`article`, `section`, `header`, `nav`, `main`, `footer`)
- Implement WCAG-compliant patterns for interactive components (tabs, modals, etc.)
- Use classless CSS approach - prefer semantic elements over div-based layouts
- Include appropriate ARIA attributes and roles for accessibility
- Use proper heading hierarchy and landmark elements

## CSS Standards

- Prefer semantic CSS selectors over conditional classes
- Use CSS pseudo-selectors (`:first-child`, `:last-child`, `:nth-child`) instead of JavaScript-generated classes
- Target elements by semantic attributes (`div[role="group"]`) rather than adding extra CSS classes
- Keep component markup clean by letting CSS handle styling logic

## Icon Standards

- Use Lucide React icons exclusively
- Import specific icons rather than the entire library
- Provide appropriate sizing and accessibility labels

## Data Storage Standards

- Store application settings in localStorage
- Use custom hooks for localStorage operations with error handling
- Implement proper state management for persisted data

## Theme System

The app supports light, dark, and system theme modes (system follows the OS preference via `matchMedia`, with live change listening). The preference persists in localStorage under the key `theme` and is applied as a `data-theme` attribute on the root div.

All theming is expressed as CSS custom properties (design tokens) defined per theme in `App.css` under `[data-theme="light"]` and `[data-theme="dark"]` — background, surface, ink, line, accent, and danger colors. Components style against the tokens (`var(--accent)` etc.), never hardcoded colors, so both themes are first-class. When adding UI, use the existing tokens; add a new token rather than a literal color if none fits.

Typography roles are also tokens (`index.css`): `--font-ui` (system sans, chrome), `--font-display` (Cormorant Garamond — wordmark, titles, section headings), `--font-reading` (Spectral — script body text only).
