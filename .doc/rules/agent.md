# Desktop Agent Rules

## Context Loading

- Start every task from `.doc/index.json`.
- Read the `always` files from `readOrder` before editing.
- Choose the closest task card from `.doc/catalog/tasks.json` when the work maps to an implementation, documentation, protocol, or agent-rule change.
- Inspect module cards only for files that the task may touch. Do not replace progressive context loading with whole-repository scanning.

## Documentation Work

- Keep `AGENTS.md` short and route detailed behavior through this file and the `.doc` cards.
- Keep `README.md` as a project overview, quick-start entry, and topic index.
- Long-lived Desktop behavior belongs in `docs/` topic files. Historical reports and TDD notes can remain outside the main topic index.
- Do not describe unimplemented capabilities as shipped behavior.

## Platform Compatibility

- When paths, scripts, runtime behavior, packaging, or UI behavior differs between platforms, branch explicitly for Windows and macOS close to the relevant logic.
- Prefer Electron paths such as `app.getPath("home")`, `app.getPath("desktop")`, and `app.getPath("appData")` for user directories.
- When adding compatibility-sensitive behavior, verify both the Windows and macOS path shapes.

## Kanban Protocol

- Treat cloud Kanban issues as a read-only cache in Desktop UI and runtime surfaces.
- Do not call removed public issue endpoints such as `issue.transition`, `issue.assignRun`, `issue.dispatchDesktop`, `issue.label.set`, `issue.dependency.*`, `issueLabel.*`, `review.*`, or `review.comment.*`.
- Keep `run.event.append` as the Desktop runtime synchronization protocol for run state, `chatId`, and `runId`; it is not public issue CRUD.
