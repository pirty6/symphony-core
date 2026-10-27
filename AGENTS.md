# symphony-core agent notes

## What this is
Deterministic, auditable AI orchestration. A state machine owns order, gates
and validation. AI runs only inside nodes (assessor = read-only, executor =
read-write). Algorithms live in a library of Patterns written in TypeScript.
Flow: Pattern -> compileScore -> ExecutableScore -> performScore or
createEngine+advance -> Performance (JSON audit record).

## Rules
- Score is the read-only plan; Performance is what happened. Never mutate a Score at runtime.
- advance(state, resolution) is pure: no I/O inside the state machine.
- Validate every AI response shape (MoveVerdict) before it advances state.
- Never repeat the same (moveType, targetSite, stateHash).
- Patterns are TypeScript only, no markdown definitions.

## Working style
- Small steps: at most 3 files per change. Run tests and lint after each step. Commit per step.
- Context is limited (~40k tokens): read files in parts, don't dump whole files.
- Check package.json for the real scripts before running anything.
