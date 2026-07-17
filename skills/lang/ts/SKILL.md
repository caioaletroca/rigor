---
name: rigor:lang:ts
description: >-
  TypeScript/Node.js language pack: detection heuristics, implementation
  commands (lint, test, coverage, build), review tools (security scanners,
  static analysis), and review patterns organized by reviewer focus area.
  Loaded automatically when a diff or project contains TypeScript files.
  Provides defaults that .rigor/config.yaml can override.
  Use when any rigor gate runs against TypeScript code.
  Skip when the project contains no TypeScript files.
---

TypeScript-specific configuration and patterns for all Rigor gates. This is a fat lang pack -- it covers detection, implementation tooling (Gate 0), review tooling and patterns (Gate 8), and required dependencies.

---

## Detection

A project uses TypeScript when ANY of these are true:

| Signal | Check |
|--------|-------|
| Project marker | `package.json` exists with `devDependencies` containing `typescript` |
| Config file | `tsconfig.json` exists in repo root |
| File extension | Diff contains `.ts` or `.tsx` files |
| Config override | `.rigor/config.yaml` sets `language: ts` |

A diff can contain multiple languages. Each matching lang pack is loaded. Reviewers receive patterns from all loaded packs.

---

## Config Override Precedence

Lang packs provide defaults. `.rigor/config.yaml` overrides them when set:

```
1. config.yaml explicit value (non-empty string) → use it
2. Lang pack default (this file)                 → use it
3. Neither                                       → skip that check
```

Example: this pack defaults `lint_command` to `npx eslint .`. If config.yaml sets `lint_command: "npx eslint --max-warnings=0 src/"`, the config wins.

---

## Gate 0: Implementation

### Commands

| Purpose | Command | Exit Code | Notes |
|---------|---------|-----------|-------|
| **Lint** | `npx eslint .` | 0 = clean | Or `npx biome check .` if biome is detected in `devDependencies` |
| **Test** | `npx vitest run --coverage` | 0 = pass | Or `npx jest --coverage` if jest is detected in `devDependencies` |
| **Coverage** | parsed from vitest/jest stdout | n/a | See Coverage Parsing below |
| **Build** | `npx tsc --noEmit` | 0 = compiles | Type-check only, no output files |
| **Format** | `npx prettier --check .` | 0 = clean | Optional, not a gate blocker |

### Coverage Parsing

Vitest, Jest, and Istanbul/c8 all use the same text-reporter table format:

```
All files  |  85.71 |  78.57 |  90.00 |  85.71 |
```

Extract the second column (first percentage after `All files`). Compare against `gates.gate_0.coverage_threshold` (default: 85).

### Test File Convention

| Convention | Pattern |
|------------|---------|
| Test file | `*.test.ts` / `*.spec.ts` alongside source or in `__tests__/` directory |
| Component test file | `*.test.tsx` / `*.spec.tsx` for React components |
| Test function | `describe` / `it` / `test` blocks |
| Table-driven | `it.each` / `test.each` with array of cases |

When `require_test_files: true`, every new `.ts` file (excluding `*.test.ts`, `*.spec.ts`, `*.d.ts`, generated files) must have a corresponding `*.test.ts` or `*.spec.ts` in the same directory or in an adjacent `__tests__/` directory.

---

## Gate 8: Review Tools

These tools run **before** AI reviewers are dispatched. Their structured output is passed to reviewers as grounding context.

### Security Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **npm audit** | `npm audit --audit-level=moderate` | JSON/text with advisories | Known CVEs in dependencies |
| **eslint-plugin-security** | via ESLint | Inline with ESLint output | `eval()`, unsafe regex, prototype pollution patterns |

### Static Analysis Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **TypeScript compiler** | `npx tsc --noEmit` | Text to stderr | Type errors, unreachable code, implicit `any` |
| **ESLint** | `npx eslint --format=json .` | JSON with messages array | Code quality, unused vars, complexity, import issues |

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

**Type safety:**
- `any` type usage: defeats type safety, prefer `unknown` with type guards or proper type definitions
- Missing return type annotations on exported functions -- forces callers to rely on inference
- Non-null assertions (`!`) hiding potential runtime errors instead of proper null checks
- Type assertions (`as Type`) used without runtime validation -- masks bugs at compile time
- Enum vs union type: prefer `type Status = "a" | "b"` over `enum Status { A, B }` (tree-shaking, no runtime object)

**Structure and readability:**
- Barrel files (`index.ts` re-exporting everything) bloating bundle size and creating circular dependency risk
- Nested ternaries reducing readability -- extract to named variables or early returns
- Missing `readonly` on array/tuple parameters that should not be mutated
- God files: single file with 500+ lines that should be decomposed into modules

**Idioms:**
- `console.log` / `console.error` in production code -- use a structured logger
- Mutable module-level state (non-const `let` at file scope) creating hidden coupling

### Patterns: security

**Injection:**
- `eval()`, `new Function()`, `vm.runInContext()` with user input -- arbitrary code execution
- Prototype pollution: `obj[userKey] = userValue` without property allowlist
- Path traversal: `path.join(base, userInput)` without sanitizing `../` sequences
- SQL injection via template literals in raw queries (`db.query(\`SELECT * FROM ${table}\`)`)
- XSS: `dangerouslySetInnerHTML` or `innerHTML` assignment with user-controlled content

**Secrets and crypto:**
- Insecure randomness: `Math.random()` for tokens/secrets instead of `crypto.randomUUID()` or `crypto.randomBytes()`
- Hardcoded credentials, API keys, or tokens (string literals matching key patterns)
- Sensitive data in error messages or log output (passwords, tokens, PII)

**Access control:**
- Missing authentication middleware on routes that modify state
- Authorization checks comparing user ID from request body instead of token/session
- Regex DoS (ReDoS): catastrophic backtracking in user-facing regex patterns

### Patterns: logic

**Truthiness traps:**
- Optional chaining (`?.`) hiding bugs: `obj?.deeply?.nested?.value` silently returns `undefined` when the chain should never be null
- Falsy checks with `if (!value)` catching `0`, `""`, `false` unintentionally -- use explicit comparisons
- `==` instead of `===` causing type coercion surprises

**Async hazards:**
- Promise not awaited: calling async function without `await` -- fire-and-forget loses errors
- Floating promise in try/catch: `try { asyncFn() }` does not catch the rejection
- `Promise.all` with no error handling -- one rejection rejects everything, others are abandoned

**Misused APIs:**
- Array `.map()` used for side effects instead of `.forEach()` -- return value discarded
- `JSON.parse()` result used without validation (returns `any`, unknown shape)
- Type assertion (`as Type`) at system boundaries without runtime validation (Zod, etc.)
- `expect` inside callbacks that may not execute (silent pass in tests)

### Patterns: test-quality

**Coverage gaps:**
- Error paths not tested: only the happy path has a test case
- Edge cases missing: zero value, null/undefined input, empty string, empty array, unicode
- Async error handling not tested: rejected promises, timeout scenarios

**Test hygiene:**
- Mock implementation does not verify call arguments (passes for any input)
- Snapshot tests without meaningful assertions (fragile, low signal)
- `jest.mock()` / `vi.mock()` at wrong scope (hoisting issues, mock leaking between tests)
- Missing cleanup: event listeners, timers, intervals not cleared in `afterEach`
- `expect` inside callbacks that may not execute -- test passes silently

**Anti-patterns:**
- Testing implementation details instead of behavior (e.g., checking internal state or private methods)
- Test depends on execution order or shared mutable state between tests
- `time.sleep`-style waits (`setTimeout` in tests) for synchronization instead of async utilities

### Patterns: performance

**Allocations and copies:**
- Large object spread in hot paths: `{ ...bigObject, oneField: newValue }` clones everything on every call
- `JSON.stringify` / `JSON.parse` for deep cloning -- use `structuredClone` (Node 17+)
- String concatenation in a loop: use array `.join()` or template literals

**I/O and concurrency:**
- Synchronous file I/O (`readFileSync`, `writeFileSync`) in request handlers -- blocks the event loop
- Unbounded `Promise.all()` with thousands of items -- use batching or a concurrency limiter (`p-limit`)
- N+1 queries in API resolvers: `await` in a loop vs batch query

**Hot paths:**
- Regex compiled inside a function called per-request: move to module-level constant
- Re-renders in React: missing `useMemo`/`useCallback` for expensive computations passed as props
- Creating new `Date` objects or running `Intl` formatters inside tight loops

### Patterns: nil-safety

**Null/undefined dereference:**
- Optional chaining overuse: `obj?.deeply?.nested?.value` -- silently returns `undefined` when the chain should never be null (masks bugs instead of catching them)
- Non-null assertion (`!`): `user!.name` -- tells TypeScript to trust you, but crashes at runtime if `user` is actually null
- Missing nullish check after `Map.get()` / `Array.find()` / `Object.entries()` -- all return `undefined` on miss
- Destructuring with default on nullable: `const { x = 0 } = obj` -- default only applies for `undefined`, not `null`
- `JSON.parse()` returns `any` -- accessing nested fields without validation is an implicit null risk

**Type narrowing gaps:**
- `typeof x === "object"` is true for `null` -- must also check `x !== null`
- `if (x)` falsy check filters out `0`, `""`, `false`, `NaN` -- not just `null`/`undefined`
- Type guard functions that don't cover all union cases -- unhandled variant causes runtime `undefined`
- `as` type assertion bypasses null checks: `(x as User).name` skips the nullability that `x: User | null` should enforce
- `Partial<T>` makes all fields optional -- accessing `partial.field` without check is unsafe

**Promise and async null:**
- `await` on a function that returns `T | undefined` -- the result needs a null check even after await
- Promise rejection caught with `.catch(() => {})` -- swallows errors, downstream code gets `undefined`
- Async function returns `undefined` implicitly when no explicit return -- callers get `Promise<undefined>`

**API boundaries:**
- External API response typed as `T` but actual response may have null fields -- always validate at boundaries
- GraphQL nullable fields: schema allows null but TypeScript type doesn't reflect it
- `localStorage.getItem()` returns `string | null` -- often used without null check
- `document.querySelector()` returns `Element | null` -- chained method calls crash on null
- `process.env.VAR` is `string | undefined` -- used in config without fallback

### Patterns: consequences

**Caller chain impact:**
- Changed function signature or return type: all callers and their callers must handle the new shape
- Modified Promise rejection type: `.catch()` handlers may not handle the new error shape
- Changed event payload shape: all event listeners must be updated
- Exported type change: consumers in other packages/apps importing this type break silently if not rebuilt

**Module boundary changes:**
- Modified barrel export (`index.ts`): consumers importing from the barrel may get different symbols
- Changed default export to named (or vice versa): all import statements must update
- Moved file: relative imports in consumers break -- and path aliases may mask the break until runtime

**Shared state impact:**
- Modified Redux/Zustand/context state shape: all selectors and consumers must be audited
- Changed React prop type: all component callsites must pass the new shape
- Modified shared utility return type: all callers need to handle the new return
- Changed environment variable name or format: deployment configs, CI, Docker must update

**Runtime contract changes:**
- Changed API response shape: frontend consumers expecting the old shape break
- Modified middleware order in Express/Fastify: downstream handlers see different request state
- Changed database schema: all queries and ORM models referencing changed columns must update
- Modified validation rules: previously valid input may now be rejected (or vice versa)

### Patterns: dead-code

**Orphaned exports and functions:**
- Exported function with zero import sites after the change -- was the removed code the only consumer?
- React component that is no longer rendered in any route or parent component
- Utility function that only served the deleted feature
- Type definition only used by removed code -- especially in `types.ts` or `models.ts` barrel files
- Event handler for an event that is no longer emitted

**Unreachable branches:**
- `switch` case for a discriminated union variant that was removed from the union type
- `if` branch checking a condition that can never be true after type narrowing changes
- Error handling for an API call that was removed or replaced
- Feature flag branch for a flag that is always true/false now
- `catch` block for an error type that the modified code no longer throws

**Stale artifacts:**
- Test file (`*.test.ts`) for a function/component that no longer exists
- Mock file for a module that was refactored or removed
- Storybook story for a deleted component
- CSS module (`.module.css`) for a removed component
- Generated types (GraphQL codegen, API client types) for removed endpoints
- Snapshot file (`.snap`) for a deleted test

**Import bloat:**
- Package imported but only used by deleted code -- still in `package.json` and `node_modules`
- Side-effect import (`import "./polyfill"`) for a feature that was removed
- Unused CSS/SCSS import in a component file

---

## Dependencies

Required tools and install commands. `rigor:review` logs a warning for missing tools but does not block.

| Tool | Install | Minimum Version | Purpose |
|------|---------|-----------------|---------|
| `node` | [nodejs.org](https://nodejs.org/) | 20+ | Runtime |
| `typescript` | `npm i -D typescript` | 5.0+ | Type checking |
| `eslint` | `npm i -D eslint` | 9.0+ | Linting |
| `vitest` or `jest` | `npm i -D vitest` | latest | Testing |
| `c8` or `istanbul` | via vitest/jest | latest | Coverage |

Optional:

| Tool | Install | Purpose |
|------|---------|---------|
| `biome` | `npm i -D @biomejs/biome` | Fast lint + format alternative to ESLint + Prettier |
| `prettier` | `npm i -D prettier` | Code formatting |
