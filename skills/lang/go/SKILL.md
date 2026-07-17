---
name: rigor:lang:go
description: >-
  Go language pack: detection heuristics, implementation commands (lint, test,
  coverage, build), review tools (security scanners, static analysis), and
  review patterns organized by reviewer focus area. Loaded automatically when
  a diff or project contains Go files. Provides defaults that .rigor/config.yaml
  can override. Use when any rigor gate runs against Go code.
  Skip when the project contains no Go files.
---

Go-specific configuration and patterns for all Rigor gates. This is a fat lang pack -- it covers detection, implementation tooling (Gate 0), review tooling and patterns (Gate 8), and required dependencies.

---

## Detection

A project uses Go when ANY of these are true:

| Signal | Check |
|--------|-------|
| Project marker | `go.mod` exists in repo root (or nearest parent) |
| File extension | Diff contains `.go` files |
| Config override | `.rigor/config.yaml` sets `language: go` |

A diff can contain multiple languages. Each matching lang pack is loaded. Reviewers receive patterns from all loaded packs.

---

## Config Override Precedence

Lang packs provide defaults. `.rigor/config.yaml` overrides them when set:

```
1. config.yaml explicit value (non-empty string) → use it
2. Lang pack default (this file)                 → use it
3. Neither                                       → skip that check
```

Example: this pack defaults `lint_command` to `golangci-lint run ./...`. If config.yaml sets `lint_command: "golangci-lint run --fast ./..."`, the config wins.

---

## Gate 0: Implementation

### Commands

| Purpose | Command | Exit Code | Notes |
|---------|---------|-----------|-------|
| **Lint** | `golangci-lint run ./...` | 0 = clean | Aggregates multiple linters; `.golangci.yml` configures which |
| **Test** | `go test -coverprofile=coverage.out -race ./...` | 0 = pass | `-race` detects data races; `-coverprofile` emits coverage |
| **Coverage** | `go tool cover -func=coverage.out` | always 0 | Outputs per-function coverage; last line is total |
| **Build** | `go build ./...` | 0 = compiles | Catches type errors that tests might skip |
| **Vet** | `go vet ./...` | 0 = clean | Built-in static analysis; catches subtle bugs |

### Coverage Parsing

`go tool cover -func=coverage.out` outputs lines like:

```
total:    (statements)    78.5%
```

Extract the last line, parse the percentage. Compare against `gates.gate_0.coverage_threshold` (default: 85).

### Test File Convention

| Convention | Pattern |
|------------|---------|
| Test file | `*_test.go` in the same package directory |
| Test function | `func Test<Name>(t *testing.T)` |
| Benchmark | `func Benchmark<Name>(b *testing.B)` |
| Table-driven | `tests := []struct{ ... }` loop with `t.Run` |

When `require_test_files: true`, every new `.go` file (excluding `_test.go`, `doc.go`, generated files) must have a corresponding `*_test.go` in the same directory.

---

## Gate 8: Review Tools

These tools run **before** AI reviewers are dispatched. Their structured output is passed to reviewers as grounding context.

### Security Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **gosec** | `gosec -fmt=json ./...` | JSON with issues array | SQL injection, command injection, hardcoded credentials, weak crypto, file path traversal, unhandled errors in security-critical paths |
| **govulncheck** | `govulncheck ./...` | Text with vulnerability entries | Known CVEs in dependencies and stdlib |

### Static Analysis Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **staticcheck** | `staticcheck -f=json ./...` | JSON with diagnostics | Deprecated API usage, unreachable code, incorrect format strings, inefficient operations |
| **go vet** | `go vet ./...` | Text to stderr | Printf format mismatches, unreachable code, suspicious constructs, struct tag errors |

### Performance Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **benchstat** | `go test -bench=. -benchmem -count=5 ./... > bench.txt && benchstat bench.txt` | Text table | Allocation counts, bytes per op, ns per op -- useful for before/after comparison |

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

**Error handling:**
- Swallowed errors: `_ = someFunc()` where the error carries actionable information
- Bare `return err` without context -- prefer `fmt.Errorf("doing X: %w", err)` to build an error chain
- `errors.Is` / `errors.As` not used when checking sentinel or typed errors (comparing with `==` breaks wrapping)
- Error messages starting with uppercase or ending with punctuation (Go convention: lowercase, no period)

**Naming and structure:**
- Exported names without doc comments (`golint` catches this but AI can assess quality)
- Stuttering: `package user` with type `UserService` -- prefer `Service`
- Interface pollution: defining interfaces where only one implementation exists and no testing benefit
- God structs: types with 10+ fields that should be decomposed

**Idioms:**
- Using `init()` for side effects that could be explicit constructor calls
- Returning concrete types from public APIs instead of interfaces (when the interface already exists)
- `sync.Mutex` as exported field (should be unexported)

### Patterns: security

**Injection:**
- SQL built with `fmt.Sprintf` instead of parameterized queries
- `os/exec.Command` with user-controlled arguments without validation
- `filepath.Join` with user input that could escape via `../`
- Template rendering with `text/template` instead of `html/template` for web output

**Secrets and crypto:**
- Hardcoded credentials, API keys, or tokens (string literals matching key patterns)
- `math/rand` used where `crypto/rand` is needed (tokens, nonces, session IDs)
- TLS config with `InsecureSkipVerify: true` outside of test files
- Weak hash algorithms (`md5`, `sha1`) for security purposes

**Access control:**
- Missing authentication middleware on routes that modify state
- Authorization checks that compare user ID from request body instead of token/context
- CORS config with `AllowAllOrigins: true` in production

### Patterns: logic

**Nil safety:**
- Type assertion without ok check: `v := x.(Type)` panics on mismatch -- use `v, ok := x.(Type)`
- Nil map write: writing to a `map` that was declared but never initialized with `make`
- Method call on nil interface: interface variable not checked before method dispatch
- Nil slice vs empty slice: `var s []T` (nil) vs `s := []T{}` (empty) -- matters for JSON marshaling (`null` vs `[]`)

**Concurrency:**
- Goroutine leak: goroutine blocked on channel with no writer/reader and no `context.Done()` select case
- Shared state without synchronization: map or slice accessed from multiple goroutines without mutex
- `sync.WaitGroup.Add` called inside the goroutine instead of before `go func()`
- Mutex copied by value: passing `sync.Mutex` or a struct containing one by value (use pointer)
- Missing `context.Context` propagation: function starts work but does not accept or check context for cancellation

**Error paths:**
- Deferred `Close()` on writable resource without checking the error: `defer f.Close()` -- for writes, the close error matters (unflushed data)
- Error check followed by code that does not return: `if err != nil { log.Error(err) }` then continues with the result as if no error occurred
- Shadowed `err` in nested block: `:=` inside an `if` creates a new `err` that does not propagate to the outer scope

### Patterns: test-quality

**Coverage gaps:**
- Error paths not tested: only the happy path has a test case
- Edge cases unnamed: test table missing zero value, nil input, empty string, max-length input, unicode
- Concurrency not tested: code uses goroutines but tests are single-threaded

**Test hygiene:**
- Test depends on external state (filesystem, network, database) without cleanup or isolation
- Assertions compare formatted strings instead of structured values (`assert.Equal(t, "expected", fmt.Sprintf(...))`)
- No `t.Parallel()` on independent tests (misses data races under `-race`)
- Mock that returns hardcoded success without matching input -- test passes for any behavior

**Anti-patterns:**
- Testing private functions directly instead of through the public API
- `time.Sleep` in tests for synchronization instead of channels/condition variables
- Test file in a different package than the code under test without a clear integration-test reason

### Patterns: performance

**Allocations:**
- String concatenation in a loop: use `strings.Builder` instead of `+=`
- Slice growth without pre-allocation: `append` in a loop when the final size is known -- use `make([]T, 0, n)`
- Returning `[]byte` from a function that builds it internally -- caller may need to copy, doubling allocation

**Hot paths:**
- `defer` in a tight loop: defer runs at function exit, not loop iteration -- use explicit calls
- Regex compiled inside a function called per-request: move to package-level `regexp.MustCompile`
- `reflect` usage in hot paths: reflection is 10-100x slower than type-specific code
- JSON marshal/unmarshal in hot loop: consider pre-allocated encoders or code generation

**Goroutine management:**
- Unbounded goroutine spawning: `go func()` in a loop without a semaphore or worker pool
- Context not propagated to spawned goroutines: cancellation does not reach child work
- `sync.Pool` misuse: pooling tiny objects or objects with complex lifecycle

### Patterns: nil-safety

**Nil pointer dereference:**
- Unchecked error return: `result, err := fn(); result.Field` without checking `err != nil` first
- Nil map access: reading from a `map` that may not be initialized -- returns zero value silently
- Nil map write: `m[key] = value` where `m` was declared with `var m map[K]V` but never `make`'d -- panics
- Interface nil check: `if x != nil { x.Method() }` -- an interface can be non-nil but hold a nil concrete value
- Type assertion without ok: `v := x.(Type)` panics when `x` is nil or wrong type -- use `v, ok := x.(Type)`

**Nil in return values:**
- Returning `nil, nil` (no value, no error) -- caller has no signal that nothing was found
- Pointer receiver on nil: calling a method on `*T` where `T` may be nil -- panics unless the method explicitly handles nil receiver
- Returning uninitialized struct pointer: `var p *Config; return p` -- downstream dereference panics

**Nil in collections:**
- Nil slice vs empty slice: `var s []T` marshals to `null` in JSON; `[]T{}` marshals to `[]` -- API consumers may break
- Nil channel: sending to or receiving from a nil channel blocks forever
- Nil function field: callback fields like `OnComplete func()` called without nil check

**Context and interfaces:**
- `context.Value()` returns `interface{}` -- caller must handle nil return before type assertion
- `errors.As()` target must be non-nil pointer -- passing `var err *MyError` (nil pointer) panics
- `io.Reader` / `io.Writer` may be nil in struct fields -- calling `Read`/`Write` panics

### Patterns: consequences

**Caller chain impact:**
- Changed function signature: all callers must be updated -- check with `grep -rn "functionName("` across the repo
- Modified return type: callers that destructure returns may silently get wrong values
- Changed error wrapping: callers using `errors.Is`/`errors.As` may stop matching if the wrap chain changes
- Removed or renamed exported symbol: breaks external consumers and other packages in the module

**Interface contract changes:**
- Added method to interface: all implementations must be updated -- compiler catches this but only if all implementations are in the same build
- Changed method semantics (same signature, different behavior): callers rely on the old behavior -- no compiler warning
- Modified embedded interface: all types embedding it gain/lose methods

**Shared state impact:**
- Modified struct field: all readers/writers of that field must be audited
- Changed mutex scope: concurrent access patterns may become unsafe
- Modified global variable or `init()`: all packages importing this package are affected
- Changed channel buffer size: senders/receivers may block differently

**Configuration and environment:**
- Renamed config key or environment variable: deployment configs, CI pipelines, and docs must update
- Changed default value: existing deployments using implicit defaults now behave differently
- Removed feature flag: code paths that checked the flag need cleanup

### Patterns: dead-code

**Orphaned functions and methods:**
- Exported function with zero callers after the change -- was it the only caller that was removed?
- Method on a type that is no longer instantiated anywhere
- Interface implementation where the interface itself was removed or changed
- Helper function that only served the deleted code path

**Unreachable branches:**
- `switch` case that can never match after a type change
- `if` condition that is always true/false after constant or type changes
- Error handling for an error that is no longer returned by the modified function
- `select` case on a channel that is no longer written to

**Stale artifacts:**
- Test file for a function that no longer exists
- Mock or stub for an interface that changed or was removed
- Type definition only used by deleted code
- Constants or variables only referenced by removed code
- Build tags or feature flags for removed features
- Generated code (protobuf, mocks) that is no longer regenerated after proto/interface changes

**Import bloat:**
- Package imported but only used by deleted code
- Blank import (`_ "pkg"`) for side effects of a removed feature

---

## Dependencies

Required tools and install commands. `rigor:review` logs a warning for missing tools but does not block.

| Tool | Install | Minimum Version | Purpose |
|------|---------|-----------------|---------|
| `go` | [golang.org/dl](https://golang.org/dl/) | 1.21+ | Build, test, vet, coverage |
| `golangci-lint` | `go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest` | v1.55+ | Lint aggregator |
| `gosec` | `go install github.com/securego/gosec/v2/cmd/gosec@latest` | v2.18+ | Security scanner |
| `govulncheck` | `go install golang.org/x/vuln/cmd/govulncheck@latest` | latest | Vulnerability checker |
| `staticcheck` | `go install honnef.co/go/tools/cmd/staticcheck@latest` | 2023.1+ | Static analysis |

Optional:

| Tool | Install | Purpose |
|------|---------|---------|
| `benchstat` | `go install golang.org/x/perf/cmd/benchstat@latest` | Benchmark comparison |
| `dlv` | `go install github.com/go-delve/delve/cmd/dlv@latest` | Debugger (not used by gates, useful for investigation) |
