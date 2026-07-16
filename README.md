# Rigor

Hybrid dev-cycle orchestrator that blends deterministic quality gates with AI
agent skills. The gate server enforces checkpoints as real code; AI agents do
the creative work inside each gate.

**Status:** Design phase — see `docs/` for the full rationale and architecture.

## Docs

| Document | What it covers |
|---|---|
| [Why Rigor](docs/why-rigor.md) | The problem, prior art, and where Rigor fits |
| [Architecture](docs/architecture.md) | Two-layer design, MCP server, responsibilities |
| [Gates](docs/gates.md) | Gate catalog, entry/exit criteria, custom gates |
| [Hybrid Approach](docs/hybrid-approach.md) | Core principle, why pure-prompt and pure-code fail, the blend |
| [Landscape](docs/landscape.md) | Comparison with Ring, Impeccable, LangGraph, CI, and industry trends |

## Core Idea

```
if you can write an `if` statement for it, don't ask an LLM
```

Deterministic code handles verification (tests pass? coverage met? lint clean?).
AI handles judgment (is the architecture sound? are there logic bugs?).
Neither layer alone is sufficient.
