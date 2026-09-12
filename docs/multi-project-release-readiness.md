# Release compatibility and performance budgets

## Compatibility

- Node.js 20 or newer is required.
- OpenCode, Claude, and Hermes-style MCP clients must use the standard tool names and MCP request envelopes exercised by `transport.integration.test.ts`.
- Legacy lifecycle calls without an explicit project root remain supported when the server has a configured root.
- Relative plan paths resolve within the selected canonical project root; invalid or ambiguous roots fail closed.

## Concurrency and isolation

- A single server process must support at least three simultaneous project roots and client sessions.
- Lifecycle, gate, status, recovery, config, state, and evidence operations must not read or write another project's `.rigor` directory.
- Concurrent operations for independent projects must preserve each project's task status and response project identity.
- Release validation must include OpenCode, Claude, and Hermes-style sessions running initialization, status, task, and recovery operations concurrently.

## Performance budgets

- The representative three-project transport flow must complete in under 5 seconds on the release test runner.
- Initialization, status, and recovery operations must complete without unbounded subprocess output or request hangs.
- Performance tests measure elapsed wall-clock time around the full concurrent flow and fail when the budget is exceeded.

## Release checks

Run these checks from a clean checkout before release:

```text
npm run build
npm test
```

The final acceptance suite must include `src/tools/__tests__/transport.integration.test.ts` and verify client compatibility, concurrent multi-project isolation, recovery, and the performance budget. A release is blocked by build or test failures, cross-project response content, state/evidence collisions, unsupported client request envelopes, or budget regressions.
