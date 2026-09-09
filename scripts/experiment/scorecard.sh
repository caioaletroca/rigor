#!/usr/bin/env bash
set -euo pipefail

# scorecard.sh - Grade a worktree against 10 binary checks for the quality experiment.
# Usage: ./scorecard.sh <worktree-path> [--model <name>] [--condition <name>] [--output <path>]

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: scorecard.sh <worktree-path> [OPTIONS]

Grade a worktree against 10 binary quality checks (0 or 1 each, 10 max).

Arguments:
  worktree-path          Path to the worktree to grade

Options:
  --model <name>         Model identifier (default: unknown)
  --condition <name>     Experiment condition (default: unknown)
  --output <path>        Write JSON to file instead of stdout
  --help                 Show this help message
USAGE
  exit 0
}

WORKTREE=""
MODEL="unknown"
CONDITION="unknown"
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --condition)
      CONDITION="$2"
      shift 2
      ;;
    --output)
      OUTPUT="$2"
      shift 2
      ;;
    -*)
      echo "Error: unknown option $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$WORKTREE" ]]; then
        WORKTREE="$1"
        shift
      else
        echo "Error: unexpected argument $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$WORKTREE" ]]; then
  echo "Error: worktree path is required" >&2
  echo "Run with --help for usage" >&2
  exit 1
fi

if [[ ! -d "$WORKTREE" ]]; then
  echo "Error: worktree path does not exist: $WORKTREE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Check functions - each prints 0 or 1
# ---------------------------------------------------------------------------

check_builds() {
  if (cd "$WORKTREE" && npm run build) >/dev/null 2>&1; then
    echo 1
  else
    echo 0
  fi
}

check_test_file_exists() {
  local found
  found=$(find "$WORKTREE/src" -type f \( -name 'cycle-history*.test.ts' -o -name 'history*.test.ts' \) 2>/dev/null | head -1)
  if [[ -n "$found" ]]; then
    echo 1
  else
    echo 0
  fi
}

check_tests_pass() {
  if (cd "$WORKTREE" && npm test) >/dev/null 2>&1; then
    echo 1
  else
    echo 0
  fi
}

check_coverage_above_85() {
  local output
  output=$( (cd "$WORKTREE" && npx vitest run --coverage) 2>&1 ) || true

  # Look for coverage summary lines like "All files  |  87.5  | ..." or "Statements : 90%"
  local pct
  pct=$(echo "$output" | grep -iE '(All files|Statements)' | head -1 | grep -oE '[0-9]+(\.[0-9]+)?' | head -1) || true

  if [[ -n "$pct" ]]; then
    # Compare: pct >= 85 (using awk for float comparison)
    if awk "BEGIN { exit !($pct >= 85) }"; then
      echo 1
      return
    fi
  fi
  echo 0
}

check_lint_clean() {
  if (cd "$WORKTREE" && npx tsc --noEmit) >/dev/null 2>&1; then
    echo 1
  else
    echo 0
  fi
}

check_tool_registers() {
  local found=0
  if [[ -f "$WORKTREE/src/server.ts" ]]; then
    if grep -qi 'cycle_history\|registerHistoryTools\|history' "$WORKTREE/src/server.ts" 2>/dev/null; then
      found=1
    fi
  fi
  if [[ "$found" -eq 0 ]] && [[ -f "$WORKTREE/src/tools/index.ts" ]]; then
    if grep -qi 'cycle_history\|registerHistoryTools\|history' "$WORKTREE/src/tools/index.ts" 2>/dev/null; then
      found=1
    fi
  fi
  echo "$found"
}

check_handler_follows_pattern() {
  local history_files
  history_files=$(find "$WORKTREE/src/tools" -type f -name '*.ts' 2>/dev/null | xargs grep -li 'history' 2>/dev/null) || true

  if [[ -z "$history_files" ]]; then
    echo 0
    return
  fi

  local has_call_tool_result=0
  local has_text_result=0

  if echo "$history_files" | xargs grep -lq 'CallToolResult' 2>/dev/null; then
    has_call_tool_result=1
  fi
  if echo "$history_files" | xargs grep -lq 'textResult' 2>/dev/null; then
    has_text_result=1
  fi

  if [[ "$has_call_tool_result" -eq 1 || "$has_text_result" -eq 1 ]]; then
    echo 1
  else
    echo 0
  fi
}

check_tests_follow_pattern() {
  local test_files
  test_files=$(find "$WORKTREE/src" -type f \( -name 'cycle-history*.test.ts' -o -name 'history*.test.ts' \) 2>/dev/null) || true

  if [[ -z "$test_files" ]]; then
    echo 0
    return
  fi

  local has_describe=0
  local has_it=0

  if echo "$test_files" | xargs grep -lq 'describe(' 2>/dev/null; then
    has_describe=1
  fi
  if echo "$test_files" | xargs grep -lq 'it(' 2>/dev/null; then
    has_it=1
  fi

  if [[ "$has_describe" -eq 1 && "$has_it" -eq 1 ]]; then
    echo 1
  else
    echo 0
  fi
}

check_reads_history_dir() {
  local found
  found=$(find "$WORKTREE/src/tools" -type f -name '*.ts' ! -name '*.test.ts' 2>/dev/null \
    | xargs grep -liE '\.rigor/history|history/|history_dir|historyDir|historyPath|history_path' 2>/dev/null \
    | head -1) || true

  if [[ -n "$found" ]]; then
    echo 1
  else
    echo 0
  fi
}

check_edge_case_handling() {
  local history_files
  history_files=$(find "$WORKTREE/src/tools" -type f -name '*.ts' ! -name '*.test.ts' 2>/dev/null \
    | xargs grep -li 'history' 2>/dev/null) || true

  if [[ -z "$history_files" ]]; then
    echo 0
    return
  fi

  if echo "$history_files" | xargs grep -lqE 'existsSync|mkdirSync|readdirSync|if\s*\(\s*!' 2>/dev/null; then
    echo 1
  else
    echo 0
  fi
}

# ---------------------------------------------------------------------------
# Run all checks
# ---------------------------------------------------------------------------

builds=$(check_builds)
test_file_exists=$(check_test_file_exists)
tests_pass=$(check_tests_pass)
coverage_above_85=$(check_coverage_above_85)
lint_clean=$(check_lint_clean)
tool_registers=$(check_tool_registers)
handler_follows_pattern=$(check_handler_follows_pattern)
tests_follow_pattern=$(check_tests_follow_pattern)
reads_history_dir=$(check_reads_history_dir)
edge_case_handling=$(check_edge_case_handling)

total=$(( builds + test_file_exists + tests_pass + coverage_above_85 + lint_clean \
  + tool_registers + handler_follows_pattern + tests_follow_pattern \
  + reads_history_dir + edge_case_handling ))

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ---------------------------------------------------------------------------
# Output JSON
# ---------------------------------------------------------------------------

json=$(cat <<EOF
{
  "model": "$MODEL",
  "condition": "$CONDITION",
  "checks": {
    "builds": $builds,
    "test_file_exists": $test_file_exists,
    "tests_pass": $tests_pass,
    "coverage_above_85": $coverage_above_85,
    "lint_clean": $lint_clean,
    "tool_registers": $tool_registers,
    "handler_follows_pattern": $handler_follows_pattern,
    "tests_follow_pattern": $tests_follow_pattern,
    "reads_history_dir": $reads_history_dir,
    "edge_case_handling": $edge_case_handling
  },
  "total": $total,
  "max": 10,
  "timestamp": "$timestamp"
}
EOF
)

if [[ -n "$OUTPUT" ]]; then
  echo "$json" > "$OUTPUT"
else
  echo "$json"
fi
