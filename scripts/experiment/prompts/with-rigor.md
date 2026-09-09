# Task: Implement `cycle_history` MCP Tool

You are implementing a feature in the Rigor codebase. Rigor has a gate enforcement system that will automatically verify your work (tests pass, coverage meets threshold, lint is clean) before marking tasks complete. You will drive implementation through this system.

## Feature Specification

Add a new MCP tool called `cycle_history` that lists completed development cycles from the `.rigor/history/` directory. Each completed cycle is saved as a JSON file in that directory. The JSON files have the same shape as the `CycleState` interface defined in the codebase.

### Parameters

- `limit` (optional number) - Maximum number of cycles to return. When omitted or 0, return all cycles. Negative values are treated as "return all". Results are sorted by most recent first (`updated_at` descending).

### Return Format

Return a JSON array of cycle summary objects. Each object contains:

```
{
  "cycle_id": string,
  "plan_path": string,
  "started_at": string,       // the created_at from CycleState
  "completed_at": string,     // the updated_at from CycleState
  "phase_count": number,
  "task_count": number,       // total tasks across all phases and epics
  "passed": number,           // tasks with status "done"
  "failed": number            // tasks with status "failed"
}
```

### Codebase Patterns to Follow

All new code must follow the existing conventions visible in these files:

**`src/tools/cycle.ts` - Tool registration pattern.** The tool module exports a `registerXTools(server, ...)` function that calls `server.tool()` for each tool. Parameters are validated with Zod schemas passed inline. Handler functions are exported separately so they can be tested without MCP transport. Use the `textResult` helper to wrap responses in the `CallToolResult` shape.

**`src/tools/__tests__/cycle.test.ts` - Test pattern.** Tests use vitest with `describe`/`it` blocks. Each suite creates an isolated temp directory via `mkdtempSync` in `beforeEach` and cleans it up with `rmSync` in `afterEach`. Handler functions are imported and called directly, never through MCP transport. A local `extractText` helper pulls the text string from the `CallToolResult` content array.

**`src/state/schema.ts` - CycleState interface.** The `CycleState` interface has the following key fields:

```
CycleState {
  cycle_id: string
  plan_path: string
  current_phase: number
  created_at: string
  updated_at: string
  phases: PhaseState[]
}
```

Each `PhaseState` has an `epics: EpicState[]` array. Each `EpicState` has a `tasks: TaskState[]` array. Each `TaskState` has a `status` field of type `Status` (one of `"pending"`, `"doing"`, `"done"`, `"failed"`, `"skipped"`).

**`src/server.ts` - Registration call site.** The `createServer` function imports all `registerXTools` functions at the top of the file (lines 17-24) and calls them during server setup (lines 66-71). The new `registerHistoryTools()` call goes here, following the same pattern.

**`src/tools/index.ts` - Export barrel.** All tool modules are re-exported from `src/tools/index.ts`. The new history module must be added here, exporting at minimum `registerHistoryTools` and `handleCycleHistory`.

### File Naming

- Tool implementation: `src/tools/history.ts`
- Test file: `src/tools/__tests__/history.test.ts`

### Edge Cases

The implementation must handle all four of these:

1. **Empty `.rigor/history/` directory** - Return an empty JSON array.
2. **Missing `.rigor/history/` directory** - Return an empty JSON array. Do not throw an error.
3. **Malformed JSON files** - Skip any file that fails to parse. Do not crash or propagate the error.
4. **`limit` parameter values** - 0 or omitted means return all cycles. Negative values are treated as "return all".

---

## How to Work: Rigor's Gate System

You have access to three MCP tools that manage your development cycle. Use them in this order:

### Step 1: Initialize the cycle

Call `cycle_init` with the plan path:

```
cycle_init({ plan_path: "scripts/experiment/prompts/plan.md" })
```

This loads the plan, creates the task list, and sets up gate tracking. Read the output to see the phases, epics, and tasks you need to implement.

### Step 2: For each task, use start and complete

Before beginning any task, call `task_start` with the task ID:

```
task_start({ task_id: "1.1.1" })
```

This marks the task as in-progress and confirms you can begin.

After finishing the task's implementation, call `task_complete`:

```
task_complete({ task_id: "1.1.1" })
```

This triggers Gate 0, which automatically runs tests, checks coverage, and runs lint. If any check fails, you will get a detailed error message. Fix the issues and call `task_complete` again. Do not move to the next task until the current one passes.

### Step 3: Work through all tasks in order

Follow the plan's task sequence. Do not skip tasks or work out of order. Each task builds on the previous one.

## Important

- The plan at `scripts/experiment/prompts/plan.md` defines the tasks. Follow it.
- Gates enforce quality automatically. You do not need to run tests or lint manually, but the gate will reject incomplete work.
- Write tests before or alongside implementation code, not after.
- If `task_complete` fails, read the error carefully, fix the problem, and retry.
