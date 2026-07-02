# ZenMind Desktop Project Conventions

## Platform Compatibility

- Whenever a feature, path, script, runtime behavior, packaging flow, or UI interaction may differ between platforms, handle it explicitly with platform branches such as `if (isWindows) { ... }` and `if (isMac) { ... }`.
- Do not rely on implicit behavior, shared fallbacks, or a single code path when Windows and macOS have different requirements.
- Prefer clear platform checks close to the logic being handled so future changes stay readable and safe.
- For filesystem and user-directory logic, prefer Electron-provided paths such as `app.getPath("home")` and `app.getPath("desktop")` instead of hard-coded assumptions.
- When adding compatibility code, verify both the Windows path and the macOS path, even if only one platform is currently being debugged.

## Implementation Style

- For compatibility-sensitive code, clarity is more important than clever abstraction.
- If platform behavior is intentionally different, keep the branching explicit in code and explain the reason briefly in comments when it is not obvious.

## Built-in Service Boundary

- Desktop owns service lifecycle orchestration only: install/extract bundles, call each service's `deploy.sh`, `start.sh`, and `stop.sh`, pass documented lifecycle/layout arguments, validate bundle contracts, and read service status.
- Desktop must not repair, migrate, normalize, preserve, or synthesize `.env` or service-owned config for the built-in services `agent-container-hub`, `agent-platform`, `agent-webclient`, and `identity-center`.
- Service-owned defaults, stale env cleanup, config migrations, runtime directory setup, public-key placement, URL/port env sync, and Docker/local-development env cleanup belong in that service's own `deploy.sh` or bundle build process.
- `start.sh` should consume already-deployed config plus start-time lifecycle flags. Do not add Desktop-side compatibility shims for old service env keys or launcher arguments.

## Kanban Issue Protocol

- Treat cloud Kanban issues as a read-only cache in Desktop UI/runtime surfaces.
- Do not call removed public issue endpoints such as `issue.transition`, `issue.assignRun`, `issue.dispatchDesktop`, `issue.label.set`, `issue.dependency.*`, `issueLabel.*`, `review.*`, or `review.comment.*`.
- Keep `run.event.append` as the Desktop runtime synchronization protocol for run state, `chatId`, and `runId`; it is not public issue CRUD.

<!-- xgraph:start -->
## Project Context

Before work, read `.doc/index.json`.

Follow its `readOrder` progressively. Start from the catalog paths declared by the index, then inspect related task, flow, rule, and module cards only as needed.

Keep this entry file short; use `.doc/rules/agent.md` for detailed behavior.

When an agent lifecycle hook is installed, let it run `xgraph finish`; otherwise run `xgraph sync` before finishing.

<!-- xgraph:end -->
