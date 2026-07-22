---
name: rigor:explore
description: >-
  Two-phase autonomous codebase exploration -- discover structure with parallel
  agents, then deep-dive each discovered area with adaptive agents. Produces a
  synthesis document with architecture, component map, execution flows, and
  implementation guidance. Read-only -- never edits files.
---

Two-phase autonomous codebase exploration: discover the codebase's natural structure first, then deep-dive each discovered area with targeted agents. Synthesize into a single document with architecture, components, flows, and actionable guidance.

**Read-only boundary:** This skill does not edit files, create artifacts on disk, or remediate issues. It explores and reports in the current session.

**Announce at start:** "Using rigor:explore to autonomously discover and explore the codebase."

---

## HARD STOP -- DEFINE TARGET BEFORE EXPLORING

Before anything else, confirm the exploration target is clear:

- **What to explore:** A feature, system, component, or "full architecture"
- **Why:** Planning changes, debugging, learning, or evaluating quality
- **Scope:** Entire codebase, specific directory, or specific concern

If the target is vague (e.g., "look at the code"), ask for clarification. Do NOT launch discovery agents without a defined target.

---

## Phase 1 -- Discovery Pass

**Goal:** Discover the natural structure of the codebase. Do not assume architecture -- let the code reveal it.

### 1.1 -- Launch Discovery Agents in Parallel

Dispatch 4 discovery agents in a SINGLE TURN. All 4 MUST go out as one atomic batch.

**Agent 1: Architecture Discovery**

```
Discover the architecture pattern(s) used in this codebase.

Task:
1. Examine directory structure at top 2-3 levels
2. Identify pattern(s): hexagonal, layered, microservices, monolith,
   clean architecture, MVC, event-driven, plugin-based, or mixed
3. Document evidence: directory names, layer separation, service boundaries
4. Note if multiple patterns coexist

Output:
- Primary pattern with evidence (directory paths, file examples)
- Confidence level (high/medium/low)
- Secondary patterns if any
- ASCII diagram of discovered architecture
```

**Agent 2: Component Discovery**

```
Identify all major components/modules/services in the codebase.

Task:
1. Enumerate components by directory and responsibility
2. For each: name, location, responsibility (one sentence), key files, size
3. Map dependencies between components (imports, shared code)
4. Identify shared libraries or common code

Output:
- Component list with locations and responsibilities
- Dependency map (ASCII showing relationships)
- Shared libraries identified
- Dependency health (clean vs tangled)
```

**Agent 3: Layer Discovery**

```
Discover layers/boundaries within components.

Task:
1. Identify layers: presentation/API, business logic, data access, infrastructure
2. Document how layers are separated (directory, naming, file organization)
3. Check for layer violations (presentation accessing DB directly, etc.)
4. Identify layer communication patterns (DI, interfaces, direct coupling)

Output:
- Layers identified with locations and responsibilities
- Layer communication pattern
- Layer diagram (ASCII)
- Layer health: clean separations and violations with file:line evidence
```

**Agent 4: Organization Discovery**

```
Understand the organizing principle of the codebase.

Task:
1. Identify organization: by layer, by feature, by domain, by component type
2. Document file naming conventions (kebab-case, snake_case, camelCase)
3. Identify test organization (co-located, separate, naming convention)
4. Note config, build setup, documentation structure

Output:
- Primary organization principle with evidence
- File naming conventions with examples
- Test organization pattern
- Configuration and build setup
```

### 1.2 -- Collect and Validate Discovery Results

Wait for ALL 4 agents to complete. Do NOT proceed with partial results.

**Quality checks:**
- Architecture pattern clearly identified with evidence
- Major components/modules enumerated with file paths
- Boundaries and layers documented
- Organization principle clear
- No major "unknown" areas remaining

If any agent returned insufficient results, re-launch that specific agent with a refined prompt. Do NOT re-launch agents that succeeded.

### 1.3 -- Determine Deep Dive Strategy

Based on discoveries, choose the Phase 2 approach:

| Discovery Result | Deep Dive Strategy |
|------------------|-------------------|
| N components with clear boundaries | Launch N agents, one per component |
| Single component with M layers | Launch M agents, one per layer |
| Microservices architecture | Launch one agent per service |
| Feature-organized monolith | Launch one agent per major feature |
| Mixed patterns | Launch one agent per unique area |

**Cap:** Maximum 8 deep dive agents. If more areas exist, group related areas.

**Exit condition:** Structural map complete. Deep dive strategy chosen. Proceed to Phase 2.

---

## Phase 2 -- Deep Dive Pass

**Goal:** Explore the target within each discovered area.

### 2.1 -- Generate Adaptive Prompts

For each discovered area, create a targeted prompt:

```
Explore [TARGET] within [DISCOVERED_AREA].

Context from discovery:
- Architecture: [pattern]
- This area: [name], handles [responsibility]
- Location: [directory paths]
- Related areas: [dependencies/connections]

Task:
1. Find how [TARGET] is implemented in this area
2. Trace execution flow with file:line references
3. Document patterns and conventions used
4. Identify integration points with other areas
5. Note data transformations and error handling

Boundaries:
- Stay within [directory scope]
- Focus on [TARGET] specifically

Output:
- Entry points (file:line)
- Execution flow (step-by-step with file:line)
- Patterns observed
- Integration points (what connects to other areas)
- Key files list
```

### 2.2 -- Dispatch Deep Dive Agents in Parallel

All deep dive agents MUST be dispatched in a SINGLE TURN. Same atomic batch rule as Phase 1.

**Pre-dispatch count check:** Count agents. Must match the number of areas from the deep dive strategy in 1.3.

### 2.3 -- Collect Deep Dive Results

Wait for ALL agents to complete. For each result:
- Check completeness (did it find the target?)
- Verify file:line references provided
- Confirm it stayed within scope
- Note gaps ("target not found in this area" is a valid finding)

**Exit condition:** All deep dive agents completed. Results collected. Proceed to synthesis.

---

## Phase 3 -- Synthesis

**Goal:** Integrate discovery + deep dive into a single actionable document.

### 3.1 -- Produce Synthesis Document

Output the following structure in the current session:

```markdown
# Codebase Exploration: [Target]

## Executive Summary
[2-3 sentences: architecture + how target works across the codebase]

---

## Architecture

### Pattern
[Primary pattern with evidence]

### Component Map
[Components with responsibilities, one line each]

### Dependency Flow
[ASCII diagram showing component relationships]

### Layer Organization
[Layers identified, communication pattern]

---

## Deep Dive Findings

### [Area 1 Name]
**Scope:** [directory]
**Entry point:** [file:line]
**Flow:** [step-by-step with file:line references]
**Patterns:** [what patterns are used]
**Integrations:** [connections to other areas]

### [Area 2 Name]
[same structure]

[... repeat for each area ...]

---

## Cross-Cutting Insights

### Consistent Patterns
[Patterns that are consistent across areas]

### Variations
[Where implementation differs and why]

### Integration Points
[How areas connect for the target]

### Key Design Decisions
[Architectural choices visible from the exploration]

---

## Assessment

### Strengths
[What the architecture does well -- with evidence]

### Concerns
[Issues found -- with severity and file:line references]

### Metrics
[LOC distribution, dependency count, test coverage, etc.]

---

## Guidance

### For Adding Functionality
- Where to add code: [component/layer with file paths]
- Patterns to follow: [pattern from file:line]

### For Modifying Functionality
- Primary files: [paths]
- Ripple effects: [what else changes]

### For Debugging
- Start investigating in: [component/layer with file:line]
- Common failure points: [from cross-cutting analysis]
```

### 3.2 -- Validate Synthesis

Before reporting, verify:
- Both Phase 1 and Phase 2 are integrated
- All discovered areas covered in deep dive
- Cross-cutting insights identified
- Assessment includes evidence (not just opinions)
- Guidance is specific (file paths, not vague directions)

**Exit condition:** Synthesis complete and validated. Report to user.

---

## Anti-Patterns (FORBIDDEN)

- Do NOT skip Phase 1 discovery -- even if you think you know the architecture. Discovery validates assumptions and finds what you missed.
- Do NOT dispatch deep dive agents before discovery completes -- Phase 2 adapts to Phase 1 findings. Without discovery, deep dives are unfocused.
- Do NOT dispatch agents sequentially -- both phases require atomic parallel dispatch in a single turn.
- Do NOT proceed with partial Phase 1 results -- all 4 discovery agents must complete.
- Do NOT provide raw agent dumps without synthesis -- Phase 3 integration is mandatory.
- Do NOT edit files or remediate issues -- this skill is read-only.
- Do NOT include vague guidance ("consider improving...") -- all guidance must reference specific file paths.
- Do NOT cap Phase 2 at fewer agents than discovered areas -- every area gets explored.

---

## Anti-Rationalization Table

| Rationalization | Why It Is WRONG | Required Action |
|-----------------|-----------------|-----------------|
| "I already know this architecture" | Prior knowledge is abstraction, not implementation detail. Assumptions cause most bugs. | **MUST run Phase 1 discovery to validate** |
| "Grep is faster for this question" | Location without context leads to follow-up questions. One exploration answers current + future questions. | **MUST use two-phase exploration** |
| "The codebase is small, I can just read it" | Small codebases still have hidden patterns, implicit dependencies, and architectural decisions worth documenting. | **MUST run discovery even for small codebases** |
| "I will explore one area at a time" | Sequential exploration doubles latency and misses cross-cutting patterns. | **MUST dispatch all agents in parallel per phase** |
| "Phase 2 found nothing in Area X, so I will skip it in the report" | "Not found in this area" is a valid finding. Absence tells you where things are NOT, which matters for implementation guidance. | **MUST include all areas in synthesis, even empty ones** |
| "The user seems impatient, I will skip synthesis" | Raw dumps without synthesis waste more user time than the synthesis step costs. | **MUST complete Phase 3 synthesis** |
