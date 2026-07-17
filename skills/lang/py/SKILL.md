---
name: rigor:lang:py
description: >-
  Python language pack: detection heuristics, implementation commands
  (lint, test, coverage, build), review tools (security scanners, static
  analysis), and review patterns organized by reviewer focus area. Loaded
  automatically when a diff or project contains Python files. Provides
  defaults that .rigor/config.yaml can override. Use when any rigor gate
  runs against Python code. Skip when the project contains no Python files.
---

Python-specific configuration and patterns for all Rigor gates. This is a fat lang pack -- it covers detection, implementation tooling (Gate 0), review tooling and patterns (Gate 8), and required dependencies.

---

## Detection

A project uses Python when ANY of these are true:

| Signal | Check |
|--------|-------|
| Project marker | `pyproject.toml`, `setup.py`, `setup.cfg`, or `requirements.txt` exists in repo root (or nearest parent) |
| File extension | Diff contains `.py` files |
| Config override | `.rigor/config.yaml` sets `language: py` |

A diff can contain multiple languages. Each matching lang pack is loaded. Reviewers receive patterns from all loaded packs.

---

## Config Override Precedence

Lang packs provide defaults. `.rigor/config.yaml` overrides them when set:

```
1. config.yaml explicit value (non-empty string) → use it
2. Lang pack default (this file)                 → use it
3. Neither                                       → skip that check
```

Example: this pack defaults `lint_command` to `ruff check .`. If config.yaml sets `lint_command: "ruff check --select=ALL ."`, the config wins.

---

## Gate 0: Implementation

### Commands

| Purpose | Command | Exit Code | Notes |
|---------|---------|-----------|-------|
| **Lint** | `ruff check .` | 0 = clean | Preferred; falls back to `flake8 .` or `pylint **/*.py` if ruff is not installed |
| **Format** | `ruff format --check .` | 0 = clean | Falls back to `black --check .` if ruff is not installed |
| **Type check** | `mypy .` | 0 = clean | Or `pyright .` if detected in config; checks type annotations |
| **Test** | `pytest --cov --cov-report=term-missing` | 0 = pass | `--cov` enables coverage via pytest-cov; `--cov-report=term-missing` shows uncovered lines |
| **Build** | `python -m py_compile <file>` | 0 = compiles | Catches syntax errors; for package builds use `python -m build` |

### Package Manager Detection

Detect the project's package manager in this order and use the corresponding commands:

| Manager | Detection Signal | Install Command | Run Command |
|---------|-----------------|-----------------|-------------|
| **uv** | `uv.lock` exists or `[tool.uv]` in `pyproject.toml` | `uv sync` | `uv run pytest ...` |
| **Poetry** | `poetry.lock` exists or `[tool.poetry]` in `pyproject.toml` | `poetry install` | `poetry run pytest ...` |
| **PDM** | `pdm.lock` exists or `[tool.pdm]` in `pyproject.toml` | `pdm install` | `pdm run pytest ...` |
| **pip** | `requirements.txt` or `setup.py` exists | `pip install -r requirements.txt` | `pytest ...` |
| **PEP 621** | `pyproject.toml` with `[project]` section (no manager lock) | `pip install -e .` | `pytest ...` |

### Coverage Parsing

`pytest --cov --cov-report=term-missing` outputs a table ending with:

```
TOTAL                          1234    123    90%
```

Extract the percentage from the last column of the `TOTAL` row. Compare against `gates.gate_0.coverage_threshold` (default: 85).

Alternative: `pytest --cov --cov-report=json` writes `coverage.json` where:

```json
{ "totals": { "percent_covered": 90.0 } }
```

Extract `totals.percent_covered`.

### Test File Convention

| Convention | Pattern |
|------------|---------|
| Test file | `test_*.py` or `*_test.py` in `tests/` directory or alongside source |
| Test function | `def test_<name>(...)` or methods in classes starting with `Test` |
| Fixtures | `conftest.py` for shared fixtures (pytest auto-discovery) |
| Parametrized | `@pytest.mark.parametrize("arg", [...])` for table-driven tests |

When `require_test_files: true`, every new `.py` file (excluding `test_*.py`, `*_test.py`, `conftest.py`, `__init__.py`, generated files) must have a corresponding test file in `tests/` or the same directory.

---

## Gate 8: Review Tools

These tools run **before** AI reviewers are dispatched. Their structured output is passed to reviewers as grounding context.

### Security Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **bandit** | `bandit -r . -f json` | JSON with results array | SQL injection, command injection, hardcoded passwords, insecure deserialization (`pickle`), weak crypto, shell injection, XML vulnerabilities |
| **pip-audit** | `pip-audit --format=json` | JSON with vulnerability entries | Known CVEs in installed dependencies |
| **safety** | `safety check --json` | JSON with vulnerability list | Known CVEs in `requirements.txt` or installed packages |

### Static Analysis Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **ruff** | `ruff check --output-format=json .` | JSON with diagnostics | Lint violations, import ordering, unused imports, complexity, type annotation issues |
| **mypy** | `mypy --output=json .` | JSON with error entries | Type errors, missing annotations, incompatible types, unreachable code |
| **pylint** | `pylint --output-format=json .` | JSON with messages array | Code quality, naming, design, refactoring suggestions |

### Performance Tools

| Tool | Command | Output Format | What It Catches |
|------|---------|---------------|-----------------|
| **pytest-benchmark** | `pytest --benchmark-only --benchmark-json=bench.json` | JSON with benchmark stats | Execution time, iterations, outliers -- useful for before/after comparison |

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

**Type safety and annotations:**
- Missing type annotations on public functions/methods -- callers rely on documentation or inference
- `Any` type used where a concrete type or `Union` would be more precise
- `# type: ignore` comments suppressing real type errors instead of fixing the root cause
- Missing `-> None` return annotation on functions that return nothing (PEP 484 convention)
- `Optional[X]` vs `X | None` -- prefer `X | None` (PEP 604, Python 3.10+) for consistency

**Naming and structure:**
- Naming violations: functions/variables not `snake_case`, classes not `PascalCase`, constants not `UPPER_SNAKE_CASE`
- God modules: single file with 500+ lines that should be decomposed into a package
- Circular imports: module A imports B, B imports A -- restructure or use lazy imports
- Wildcard imports: `from module import *` pollutes namespace and hides dependencies

**Idioms:**
- Mutable default arguments: `def fn(items=[])` -- the list is shared across calls; use `def fn(items=None)` with `items = items or []`
- Bare `except:` or `except Exception:` catching everything including `KeyboardInterrupt` and `SystemExit`
- Using `type()` for type checking instead of `isinstance()` -- misses subclasses
- Manual resource management instead of `with` statement for files, locks, connections
- String formatting with `%` or `.format()` in new code -- prefer f-strings (Python 3.6+)

### Patterns: security

**Injection:**
- SQL built with f-strings or `%` formatting instead of parameterized queries (`cursor.execute("...", params)`)
- `subprocess.run(shell=True)` or `os.system()` with user-controlled arguments -- command injection
- `eval()`, `exec()`, `compile()` with user input -- arbitrary code execution
- `yaml.load()` without `Loader=SafeLoader` -- arbitrary code execution via YAML deserialization
- `pickle.loads()` / `pickle.load()` on untrusted data -- arbitrary code execution
- `jinja2.Template` with `autoescape=False` rendering user content -- XSS

**Secrets and crypto:**
- Hardcoded credentials, API keys, or tokens (string literals matching key patterns)
- `random` module for security purposes (tokens, nonces, session IDs) -- use `secrets` module
- `hashlib.md5()` or `hashlib.sha1()` for password hashing -- use `bcrypt`, `argon2`, or `hashlib.scrypt()`
- Sensitive data in log output or exception messages

**Access control:**
- `DEBUG = True` or `ALLOWED_HOSTS = ['*']` in Django/Flask production config
- Missing CSRF protection on state-changing endpoints
- Regex without timeout or complexity limit on user input -- ReDoS risk
- Overly permissive file permissions: `os.chmod(path, 0o777)`

### Patterns: logic

**None safety:**
- Attribute access on potentially `None` value without check: `result = fn(); result.attr` where `fn` may return `None`
- Dictionary `[key]` access without `.get()` or `in` check -- raises `KeyError`
- Chained `.get()` calls: `d.get("a").get("b")` -- first `.get()` returns `None` on miss, second crashes
- `len()` on potentially `None` value -- raises `TypeError`
- Unpacking return value without checking: `a, b = fn()` where `fn` may return `None`

**Mutable state hazards:**
- Mutable default argument: `def fn(items=[])` -- shared across calls, causes subtle bugs
- Modifying a list/dict while iterating over it -- raises `RuntimeError` or skips elements
- Shallow copy with `list()` or `.copy()` when nested structures need `copy.deepcopy()`
- Class-level mutable attributes shared across instances: `class Foo: items = []` -- all instances share the same list

**Async pitfalls:**
- `asyncio.run()` called inside an already-running event loop -- raises `RuntimeError`
- Blocking call (`time.sleep`, synchronous I/O) inside `async` function -- blocks the entire event loop
- Fire-and-forget coroutine: `asyncio.create_task(coro())` without storing the reference -- exceptions are silently lost
- Missing `await` on a coroutine call -- coroutine is created but never executed, no error raised

**Error paths:**
- Bare `except:` catching `SystemExit` and `KeyboardInterrupt` -- use `except Exception:`
- `except Exception as e: pass` -- swallowing errors silently
- Re-raising without chain: `raise NewError()` instead of `raise NewError() from e` -- loses original traceback
- `finally` block with `return` -- silently swallows exceptions from `try`/`except`

### Patterns: test-quality

**Coverage gaps:**
- Error paths not tested: only the happy path has a test case
- Edge cases missing: `None` input, empty string, empty collection, zero, negative numbers, unicode
- Async code not tested with `pytest-asyncio` or equivalent -- async paths skipped entirely
- Exception types and messages not asserted: `pytest.raises(Exception)` too broad

**Test hygiene:**
- Test depends on filesystem, network, or database without fixtures or mocking
- Fixtures with `scope="session"` mutating shared state between tests
- `monkeypatch` or `mock.patch` not scoped correctly -- mock leaks between tests
- Assertions on string representations instead of structured values
- `time.sleep()` in tests for synchronization -- use `asyncio` utilities or polling

**Anti-patterns:**
- Testing private methods (`_method`) directly instead of through the public API
- `conftest.py` with fixtures that are only used by one test file -- move to the test file
- Parametrized tests without descriptive IDs: `@pytest.mark.parametrize("x", [1, 2])` -- use `pytest.param(1, id="one")`
- `assert True` or `assert result` without comparing to expected value -- test passes vacuously

### Patterns: performance

**Allocations and copies:**
- String concatenation in a loop with `+=` -- use `"".join(parts)` or `io.StringIO`
- List comprehension building a list just to pass to `any()` / `all()` -- use generator expression: `any(x for x in items)`
- Creating intermediate lists: `list(filter(...))` or `list(map(...))` when a generator suffices
- Repeated dictionary/set construction inside a loop when it could be hoisted

**Hot paths:**
- Regex compiled inside a function called per-request: move to module-level `re.compile()`
- `import` statements inside functions called frequently -- import at module level
- Global interpreter lock (GIL) contention: CPU-bound work in threads -- use `multiprocessing` or `concurrent.futures.ProcessPoolExecutor`
- `datetime.now()` called repeatedly in tight loops -- cache or batch timestamp generation

**I/O and concurrency:**
- Synchronous I/O in async handlers: `open()`, `requests.get()` block the event loop -- use `aiofiles`, `httpx.AsyncClient`
- N+1 queries in ORM loops: `for item in items: item.related` without `select_related`/`prefetch_related` (Django) or `joinedload` (SQLAlchemy)
- Unbounded `asyncio.gather()` with thousands of coroutines -- use `asyncio.Semaphore` for concurrency limiting
- Loading entire file into memory with `.read()` when streaming line-by-line suffices

### Patterns: nil-safety

**None dereference:**
- Attribute access on `Optional[T]` without narrowing: `value: Optional[str]; value.upper()` -- crashes if `None`
- `dict[key]` on a `Dict` that may not contain the key -- use `.get(key)` or check `key in dict`
- Chained attribute access: `obj.parent.child.value` where any link may be `None`
- Return value of `re.match()` / `re.search()` used without `None` check -- `.group()` crashes on `None`
- `next(iterator)` without default -- raises `StopIteration` if iterator is empty; use `next(iterator, None)` and check

**None in collections:**
- `None` in a list passed to `sum()`, `max()`, `min()` -- raises `TypeError`
- Sorting a list containing `None` values -- raises `TypeError` in Python 3 (no implicit ordering)
- `None` used as dictionary key -- technically valid but almost always a bug
- Unpacking from a function that returns `Optional[Tuple]`: `a, b = fn()` where `fn` may return `None`

**None propagation:**
- Function returns `None` implicitly (no `return` statement on some paths) -- callers may not expect it
- `or` chain for defaults: `value = x or y or z` -- breaks if `x` is a valid falsy value (`0`, `""`, `False`)
- `getattr(obj, "attr", None)` result used without `None` check before method call

**Type narrowing gaps:**
- `isinstance()` check that does not cover all union variants -- unhandled case returns `None`
- `TypeGuard` function that returns `True` incorrectly -- narrows the type but the value is actually `None`
- `cast()` used to bypass `None` checks -- no runtime effect, `None` still passes through

### Patterns: consequences

**Caller chain impact:**
- Changed function signature: all callers must be updated -- check with `grep -rn "function_name("` across the repo
- Modified return type: callers that destructure or compare returns may silently get wrong values
- Changed exception type: callers using `except SpecificError` may stop catching if the exception class changes
- Removed or renamed public symbol: breaks consumers and other modules importing it

**Module boundary changes:**
- Modified `__init__.py` exports: consumers importing from the package may get different symbols
- Changed relative to absolute imports (or vice versa): may break if package structure changes
- Moved module: relative imports in consumers break -- `sys.path` manipulation may mask the break until runtime
- Changed package name in `pyproject.toml` or `setup.py`: all install commands and imports must update

**Shared state impact:**
- Modified class attribute: all subclasses and instances inheriting the attribute are affected
- Changed global/module-level variable: all modules importing it see the new value
- Modified `__init__` parameters: all instantiation sites must pass the new shape
- Changed signal/event payload (Django signals, custom events): all receivers must handle the new shape

**Configuration and environment:**
- Renamed environment variable: deployment configs, CI pipelines, Docker, and docs must update
- Changed default value in settings/config: existing deployments using implicit defaults now behave differently
- Modified `pyproject.toml` dependency version: transitive dependency conflicts may surface
- Removed feature flag or config key: code paths that checked it need cleanup

### Patterns: dead-code

**Orphaned functions and classes:**
- Public function with zero callers after the change -- was the removed code the only consumer?
- Class that is no longer instantiated or subclassed anywhere
- Method on a class that overrides a parent method that was removed
- Helper function that only served the deleted code path
- Decorator defined but never applied after refactor

**Unreachable branches:**
- `if` condition that is always `True`/`False` after a type or constant change
- `except` clause for an exception no longer raised by the modified function
- `match` / `case` branch (Python 3.10+) for a pattern that can never occur after type changes
- `else` branch after an exhaustive `if/elif` chain that now covers all cases

**Stale artifacts:**
- Test file (`test_*.py`) for a function or class that no longer exists
- Fixture in `conftest.py` that is no longer used by any test
- Type stub file (`.pyi`) for a module that was refactored or removed
- Migration file (Alembic, Django) for a model that was dropped
- Constants or variables only referenced by removed code

**Import bloat:**
- Module imported but only used by deleted code -- still in `requirements.txt` or `pyproject.toml`
- `__all__` listing symbols that no longer exist in the module
- Conditional import (`try: import X except ImportError`) for a feature that was removed

---

## Dependencies

Required tools and install commands. `rigor:review` logs a warning for missing tools but does not block.

| Tool | Install | Minimum Version | Purpose |
|------|---------|-----------------|---------|
| `python` | [python.org](https://www.python.org/downloads/) | 3.10+ | Runtime |
| `ruff` | `pip install ruff` | 0.4+ | Linting and formatting |
| `mypy` | `pip install mypy` | 1.8+ | Type checking |
| `pytest` | `pip install pytest` | 8.0+ | Testing |
| `pytest-cov` | `pip install pytest-cov` | 5.0+ | Coverage reporting |

Optional:

| Tool | Install | Purpose |
|------|---------|---------|
| `bandit` | `pip install bandit` | Security scanner |
| `pip-audit` | `pip install pip-audit` | Dependency vulnerability checker |
| `pyright` | `pip install pyright` | Alternative type checker (faster, stricter) |
| `pylint` | `pip install pylint` | Extended static analysis |
| `black` | `pip install black` | Code formatting (fallback if ruff not available) |
| `flake8` | `pip install flake8` | Linting (fallback if ruff not available) |
| `pytest-asyncio` | `pip install pytest-asyncio` | Async test support |
| `pytest-benchmark` | `pip install pytest-benchmark` | Performance benchmarking |
