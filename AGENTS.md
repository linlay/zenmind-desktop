# ZenMind Desktop Project Conventions

## Design Docs First

- Treat `docs/` as the design-plan source for Desktop behavior. Before changing code, read `README.md` section `6. 专题文档索引`, then open the `docs/` topic documents that match the task.
- Start with `docs/架构与模块边界.md` whenever a change crosses Electron main/preload/renderer, built-in services, plugins, webviews, or shared contracts.
- For startup, recovery, built-in services, resources, packaging, or uninstall flows, read `docs/启动初始化与恢复.md`, `docs/服务生命周期.md`, `docs/内置资源与Manifest.md`, and `docs/版本化打包与卸载.md` as applicable.
- For frontend embedding, navigation, authentication, SSO, token bridges, desktop protocols, or action dispatch, read `docs/前端嵌入与导航.md`, `docs/鉴权SSO与TokenBridge.md`, and `docs/桌面协议与动作桥.md` as applicable.
- For plugins, market resources, external websites, local web apps, pets, data layout, Kanban sync, or assistant integration, read the matching topic docs under `docs/` before editing the related modules.
- Use `docs/手工测试用例.md` as the manual regression checklist for user-visible workflow changes.
- Treat migration stubs such as `docs/plugin-development.md`, `docs/data-directories.md`, and `docs/bootstrap-startup-order.md` as pointers only; follow them to the current Chinese topic documents.
- If code must intentionally diverge from a design doc, update the doc in the same change or call out the mismatch explicitly.

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

- Treat cloud Kanban issue content and workflow state as a Server-authoritative read-only cache in Desktop UI/runtime surfaces. Contract 3.2 Desktop may call only the restricted atomic `issue.claim` mutation.
- Do not call removed public issue endpoints such as `issue.transition`, `issue.assignRun`, `issue.dispatchDesktop`, `issue.label.set`, `issue.dependency.*`, `issueLabel.*`, `review.*`, or `review.comment.*`.
- Keep `run.event.append` as the Desktop runtime synchronization protocol for run state, `chatId`, and `runId`; it is not public issue CRUD. Desktop manual runs must use normal Agent Platform query first and report `source: desktop_manual` with an exact stable `runId`.
- Do not add `issue.claimAndRun` or call Website's `issue.run.request` from Desktop.
