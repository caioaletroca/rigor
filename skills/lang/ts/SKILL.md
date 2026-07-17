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
