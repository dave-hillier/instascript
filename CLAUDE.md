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

### Implementation Details

The app has a complete theme system with the following features:

#### Theme Modes
- **Light**: Light background (#ffffff) with dark text (#1a1a1a)
- **Dark**: Dark background (#1a1a1a) with light text (#ffffff)  
- **System**: Automatically follows the user's OS theme preference

#### Technical Architecture
- Theme preference stored in localStorage with direct access (key: 'theme')
- Theme state managed via `useReducer` in App.tsx with `uiReducer`
- Applied to DOM via `data-theme` attribute on root div
- CSS uses `[data-theme="light"]` and `[data-theme="dark"]` selectors for styling
- System theme detection via `window.matchMedia('(prefers-color-scheme: dark)')`
- Real-time system theme change listening with MediaQueryList event handlers

#### Component Integration
- Settings modal (`SettingsModal.tsx`) provides theme selector UI
- Three theme buttons with icons (Sun/Moon/Monitor from Lucide React)
- Theme changes are immediate and persistent across sessions

#### CSS Theme Variables
All theme-specific styles are in `App.css` using attribute selectors:
- Colors, borders, backgrounds automatically adjust based on `[data-theme]`
- Smooth transitions (0.3s ease) for theme switches
- Component-specific theme overrides for dialogs, forms, buttons, etc.
