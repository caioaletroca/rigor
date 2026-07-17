---
name: rigor:lang:react
description: >-
  React/Next.js language pack: detection heuristics, implementation commands
  (lint, test, coverage, build, type check), review tools (security scanners,
  static analysis, accessibility, performance), and review patterns organized
  by reviewer focus area. Loaded automatically when a diff or project contains
  React/Next.js files. Provides defaults that .rigor/config.yaml can override.
  Use when any rigor gate runs against React or Next.js code.
  Skip when the project contains no React or Next.js files.
---

React/Next.js-specific configuration and patterns for all Rigor gates. This is a fat lang pack -- it covers detection, implementation tooling (Gate 0), review tooling and patterns (Gate 8), and required dependencies.

This pack is separate from `rigor:lang:ts` because React/Next.js introduces component architecture, server/client boundaries, routing conventions, rendering lifecycle, and accessibility concerns that vanilla TypeScript does not cover. Both packs can be loaded simultaneously -- reviewers receive patterns from all loaded packs.

---

## Detection

A project uses React/Next.js when ANY of these are true:

| Signal | Check |
|--------|-------|
| Next.js config | `next.config.js`, `next.config.mjs`, or `next.config.ts` exists in repo root |
| React dependency | `package.json` contains `react` or `next` in `dependencies` or `devDependencies` |
| File extension | Diff contains `.tsx` or `.jsx` files |
| Config override | `.rigor/config.yaml` sets `language: react` |

A diff can contain multiple languages. Each matching lang pack is loaded. Reviewers receive patterns from all loaded packs. When this pack and `rigor:lang:ts` are both detected, both are loaded -- the TS pack covers general TypeScript patterns while this pack covers React/Next.js-specific patterns.

---

## Config Override Precedence

Lang packs provide defaults. `.rigor/config.yaml` overrides them when set:

```
1. config.yaml explicit value (non-empty string) → use it
2. Lang pack default (this file)                 → use it
3. Neither                                       → skip that check
```

Example: this pack defaults `lint_command` to `npx eslint .`. If config.yaml sets `lint_command: "npx biome check ."`, the config wins.

---

## Gate 0: Implementation

### Commands

| Purpose | Command | Exit Code | Notes |
|---------|---------|-----------|-------|
| **Lint** | `npx eslint .` | 0 = clean | Expects `eslint-config-next` for Next.js projects; falls back to standard ESLint config. Or `npx biome check .` if Biome is detected in `devDependencies` |
| **Format** | `npx prettier --check .` | 0 = clean | Or `npx biome format --check .` if Biome is detected. Not a gate blocker by default |
| **Test** | `npx vitest run --coverage` | 0 = pass | Expects `@testing-library/react` for component tests. Uses `jsdom` or `happy-dom` environment |
| **Coverage** | parsed from vitest stdout | n/a | See Coverage Parsing below |
| **Build** | `npx next build` | 0 = compiles | For Next.js projects. Falls back to `npx vite build` for non-Next React projects |
| **Type check** | `npx tsc --noEmit` | 0 = clean | Type-check only, no output files. Catches type errors the build step may not surface |

### Coverage Parsing

Vitest with `@vitest/coverage-v8` or `@vitest/coverage-istanbul` uses the standard text-reporter table format:

```
All files  |  85.71 |  78.57 |  90.00 |  85.71 |
```

Extract the second column (first percentage after `All files`). Compare against `gates.gate_0.coverage_threshold` (default: 85).

If coverage is configured to output to JSON (`coverage/coverage-summary.json`), parse:

```json
{ "total": { "statements": { "pct": 85.71 } } }
```

### Test File Convention

| Convention | Pattern |
|------------|---------|
| Component test file | `*.test.tsx` / `*.spec.tsx` alongside source or in `__tests__/` directory |
| Hook test file | `*.test.ts` / `*.spec.ts` for custom hooks |
| Test function | `describe` / `it` / `test` blocks |
| Table-driven | `it.each` / `test.each` with array of cases |
| Component rendering | `render(<Component />)` from `@testing-library/react` |
| User interaction | `userEvent.click()` / `userEvent.type()` from `@testing-library/user-event` |

When `require_test_files: true`, every new `.tsx` component file (excluding test files, `*.stories.tsx`, layout files, generated files) must have a corresponding `*.test.tsx` or `*.spec.tsx` in the same directory or in an adjacent `__tests__/` directory.

---

## Gate 8: Review Tools

These tools run **before** AI reviewers are dispatched. Their structured output is passed to reviewers as grounding context.

### Security Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **npm audit** | `npm audit --audit-level=moderate` | JSON/text with advisories | Known CVEs in dependencies |
| **eslint-plugin-security** | via ESLint | Inline with ESLint output | `eval()`, unsafe regex, prototype pollution patterns |
| **eslint-plugin-react** | via ESLint | Inline with ESLint output | Unsafe JSX patterns, missing prop validation |

### Static Analysis Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **TypeScript compiler** | `npx tsc --noEmit` | Text to stderr | Type errors, unreachable code, implicit `any` |
| **ESLint** | `npx eslint --format=json .` | JSON with messages array | Code quality, unused vars, React-specific rules, hooks rules |
| **eslint-plugin-react-hooks** | via ESLint | Inline with ESLint output | Hooks rules violations (conditional hooks, missing deps) |

### Accessibility Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **eslint-plugin-jsx-a11y** | via ESLint | Inline with ESLint output | Missing `alt` text, invalid ARIA, non-interactive element handlers, missing labels |
| **axe-core** | via `@axe-core/cli` or Playwright integration | JSON with violations array | WCAG 2.1 violations at runtime (color contrast, focus management, semantic structure) |

### Performance Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **Lighthouse CI** | `npx lhci autorun` | JSON with audit results | Core Web Vitals (LCP, FID, CLS), SEO, accessibility scores |
| **Bundle analyzer** | `npx next build && npx @next/bundle-analyzer` or `npx vite-bundle-visualizer` | HTML report | Oversized bundles, duplicate dependencies, unoptimized imports |

### Tool Failure Policy

| Situation | Action |
|-----------|--------|
| Tool not installed | Log warning, skip that tool, continue with remaining tools |
| Tool exits non-zero | Capture output as findings, do not abort the review |
| Tool times out (>60s) | Kill, log timeout, skip that tool |

Tools are **informational inputs** to reviewers, not gates themselves. A missing tool does not block review -- it means reviewers have less grounding for that focus area.

---

## Gate 8: Review Patterns

These patterns are injected into AI reviewer prompts alongside the diff and tool output. Organized by reviewer focus area so each reviewer loads only its relevant section.

### Patterns: code-quality

**Component organization:**
- God components: components with 300+ lines that mix data fetching, state management, and rendering -- decompose into container/presentational or extract custom hooks
- Prop drilling through 3+ levels: lift state to context, use composition (`children`), or a state management solution
- Render props or HOCs where a custom hook would be simpler and more composable
- Mixed concerns: a single component handling form state, validation, API calls, and UI rendering -- separate into hook + component

**Naming and conventions:**
- Components not PascalCase: `myComponent` instead of `MyComponent`
- Custom hooks not prefixed with `use`: `fetchData()` instead of `useFetchData()`
- Event handlers not prefixed with `handle` or `on`: `click()` instead of `handleClick()` or `onClick`
- File naming inconsistency: mixing `kebab-case.tsx`, `PascalCase.tsx`, and `camelCase.tsx` in the same project

**Patterns and idioms:**
- Custom hooks not extracted: duplicated `useState` + `useEffect` patterns across components that share the same logic
- Compound components not used where a component has tightly coupled sub-components (e.g., `<Tabs>` / `<Tab>` / `<TabPanel>`)
- Controlled vs uncontrolled confusion: mixing `value`/`onChange` with `defaultValue` on the same input, or switching between modes across renders

**App Router patterns (Next.js):**
- `'use client'` placed at too high a level: marking a layout or page as client when only a small interactive child needs it -- pushes entire subtree to client bundle
- Server component doing client work: using `useState`, `useEffect`, or event handlers in a server component (build error or silent failure)
- Client component doing server work: fetching data with `fetch()` in a client component when the parent server component should pass it as props
- Server actions not validated: `'use server'` functions accepting user input without Zod/schema validation
- Missing `loading.tsx` or `error.tsx` for route segments that perform async data fetching

### Patterns: security

**XSS and injection:**
- `dangerouslySetInnerHTML` with unsanitized content: user-provided HTML must be sanitized with DOMPurify or equivalent before rendering
- String interpolation in `href` attributes: `href={userInput}` enables `javascript:` protocol injection -- validate URL scheme
- Rendering user content via template literals in JSX without escaping (React auto-escapes in JSX expressions, but not in `dangerouslySetInnerHTML` or `innerHTML`)

**Auth and data exposure:**
- API keys or secrets in client components: any variable without `NEXT_PUBLIC_` prefix is server-only in Next.js, but hardcoded strings in `.tsx` files ship to the browser regardless
- Missing auth checks in server components or API routes: `cookies()` / `headers()` used but not validated against a session
- CSRF in server actions: `'use server'` functions without origin validation or token verification on mutating operations
- Sensitive data in client state: passwords, tokens, or PII stored in React state, context, or local storage without encryption

**Dependency security:**
- Unvetted npm packages: new dependencies added without checking download count, maintenance status, or known vulnerabilities
- Packages with `postinstall` scripts that execute arbitrary code
- Pinning to tag (`latest`, `next`) instead of exact version in `package.json`

### Patterns: logic

**State management:**
- Stale closures: event handlers or effects capturing an old value of state because the closure was created before the state update
- Missing dependency arrays in `useEffect`: omitting dependencies causes stale data; including too many causes excessive re-runs
- Race conditions in async effects: two rapid state changes trigger two fetches, and the first response overwrites the second (missing cleanup or abort controller)
- Derived state stored in `useState`: values computable from props or other state should be computed inline or with `useMemo`, not duplicated in state

**Rendering:**
- Infinite re-render loops: `useEffect` that sets state unconditionally, triggering itself on every render
- Missing `key` prop on list items, or using array index as `key` when items can be reordered, inserted, or deleted
- Unnecessary re-renders from object/function props: passing `{}` or `() => {}` inline creates a new reference every render, defeating `React.memo` on children
- Conditional hook calls: hooks called inside `if` blocks, loops, or after early returns -- violates Rules of Hooks

**Next.js specifics:**
- Incorrect cache behavior: `fetch()` in server components uses aggressive caching by default -- stale data served when `revalidate` or `cache: 'no-store'` is missing
- `revalidatePath` / `revalidateTag` misuse: revalidating too broadly (entire layout) or too narrowly (wrong tag)
- Sequential data fetching when parallel is possible: `const a = await fetchA(); const b = await fetchB();` instead of `const [a, b] = await Promise.all([fetchA(), fetchB()])`
- `redirect()` called after `try/catch` that swallows the `NEXT_REDIRECT` error -- `redirect()` throws internally and must not be caught

### Patterns: test-quality

**Coverage gaps:**
- User interaction paths not tested: click handlers, form submissions, keyboard navigation, focus management
- Error boundaries not tested: `ErrorBoundary` components or `error.tsx` files without tests that trigger the error state
- Loading and error states not tested: only the resolved data state has assertions -- missing tests for skeleton/spinner and error message rendering
- Accessibility assertions missing: no `toBeAccessible()`, `toHaveRole()`, or axe-core integration in component tests

**Test hygiene:**
- Testing implementation details: asserting on internal state, hook return values, or component instance methods instead of what the user sees and interacts with
- Snapshot overuse: large component snapshots that break on every style change and get auto-updated without review
- Missing `waitFor` or `findBy` for async operations: using `getBy` immediately after an action that triggers async state updates
- Missing cleanup: components with timers, subscriptions, or portals not unmounted between tests

**Anti-patterns:**
- Testing internal state: accessing `component.state` or `hook.result.current` instead of asserting on rendered output
- Mocking too much of React: mocking `useState` or `useEffect` instead of testing the component as a user would use it
- Wrong Testing Library queries: using `getByTestId` when `getByRole`, `getByLabelText`, or `getByText` would be more accessible and resilient -- prefer queries that reflect how users find elements

### Patterns: performance

**Rendering:**
- Missing `React.memo` / `useMemo` / `useCallback` where measured impact exists: wrapping everything in memo is premature optimization, but ignoring it on measured-slow re-renders is a bug
- Large component trees without virtualization: rendering 1000+ list items without `react-window`, `react-virtuoso`, or similar -- causes layout thrashing and jank
- Expensive computations in render body: filtering, sorting, or transforming large datasets on every render without `useMemo`

**Bundle size:**
- Barrel imports pulling entire libraries: `import { Button } from '@ui'` re-exporting 200 components -- use direct imports or ensure tree-shaking works
- Missing dynamic imports for heavy components: modals, charts, rich text editors, maps should use `React.lazy()` + `Suspense` or `next/dynamic`
- Unoptimized images: using `<img>` instead of `next/image` (Next.js) or missing `width`/`height` attributes causing layout shift
- Large dependencies imported in client components: moment.js, lodash (full), or date-fns without tree-shaking

**Next.js performance:**
- Missing `loading.tsx` for route segments: no streaming, user sees blank page during data fetch instead of progressive loading
- No streaming with `Suspense`: server components that could stream partial UI block the entire page render
- Client components that should be server components: components that only render data without interactivity are needlessly shipped to the client bundle
- Missing `generateStaticParams` for dynamic routes that could be statically generated at build time

### Patterns: nil-safety

**Optional chaining gaps:**
- API response access without null checks: `data.user.profile.avatar` when any level could be `undefined` before the fetch completes or on error
- Optional props destructured without defaults: `const { items } = props` where `items` is `Item[] | undefined` -- `items.map()` crashes
- Undefined state before fetch completes: `const [data, setData] = useState<User>()` then `data.name` in render without checking `data` is defined

**TypeScript strictness abuse:**
- Non-null assertions (`!`) hiding real null paths: `ref.current!.focus()` when the ref may not be attached yet
- `as` casts concealing nullable types: `(response as User).name` when `response` could be `null` or `undefined`
- Missing discriminated union exhaustiveness: `switch` on a union type without `default` or `never` check for unhandled variants
- `Partial<T>` spreading: `{ ...defaults, ...partial }` where `partial` fields are `undefined` and overwrite valid defaults

**Component and hook null safety:**
- `useRef<T>(null)` accessed without `.current` null check -- ref is `null` until the component mounts
- `useContext` without provider check: context returns `undefined` when used outside its provider tree -- use a custom hook that throws
- `document.getElementById()` / `document.querySelector()` in effects without null check -- element may not exist
- `searchParams.get()` returns `string | null` -- used directly as component prop without fallback

### Patterns: consequences

**Component API changes:**
- Prop type changes: all parent components passing the changed prop must be updated -- especially when `required` becomes `optional` or vice versa
- Removed props: parent components still passing the removed prop get no error (extra props are silently ignored in React) -- dead prop goes unnoticed
- Children type changes: component that accepted `ReactNode` now expects `string` or specific child components -- callers break silently

**Routing changes:**
- Path changes in App Router (`app/` directory renames): bookmarks, external links, SEO indexes, and internal `Link` components all break
- Middleware changes: `middleware.ts` matcher pattern changes affect which routes get auth checks, redirects, or headers
- Layout nesting changes: moving `layout.tsx` or changing its location changes which pages share the layout -- affects shared state, providers, and UI consistency

**Shared state changes:**
- Context value shape changes: all `useContext` consumers must handle the new shape -- no compile-time check for missing fields if using `as` casts
- Store schema changes (Redux, Zustand, Jotai): selectors referencing renamed or removed fields return `undefined` silently
- Shared hook return type changes: all components using the hook must handle the new return shape

**Build and config changes:**
- `next.config.js` / `next.config.mjs` changes: redirects, rewrites, headers, image domains, webpack config -- affects production behavior in ways that local dev may not surface
- Environment variable renames: `NEXT_PUBLIC_*` variables referenced in client code must be updated in `.env`, CI/CD, and deployment configs simultaneously
- `tsconfig.json` path alias changes: all imports using the alias break -- `@/` or `~` prefix changes are especially widespread

### Patterns: dead-code

**Orphaned components:**
- Component file with zero import sites after the change: check that no route, layout, or parent component renders it
- Exported component used only as a re-export in a barrel file (`index.ts`) that itself has no consumers
- Page/route components in `app/` or `pages/` that are unreachable due to middleware redirects or removed navigation links

**Stale hooks:**
- Custom hook (`use*.ts`) with no consumers after the change -- was the removed component the only user?
- Hook that wraps a context provider that was removed -- the hook returns stale or default values
- Hook with `useEffect` that subscribes to an event/websocket that is no longer emitted

**Unused styles:**
- CSS module file (`.module.css` / `.module.scss`) for a removed or refactored component
- Tailwind classes applied to elements that were removed or restructured -- dead classes in remaining elements do not cause errors but add confusion
- Styled-components or emotion `styled()` definitions with no usage after component deletion
- Global CSS rules targeting class names or IDs that no longer exist in the rendered DOM

**Stale test and config files:**
- Test file (`*.test.tsx`) for a component that no longer exists
- Storybook story (`*.stories.tsx`) for a deleted component
- Mock file for a module that was refactored or removed
- Snapshot file (`.snap`) for a deleted test
- E2E test file targeting routes or interactions that were removed

**Unused context providers:**
- Context provider wrapping a layout or page where no descendant calls `useContext` for that context
- Provider with a value that is never read -- the provider exists but all consumers were removed

---

## Dependencies

Required tools and install commands. `rigor:review` logs a warning for missing tools but does not block.

| Tool | Install | Minimum Version | Purpose |
|------|---------|-----------------|---------|
| `node` | [nodejs.org](https://nodejs.org/) | 18+ | Runtime |
| `eslint` | `npm i -D eslint` | 9.0+ | Linting (with `eslint-config-next` for Next.js) |
| `vitest` | `npm i -D vitest` | 1.0+ | Testing |
| `@testing-library/react` | `npm i -D @testing-library/react` | 14.0+ | Component testing |
| `@testing-library/user-event` | `npm i -D @testing-library/user-event` | 14.0+ | User interaction simulation |
| `typescript` | `npm i -D typescript` | 5.0+ | Type checking |

Optional:

| Tool | Install | Purpose |
|------|---------|---------|
| `axe-core` | `npm i -D @axe-core/cli` or `npm i -D axe-core` | Runtime accessibility testing |
| `playwright` | `npm i -D @playwright/test` | E2E testing and accessibility auditing |
| `lighthouse` | `npm i -D @lhci/cli` | Core Web Vitals and performance auditing |
| `@next/bundle-analyzer` | `npm i -D @next/bundle-analyzer` | Bundle size analysis for Next.js |
| `vite-bundle-visualizer` | `npm i -D vite-bundle-visualizer` | Bundle size analysis for Vite-based React |
| `biome` | `npm i -D @biomejs/biome` | Fast lint + format alternative to ESLint + Prettier |
| `prettier` | `npm i -D prettier` | Code formatting |
| `eslint-plugin-jsx-a11y` | `npm i -D eslint-plugin-jsx-a11y` | Static accessibility linting |
