#!/usr/bin/env bash
set -euo pipefail

# run.sh - Orchestrate the quality experiment: 3 models x 2 conditions = 6 runs.
#
# Execution order respects GPU constraints (one Ollama model at a time)
# while parallelizing remote API calls where possible.

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
WORKTREES_DIR="$REPO_ROOT/worktrees"
PROMPTS_DIR="$SCRIPT_DIR/prompts"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DRY_RUN=false
TIMEOUT=1800
CLEANUP=false

# ---------------------------------------------------------------------------
# Model matrix
# ---------------------------------------------------------------------------

# Each entry: provider/model-id  short-name
declare -A MODEL_IDS=(
  [gemma4]="ollama/gemma4:e4b"
  [qwen3]="ollama/qwen3:8b"
  [deepseek]="deepseek/deepseek-chat"
)

CONDITIONS=("with-rigor" "without-rigor")

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: run.sh [OPTIONS]

Orchestrate the Rigor quality experiment (3 models x 2 conditions = 6 runs).

Options:
  --dry-run              Print what would execute without running anything
  --timeout <seconds>    Per-run timeout (default: 1800 = 30 min)
  --cleanup              Remove worktrees after scoring
  --help                 Show this help message

Models:
  gemma4      ollama/gemma4:e4b      (local, Ollama)
  qwen3       ollama/qwen3:8b        (local, Ollama)
  deepseek    deepseek/deepseek-chat  (remote API)

Execution order (GPU constraint: 1 Ollama model at a time):
  Step 1: gemma4 with-rigor                              (solo)
  Step 2: gemma4 without-rigor + deepseek with-rigor     (parallel)
  Step 3: qwen3 with-rigor                               (solo)
  Step 4: qwen3 without-rigor + deepseek without-rigor   (parallel)
USAGE
  exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    --cleanup)
      CLEANUP=true
      shift
      ;;
    *)
      echo "Error: unknown option $1" >&2
      echo "Run with --help for usage" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[$ts] $*"
}

# ---------------------------------------------------------------------------
# Preflight checks (called from main, after dry-run gate)
# ---------------------------------------------------------------------------

preflight_checks() {
  if ! command -v opencode >/dev/null 2>&1; then
    echo "Error: 'opencode' command not found. Install it and ensure it is on PATH." >&2
    exit 1
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "Error: 'git' command not found." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Worktree management
# ---------------------------------------------------------------------------

create_worktree() {
  local short_name="$1"
  local condition="$2"
  local worktree_path="$WORKTREES_DIR/${short_name}-${condition}"

  if [[ -d "$worktree_path" ]]; then
    log "Worktree already exists: $worktree_path (removing and re-creating)" >&2
    git -C "$REPO_ROOT" worktree remove --force "$worktree_path" 2>/dev/null || true
  fi

  log "Creating worktree: $worktree_path (from main)"
  git -C "$REPO_ROOT" worktree add "$worktree_path" main --detach 2>&1 | sed 's/^/  /' >&2

  # For with-rigor runs: create .rigor/ and copy config if available
  if [[ "$condition" == "with-rigor" ]]; then
    mkdir -p "$worktree_path/.rigor"
    if [[ -f "$REPO_ROOT/.rigor/config.yaml" ]]; then
      cp "$REPO_ROOT/.rigor/config.yaml" "$worktree_path/.rigor/config.yaml"
      log "Copied .rigor/config.yaml into worktree"
    else
      log "No .rigor/config.yaml found in repo root; .rigor/ directory created empty"
    fi
  fi
}

cleanup_worktree() {
  local short_name="$1"
  local condition="$2"
  local worktree_path="$WORKTREES_DIR/${short_name}-${condition}"

  if [[ -d "$worktree_path" ]]; then
    log "Removing worktree: $worktree_path"
    git -C "$REPO_ROOT" worktree remove --force "$worktree_path" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Experiment runner
# ---------------------------------------------------------------------------

run_experiment() {
  local model_id="$1"
  local short_name="$2"
  local condition="$3"

  local run_label="${short_name} ${condition}"
  local prompt_file="$PROMPTS_DIR/${condition}.md"
  local result_file="$RESULTS_DIR/${short_name}-${condition}.json"

  if [[ ! -f "$prompt_file" ]]; then
    log "ERROR: Prompt file not found: $prompt_file"
    return 1
  fi

  log "Starting $run_label..."
  local start_time
  start_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local start_epoch
  start_epoch="$(date +%s)"

  # Create worktree (path is deterministic, no need to capture output)
  local worktree_path="$WORKTREES_DIR/${short_name}-${condition}"
  create_worktree "$short_name" "$condition"

  # Run OpenCode with timeout. Pass prompt content via command substitution.
  # The $(cat ...) approach reads the file at invocation time, avoiding
  # issues with special characters in inline strings.
  log "Running opencode: model=$model_id dir=$worktree_path timeout=${TIMEOUT}s"
  local opencode_exit=0
  timeout "$TIMEOUT" opencode run \
    --model "$model_id" \
    --dir "$worktree_path" \
    --auto "$(cat "$prompt_file")" \
    || opencode_exit=$?

  if [[ "$opencode_exit" -eq 124 ]]; then
    log "WARNING: $run_label timed out after ${TIMEOUT}s (will still score partial work)"
  elif [[ "$opencode_exit" -ne 0 ]]; then
    log "WARNING: $run_label exited with code $opencode_exit"
  else
    log "$run_label completed successfully"
  fi

  # Run scorecard
  log "Scoring $run_label..."
  bash "$SCRIPT_DIR/scorecard.sh" "$worktree_path" \
    --model "$short_name" \
    --condition "$condition" \
    --output "$result_file" \
    || log "WARNING: Scorecard failed for $run_label"

  local end_time
  end_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local end_epoch
  end_epoch="$(date +%s)"
  local duration=$(( end_epoch - start_epoch ))

  log "Finished $run_label: start=$start_time end=$end_time duration=${duration}s"

  # Cleanup if requested
  if [[ "$CLEANUP" == true ]]; then
    cleanup_worktree "$short_name" "$condition"
  fi
}

# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

print_dry_run() {
  echo ""
  echo "=== DRY RUN ==="
  echo ""
  echo "Configuration:"
  echo "  Repo root:    $REPO_ROOT"
  echo "  Worktrees:    $WORKTREES_DIR"
  echo "  Results:      $RESULTS_DIR"
  echo "  Timeout:      ${TIMEOUT}s per run"
  echo "  Cleanup:      $CLEANUP"
  echo ""
  echo "Step 1 (solo):"
  echo "  gemma4 with-rigor"
  echo "    Model:     ${MODEL_IDS[gemma4]}"
  echo "    Prompt:    $PROMPTS_DIR/with-rigor.md"
  echo "    Worktree:  $WORKTREES_DIR/gemma4-with-rigor/"
  echo "    Result:    $RESULTS_DIR/gemma4-with-rigor.json"
  echo ""
  echo "Step 2 (parallel: 1 Ollama + 1 remote):"
  echo "  gemma4 without-rigor"
  echo "    Model:     ${MODEL_IDS[gemma4]}"
  echo "    Prompt:    $PROMPTS_DIR/without-rigor.md"
  echo "    Worktree:  $WORKTREES_DIR/gemma4-without-rigor/"
  echo "    Result:    $RESULTS_DIR/gemma4-without-rigor.json"
  echo "  deepseek with-rigor"
  echo "    Model:     ${MODEL_IDS[deepseek]}"
  echo "    Prompt:    $PROMPTS_DIR/with-rigor.md"
  echo "    Worktree:  $WORKTREES_DIR/deepseek-with-rigor/"
  echo "    Result:    $RESULTS_DIR/deepseek-with-rigor.json"
  echo ""
  echo "Step 3 (solo):"
  echo "  qwen3 with-rigor"
  echo "    Model:     ${MODEL_IDS[qwen3]}"
  echo "    Prompt:    $PROMPTS_DIR/with-rigor.md"
  echo "    Worktree:  $WORKTREES_DIR/qwen3-with-rigor/"
  echo "    Result:    $RESULTS_DIR/qwen3-with-rigor.json"
  echo ""
  echo "Step 4 (parallel: 1 Ollama + 1 remote):"
  echo "  qwen3 without-rigor"
  echo "    Model:     ${MODEL_IDS[qwen3]}"
  echo "    Prompt:    $PROMPTS_DIR/without-rigor.md"
  echo "    Worktree:  $WORKTREES_DIR/qwen3-without-rigor/"
  echo "    Result:    $RESULTS_DIR/qwen3-without-rigor.json"
  echo "  deepseek without-rigor"
  echo "    Model:     ${MODEL_IDS[deepseek]}"
  echo "    Prompt:    $PROMPTS_DIR/without-rigor.md"
  echo "    Worktree:  $WORKTREES_DIR/deepseek-without-rigor/"
  echo "    Result:    $RESULTS_DIR/deepseek-without-rigor.json"
  echo ""
  echo "=== END DRY RUN ==="
}

# ---------------------------------------------------------------------------
# Summary table
# ---------------------------------------------------------------------------

print_summary() {
  echo ""
  echo "=============================="
  echo "  Experiment Results Summary"
  echo "=============================="
  echo ""
  printf "%-12s %-18s %-8s %s\n" "Model" "Condition" "Score" "File"
  printf "%-12s %-18s %-8s %s\n" "-----" "---------" "-----" "----"

  for short_name in gemma4 qwen3 deepseek; do
    for condition in "${CONDITIONS[@]}"; do
      local result_file="$RESULTS_DIR/${short_name}-${condition}.json"
      local score="--"
      local status="(missing)"

      if [[ -f "$result_file" ]]; then
        score=$(grep -o '"total": [0-9]*' "$result_file" | head -1 | grep -o '[0-9]*') || score="??"
        score="${score}/10"
        status="$result_file"
      fi

      printf "%-12s %-18s %-8s %s\n" "$short_name" "$condition" "$score" "$status"
    done
  done

  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  log "Rigor Quality Experiment"
  log "Repo root: $REPO_ROOT"

  # Handle dry run
  if [[ "$DRY_RUN" == true ]]; then
    print_dry_run
    exit 0
  fi

  # Preflight: verify required commands are available
  preflight_checks

  # Create results directory
  mkdir -p "$RESULTS_DIR"

  # Step 1: gemma4 with-rigor (solo)
  log "=== Step 1/4 ==="
  run_experiment "${MODEL_IDS[gemma4]}" "gemma4" "with-rigor"

  # Step 2: gemma4 without-rigor + deepseek with-rigor (parallel)
  log "=== Step 2/4 ==="
  run_experiment "${MODEL_IDS[gemma4]}" "gemma4" "without-rigor" &
  local pid_gemma4_wr=$!
  run_experiment "${MODEL_IDS[deepseek]}" "deepseek" "with-rigor" &
  local pid_deepseek_wr=$!

  local step2_failed=false
  wait "$pid_gemma4_wr" || { log "WARNING: gemma4 without-rigor failed"; step2_failed=true; }
  wait "$pid_deepseek_wr" || { log "WARNING: deepseek with-rigor failed"; step2_failed=true; }

  if [[ "$step2_failed" == true ]]; then
    log "Step 2 had failures, continuing with remaining steps..."
  fi

  # Step 3: qwen3 with-rigor (solo)
  log "=== Step 3/4 ==="
  run_experiment "${MODEL_IDS[qwen3]}" "qwen3" "with-rigor"

  # Step 4: qwen3 without-rigor + deepseek without-rigor (parallel)
  log "=== Step 4/4 ==="
  run_experiment "${MODEL_IDS[qwen3]}" "qwen3" "without-rigor" &
  local pid_qwen3_wor=$!
  run_experiment "${MODEL_IDS[deepseek]}" "deepseek" "without-rigor" &
  local pid_deepseek_wor=$!

  local step4_failed=false
  wait "$pid_qwen3_wor" || { log "WARNING: qwen3 without-rigor failed"; step4_failed=true; }
  wait "$pid_deepseek_wor" || { log "WARNING: deepseek without-rigor failed"; step4_failed=true; }

  if [[ "$step4_failed" == true ]]; then
    log "Step 4 had failures"
  fi

  # Summary
  log "All steps complete"
  print_summary
}

main
