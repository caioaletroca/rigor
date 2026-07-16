# Industry Landscape

How Rigor relates to existing tools and approaches (as of July 2026).

## Comparison Matrix

| Dimension | Ring | Impeccable | LangGraph | Traditional CI | **Rigor** |
|---|---|---|---|---|---|
| **Enforcement** | Prompt-based | Deterministic rules + AI | Code graph | Deterministic | Deterministic + AI |
| **Can LLM skip gates?** | Yes | No (for rules) | No | N/A | No |
| **Scope** | Full dev lifecycle | Design quality | General agents | Build/test/deploy | Full dev lifecycle |
| **Runs inside assistant?** | Yes | Yes (skills) | No (separate runtime) | No (CI server) | Yes (MCP server) |
| **State machine** | JSON via prompts | Stateless | Code-defined graph | Pipeline YAML | Code-defined, persisted |
| **Multi-provider** | Per-provider SKILL.md | Build transforms | N/A | N/A | MCP (universal) |
| **Infrastructure** | None | CLI + optional | Python runtime | CI server | MCP server process |
| **Auditable** | No | Partial (CLI output) | Yes | Yes | Yes (evidence files) |

## Detailed Comparisons

### vs. Ring (LerianStudio/ring)

Ring is the most ambitious system in this space — a full dev-cycle orchestrator
with TDD enforcement, parallel code review, rolling-wave planning, and
acceptance validation. Rigor learns from Ring's design:

**What Rigor keeps from Ring:**
- Gate-based dev-cycle structure (Gate 0, 8, 9 + phase boundaries)
- Parallel reviewer dispatch pattern
- Rolling-wave phase elaboration
- State persistence and cycle resume

**What Rigor changes:**
- Gate enforcement moves from prompts to deterministic code
- State machine transitions are code, not prompt instructions
- Verification (coverage, lint, tests) runs as real commands with exit codes
- AI is reserved for judgment work, not orchestration or verification

### vs. Impeccable (pbakaus/impeccable)

Impeccable proved the hybrid model works. 46 deterministic rules catch
objective design anti-patterns; 23 AI commands handle subjective judgment.
GitHub embedded it into Copilot. 40k+ stars.

**What Rigor learns from Impeccable:**
- The "if you can write an if-statement, don't ask an LLM" principle
- Deterministic checks as real functions, not prompts
- Multi-provider distribution from a single source
- CLI-first with AI-skill integration on top

**Where Rigor differs:**
- Scope: full dev lifecycle vs. design quality only
- Stateful: Rigor manages a cycle state machine; Impeccable is stateless
- Orchestration: Rigor coordinates multi-agent workflows; Impeccable is
  single-agent with commands

### vs. LangGraph / Agent Frameworks

LangGraph, CrewAI, Microsoft Agent Framework, and Google ADK are code-first
SDKs for building agent applications. You write Python/TypeScript to define
agent graphs.

**Why Rigor isn't built on these:**
- They require a separate runtime (Python process, Node server)
- They don't run inside coding assistants
- They solve "build an AI app" not "make my coding assistant rigorous"
- Over-engineered for what is essentially: state machine + shell commands + MCP

### vs. Traditional CI (GitHub Actions, Jenkins)

CI pipelines are deterministic and battle-tested but:
- Run after push, not during development
- Can't do AI-powered review or judgment
- No concept of development phases or task-level gates
- No in-session feedback loop

Rigor can emit CI-compatible artifacts so gate evidence integrates with
existing pipelines, but the primary enforcement happens during development.

### vs. OpenAgentsControl

The closest open-source project to Rigor's vision. Plan-first development
workflows with approval-based execution for OpenCode. But much simpler —
no deterministic verification layer, no multi-gate pipeline, no evidence
artifacts.

## Key Industry Trends (2026)

1. **Context engineering > prompt engineering** — managing what the agent
   knows at each step, not just writing good prompts
2. **SKILL.md as universal format** — works across Claude Code, Cursor,
   Gemini CLI, Codex CLI, OpenCode
3. **MCP as the integration layer** — standard protocol for tool servers
   across all major coding assistants
4. **Independent quality gates** — growing recognition that AI-generated
   code needs automated quality checkpoints (Codacy, Axiom Studio)
5. **Hybrid architectures** — deterministic verification + AI judgment
   emerging as the pattern that works

## References

- [Ring - LerianStudio](https://github.com/LerianStudio/ring)
- [Impeccable - pbakaus](https://github.com/pbakaus/impeccable)
- [OpenAgentsControl](https://github.com/darrenhinde/OpenAgentsControl)
- [Why Coding Agents Need Independent Quality Gates](https://blog.codacy.com/why-coding-agents-need-independent-quality-gates)
- [AI Code Quality Gates: Automated Review Pipeline](https://axiomstudio.ai/blog/quality-gates-for-ai-generated-code-automated-review-and-compliance)
- [LangGraph](https://www.langchain.com/resources/ai-agent-frameworks)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)
