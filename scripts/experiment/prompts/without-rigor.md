# Task: Implement the `cycle_history` MCP Tool

You are implementing a new MCP tool for the Rigor project. The tool is called `cycle_history` and it lists completed development cycles. The full specification follows below. Read it carefully, then implement the feature, write tests, and make sure everything passes.

---

## Feature Spec: `cycle_history` MCP Tool

### Purpose

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

#### `src/tools/cycle.ts` - Tool registration pattern

The tool module exports a `registerXTools(server, ...)` function that calls `server.tool()` for each tool. Parameters are validated with Zod schemas passed inline. Handler functions are exported separately so they can be tested without MCP transport. Use the `textResult` helper to wrap responses in the `CallToolResult` shape.

#### `src/tools/__tests__/cycle.test.ts` - Test pattern

Tests use vitest with `describe`/`it` blocks. Each suite creates an isolated temp directory via `mkdtempSync` in `beforeEach` and cleans it up with `rmSync` in `afterEach`. Handler functions are imported and called directly, never through MCP transport. A local `extractText` helper pulls the text string from the `CallToolResult` content array.

#### `src/state/schema.ts` - CycleState interface

The `CycleState` interface has the following key fields:

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

#### `src/server.ts` - Registration call site

The `createServer` function imports all `registerXTools` functions at the top of the file (lines 17-24) and calls them during server setup (lines 66-71). The new `registerHistoryTools()` call goes here, following the same pattern.

#### `src/tools/index.ts` - Export barrel

All tool modules are re-exported from `src/tools/index.ts`. The new history module must be added here, exporting at minimum `registerHistoryTools` and `handleCycleHistory`.

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

## Instructions

Implement the `cycle_history` tool following the patterns described above. Look at the existing tool files to match the code style, imports, and registration pattern exactly.

Write thorough tests in `src/tools/__tests__/history.test.ts` covering the happy path, all four edge cases, and the `limit` parameter behavior. Follow the test patterns from `cycle.test.ts`.

After implementation, verify all three of these pass:

1. **Build** - Run `npm run build` and confirm TypeScript compiles with no errors.
2. **Tests** - Run `npm test` and confirm all tests pass.
3. **Lint** - Run the lint command and confirm zero violations.

Register the tool in `src/server.ts` and export it from `src/tools/index.ts`. Do not skip any of these integration points.

Follow the existing patterns closely. Do not introduce new dependencies, new abstractions, or alternative approaches. Match the conventions already in the codebase.
