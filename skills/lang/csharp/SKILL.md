---
name: rigor:lang:csharp
description: >-
  C#/.NET language pack: detection heuristics, implementation commands
  (lint, test, coverage, build), review tools (security scanners, static
  analysis), and review patterns organized by reviewer focus area. Loaded
  automatically when a diff or project contains C# files. Provides defaults
  that .rigor/config.yaml can override. Use when any rigor gate runs
  against C# code. Skip when the project contains no C# files.
---

C#/.NET-specific configuration and patterns for all Rigor gates. This is a fat lang pack -- it covers detection, implementation tooling (Gate 0), review tooling and patterns (Gate 8), and required dependencies.

---

## Detection

A project uses C# when ANY of these are true:

| Signal | Check |
|--------|-------|
| Project marker | `*.csproj` or `*.sln` file exists in repo root (or nearest parent) |
| File extension | Diff contains `.cs` files |
| Config override | `.rigor/config.yaml` sets `language: csharp` |

A diff can contain multiple languages. Each matching lang pack is loaded. Reviewers receive patterns from all loaded packs.

---

## Config Override Precedence

Lang packs provide defaults. `.rigor/config.yaml` overrides them when set:

```
1. config.yaml explicit value (non-empty string) → use it
2. Lang pack default (this file)                 → use it
3. Neither                                       → skip that check
```

Example: this pack defaults `lint_command` to `dotnet format --verify-no-changes`. If config.yaml sets `lint_command: "dotnet format --verify-no-changes --diagnostics"`, the config wins.

---

## Gate 0: Implementation

### Commands

| Purpose | Command | Exit Code | Notes |
|---------|---------|-----------|-------|
| **Lint** | `dotnet format --verify-no-changes` | 0 = clean | Checks formatting against `.editorconfig`; use `--diagnostics` for analyzer warnings |
| **Test** | `dotnet test --collect:"XPlat Code Coverage" --results-directory ./coverage` | 0 = pass | Runs all test projects; Coverlet collects coverage |
| **Coverage** | `dotnet tool run reportgenerator -reports:./coverage/**/coverage.cobertura.xml -targetdir:./coverage/report -reporttypes:TextSummary` | always 0 | Generates summary; parse `Summary.txt` for line coverage |
| **Build** | `dotnet build --no-restore` | 0 = compiles | Catches type errors; `--no-restore` assumes restore already ran |
| **Analyzers** | `dotnet build -warnaserror` | 0 = clean | Roslyn analyzers emit warnings; `-warnaserror` promotes to errors |

### Coverage Parsing

ReportGenerator's `Summary.txt` outputs:

```
Line coverage: 82.5%
```

Extract the percentage from the `Line coverage:` line. Compare against `gates.gate_0.coverage_threshold` (default: 85).

Alternative: Coverlet's console output includes:

```
| Total   | 82.5%  |
```

Extract from the last `Total` line.

### Test File Convention

| Convention | Pattern |
|------------|---------|
| Test project | Separate project: `ProjectName.Tests.csproj` in `tests/` or parallel directory |
| Test class | Class with `[TestClass]` (MSTest), inherits from `TestBase`, or uses `[Fact]`/`[Theory]` (xUnit) |
| Test method | `[TestMethod]` (MSTest), `[Fact]`/`[Theory]` (xUnit), `[Test]` (NUnit) |
| Naming | `MethodName_Scenario_ExpectedBehavior` or `Should_ExpectedBehavior_When_Scenario` |

When `require_test_files: true`, every new `.cs` file (excluding test files, `Program.cs`, `AssemblyInfo.cs`, generated files) should have corresponding tests in a test project.

---

## Gate 8: Review Tools

These tools run **before** AI reviewers are dispatched. Their structured output is passed to reviewers as grounding context.

### Security Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **dotnet-security-guard** | `dotnet tool run security-scan .` | Text with findings | SQL injection, XSS, command injection, path traversal, insecure deserialization, weak crypto |
| **dotnet audit** | `dotnet list package --vulnerable` | Text with CVE entries | Known CVEs in NuGet dependencies |

### Static Analysis Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **Roslyn Analyzers** | `dotnet build -warnaserror` | MSBuild warnings/errors | Code quality, naming, design, performance, reliability issues |
| **dotnet format** | `dotnet format --verify-no-changes --diagnostics` | Text diff | Formatting violations, analyzer diagnostics |

### Performance Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **BenchmarkDotNet** | `dotnet test --filter "Category=Benchmark"` | Text table | Allocations, throughput, GC pressure -- useful for before/after comparison |

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

**Encapsulation and design:**
- `public` fields on classes: use properties with `{ get; set; }` for encapsulation
- God classes: types with 15+ methods or 10+ fields that should be decomposed
- Missing `sealed` on classes not designed for inheritance -- unsealed classes have performance and design implications
- `static` utility classes instead of extension methods or dependency injection

**Naming and structure:**
- Naming violations: methods not PascalCase, private fields not `_camelCase`, interfaces not prefixed with `I`
- Magic numbers and strings instead of constants or `enum` values
- Excessive region blocks hiding poor class organization

**Idioms:**
- String interpolation in logging: `_logger.LogInformation($"...")` -- allocates even when log level is disabled; use structured logging: `_logger.LogInformation("User {UserId} logged in", userId)`
- `IDisposable` not implemented on classes holding unmanaged resources or other disposables
- `async void` instead of `async Task` -- exceptions cannot be caught by caller

### Patterns: security

**Injection:**
- SQL injection: string concatenation in `SqlCommand` or raw SQL in EF Core instead of parameterized queries
- Insecure deserialization: `BinaryFormatter`, `JavaScriptSerializer`, `TypeNameHandling.All` in JSON.NET
- `Directory.GetFiles()` or `Path.Combine()` with user input without sanitization
- Regex without timeout: `new Regex(userInput)` -- ReDoS risk; use `Regex(pattern, options, timeout)`

**Secrets and crypto:**
- Hardcoded connection strings, API keys, or secrets (use `IConfiguration`, `Secret Manager`, or Key Vault)
- `MD5` or `SHA1` for security purposes (passwords, tokens) -- use `SHA256`+ or `BCrypt`/`Argon2`
- `HttpClient` created without certificate validation in production

**Access control:**
- `[AllowAnonymous]` on controllers/actions that modify state
- CORS with `AllowAnyOrigin()` combined with `AllowCredentials()` -- security vulnerability
- `X-Frame-Options` or CSP headers missing on web responses
- Missing `[ValidateAntiForgeryToken]` on POST actions in MVC

### Patterns: logic

**Null reference:**
- Accessing `.Property` on a nullable reference without null check (`?.` or `!= null`)
- `as` cast without null check: `var foo = obj as Foo; foo.Method()` -- crashes if cast fails
- Dictionary `[key]` access without `TryGetValue` -- throws `KeyNotFoundException`

**Async hazards:**
- `async`/`await` deadlock: `.Result` or `.Wait()` on async code in synchronous context -- use `await` or `GetAwaiter().GetResult()`
- `async void` instead of `async Task` -- exceptions cannot be caught by caller

**Misused APIs:**
- LINQ deferred execution: `IEnumerable<T>` evaluated multiple times -- materialize with `.ToList()` when the source is expensive
- `==` vs `.Equals()` for value comparison: `==` on reference types compares references unless overridden
- `IEnumerable` returned from method that yields from a database query -- connection may close before enumeration
- Floating point comparison: `if (a == b)` with `double`/`float` -- use epsilon comparison
- `DateTime.Now` vs `DateTime.UtcNow` -- timezone bugs in server code; prefer `DateTimeOffset`

**Error paths:**
- Exception swallowing: `catch (Exception) { }` or `catch { }` with no logging or rethrow
- `switch` on enum without `default` case or missing enum values -- silent fall-through on new values
- Mutable struct returned by value -- modifications lost because the caller gets a copy

### Patterns: test-quality

**Coverage gaps:**
- Only happy path tested: no tests for null input, empty collections, boundary values, exception paths
- `[Fact]` test methods without meaningful assertion -- test passes vacuously
- No `[Theory]` / `[InlineData]` for parameterized cases -- copy-pasted test methods with different inputs

**Test hygiene:**
- Test depends on execution order or shared mutable state between tests
- Mocking concrete classes instead of interfaces -- brittle, breaks when implementation changes
- `Thread.Sleep()` in tests for timing -- use `TaskCompletionSource` or test-specific scheduling
- Integration tests hitting real databases without cleanup or transaction rollback
- Missing `IDisposable` cleanup in test fixtures -- resource leaks across test runs

**Anti-patterns:**
- Assertions on `ToString()` output instead of structured properties
- Snapshot testing without understanding what changed -- auto-accepting snapshot updates

### Patterns: performance

**Allocations:**
- Boxing: value types (`int`, `struct`) passed to `object` parameter -- allocates on heap
- String concatenation in loops: use `StringBuilder` instead of `+=` on `string`
- Large object heap (LOH) pressure: allocating arrays > 85KB in loops without pooling -- use `ArrayPool<T>`

**Hot paths:**
- LINQ in hot paths: `.Where().Select().ToList()` allocates multiple intermediate collections -- consider `for` loops or `Span<T>`
- Reflection in hot paths: `GetType()`, `GetProperty()`, `Invoke()` -- cache delegates or use source generators
- `Task.Run()` in ASP.NET request handlers -- wastes a thread pool thread for async work; use `async`/`await` directly
- Missing `ConfigureAwait(false)` in library code -- unnecessary synchronization context capture

**I/O and resources:**
- `HttpClient` per request: creates new TCP connections -- use `IHttpClientFactory` or singleton
- EF Core: loading entire entity graphs with `.Include()` when only a few fields are needed -- use `.Select()` projection
- Missing `AsNoTracking()` on read-only EF Core queries -- unnecessary change tracker overhead

### Patterns: nil-safety

**Nullable reference without check:**
- `string? name` used as `name.Length` without `!= null` or `?.`
- `FirstOrDefault()` / `SingleOrDefault()` result used without null check -- returns `default(T)` which is `null` for reference types
- `as` cast without null check: `var foo = obj as Foo; foo.Method()` -- crashes if cast fails
- Dictionary `[key]` access without `TryGetValue` -- throws `KeyNotFoundException`

**Null suppression and propagation:**
- `?.` chaining that silently propagates null through a long call chain where null at any point indicates a bug
- Null-forgiving operator `!` suppressing nullable warnings -- hides real null paths
- Constructor not initializing required non-nullable properties -- compiler warning suppressed with `= null!`

**Nullable value types:**
- `Nullable<T>.Value` without `.HasValue` check -- throws `InvalidOperationException`
- Event invocation without null check: `MyEvent(this, args)` -- crashes if no subscribers; use `MyEvent?.Invoke(this, args)`

**Async null:**
- `Task<T?>` result awaited and used without null check on the inner value

### Patterns: consequences

**Caller chain impact:**
- Changed `public` API signature: all consuming projects/packages must be updated -- especially in multi-project solutions
- Changed interface definition: all implementations across the solution must update
- Renamed controller route or changed `[Route]` attribute: API consumers and frontend clients break
- Changed middleware pipeline order in `Program.cs` / `Startup.cs`: downstream middleware sees different request state

**Data and schema changes:**
- Modified `DbContext` or entity configuration: migrations may be needed; existing data may not conform
- Changed `enum` values or order: serialized data using integer representation breaks
- Modified shared model/DTO: all serialization/deserialization points must handle the new shape

**Configuration and environment:**
- Modified `appsettings.json` keys: deployment configs, environment variables, and CI/CD must update
- Modified NuGet package version: transitive dependency conflicts may surface in consuming projects
- Removed `[Obsolete]` member that consumers may still reference

### Patterns: dead-code

**Orphaned functions and types:**
- `public` method with zero callers across the solution -- search with `dotnet tool run roslynator analyze`
- Controller action with no route or unreachable route after route changes
- `partial class` fragment with no matching partial -- orphaned after refactor
- Entity/model class for a database table that was dropped or renamed

**Unreachable branches:**
- Middleware registered but never reached (earlier middleware short-circuits)
- `IServiceCollection` registration for a service no longer injected anywhere
- Exception type defined but never thrown after error handling refactor
- `#if DEBUG` or `#if FEATURE_FLAG` blocks for removed features

**Stale artifacts:**
- Test class for a removed feature -- still compiles but tests dead code paths
- Configuration section reader for a removed `appsettings.json` section
- Constants or variables only referenced by removed code
- Generated code (protobuf, mocks) that is no longer regenerated after proto/interface changes

---

## Dependencies

Required tools and install commands. `rigor:review` logs a warning for missing tools but does not block.

| Tool | Install | Minimum Version | Purpose |
|------|---------|-----------------|---------|
| `dotnet` SDK | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) | 8.0+ | Build, test, format, analyzers |
| Coverlet | `dotnet add package coverlet.collector` (in test projects) | 6.0+ | Code coverage collection |
| ReportGenerator | `dotnet tool install -g dotnet-reportgenerator-globaltool` | 5.0+ | Coverage report generation |

Optional:

| Tool | Install | Purpose |
|------|---------|---------|
| `roslynator` | `dotnet tool install -g roslynator.dotnet.cli` | Extended Roslyn analysis |
| `dotnet-security-guard` | NuGet package `SecurityCodeScan.VS2019` | Security scanner |
| BenchmarkDotNet | `dotnet add package BenchmarkDotNet` | Performance benchmarking |
| `dotnet-outdated` | `dotnet tool install -g dotnet-outdated-tool` | Dependency freshness check |
