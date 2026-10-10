# ZenMind Desktop Project Conventions

## Design Docs First

- Treat `docs/` as the source for architecture, direction, module boundaries, major flows, and long-lived invariants. It is not an exhaustive description of current implementation details.
- Before changing code, read `README.md` section `6. 专题文档索引`, then `docs/README.md`, and then the topic documents that match the task.
- Start with `docs/架构与模块边界.md` whenever a change crosses Electron main/preload/renderer, built-in services, plugins, webviews, or shared contracts.
- For startup, recovery, built-in services, resources, packaging, or uninstall flows, read `docs/启动初始化与恢复.md`, `docs/服务生命周期.md`, `docs/内置资源与Manifest.md`, and `docs/版本化打包与卸载.md` as applicable.
- For frontend embedding, navigation, authentication, SSO, token bridges, desktop protocols, or action dispatch, read `docs/前端嵌入与导航.md`, `docs/鉴权SSO与TokenBridge.md`, and `docs/桌面协议与动作桥.md` as applicable.
- For plugins, market resources, external websites, local web apps, pets, data layout, Kanban sync, or assistant integration, read the matching topic docs under `docs/` before editing the related modules.
- Read exact interfaces, fields, defaults, paths, commands, and runtime behavior from `src/`, `src/shared/`, generated `contracts/`, and tests instead of copying them into design docs.
- Use `qa/manual-regression.md` as the manual regression checklist for user-visible workflow changes.
- Update a design doc in the same change when architecture, ownership, security boundaries, state machines, or cross-module invariants change. Field-level and implementation-only changes belong in source, contracts, tests, or QA.
- If code must intentionally diverge from an existing design decision, update the doc in the same change or call out the mismatch explicitly.

## Platform Compatibility

- Whenever a feature, path, script, runtime behavior, packaging flow, or UI interaction may differ between platforms, handle it explicitly with platform branches such as `if (isWindows) { ... }` and `if (isMac) { ... }`.
- Do not rely on implicit behavior, shared fallbacks, or a single code path when Windows and macOS have different requirements.
- Prefer clear platform checks close to the logic being handled so future changes stay readable and safe.
- For filesystem and user-directory logic, prefer Electron-provided paths such as `app.getPath("home")` and `app.getPath("desktop")` instead of hard-coded assumptions.
- When adding compatibility code, verify both the Windows path and the macOS path, even if only one platform is currently being debugged.

## Implementation Style

- 2026-10-05 过度设计纠错记录：用户要求助理导入参照已有皮肤交互，Codex 却额外增加了文件夹导入按钮、IPC、目录递归读取与对应测试，这是错误扩大需求。已要求删除整条文件夹导入流程。以后“参照现有功能”必须先对齐其实际交互和能力范围；助理仅保留单个 ZIP 的导入按钮与拖拽入口，不擅自增加目录扫描、批量导入或额外选项。
- 同次视觉纠错：Codex 又把拖拽提示做成大面积区域，仍未对齐皮肤。参照皮肤时应沿用紧凑按钮和小型虚线提示区的尺寸、间距、字体与主题变量，不擅自扩大为整行上传面板。

- For compatibility-sensitive code, clarity is more important than clever abstraction.
- If platform behavior is intentionally different, keep the branching explicit in code and explain the reason briefly in comments when it is not obvious.

## Built-in Service Boundary

- Desktop owns service lifecycle orchestration only: install/extract bundles, call each service's `deploy.sh`, `start.sh`, and `stop.sh`, pass documented lifecycle/layout arguments, validate bundle contracts, and read service status.
- Desktop must not repair, migrate, normalize, preserve, or synthesize `.env` or service-owned config for the built-in services `agent-container-hub`, `agent-platform`, `agent-webclient`, and `identity-center`.
- Service-owned defaults, stale env cleanup, config migrations, runtime directory setup, public-key placement, URL/port env sync, and Docker/local-development env cleanup belong in that service's own `deploy.sh` or bundle build process.
- `start.sh` should consume already-deployed config plus start-time lifecycle flags. Do not add Desktop-side compatibility shims for old service env keys or launcher arguments.

## Kanban Issue Protocol

- Treat cloud Kanban issue content and workflow state as a Server-authoritative read-only cache in Desktop UI/runtime surfaces. Contract 1.0 Desktop may call only the restricted atomic `issue.claim`, `issue.run.prepare`, `issue.chat.bind/unbind`, and `run.event.append` operations.
- Do not call removed public issue endpoints such as `issue.transition`, `issue.assignRun`, `issue.dispatchDesktop`, `issue.label.set`, `issue.dependency.*`, `issueLabel.*`, `review.*`, or `review.comment.*`.
- Keep `run.event.append` as the Desktop runtime synchronization protocol for run state and exact `issueRunId + deviceId + externalRunId` identity; it is not public issue CRUD. Desktop manual runs must use normal Agent Platform query and the Server-prepared run identity.
- Do not add `issue.claimAndRun` or call Website's `issue.run.request` from Desktop.

Platform TEAM 是普通 Agent mode，Desktop 请求、会话控制和 WebClient bridge 只使用根 agentKey；成员事件携带实际执行者身份，但不改变 Run owner。独立 Team 列表与旧身份字段已删除，需和 Platform、WebClient 同批发布。Kanban 组织团队标识不属于此协议。
