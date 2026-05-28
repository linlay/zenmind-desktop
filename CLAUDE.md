# CLAUDE.md

Project instructions for AI coding agents working in `zenmind-desktop`.

## 1. Work Style

Behavioral guidelines to reduce common LLM coding mistakes. Bias toward cautious, surgical, verified work.

### Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions when they affect implementation.
- If multiple interpretations exist, present them instead of picking silently.
- If a simpler approach exists, say so.
- If something is unclear and cannot be discovered from the repo, ask.

### Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that was not requested.
- No error handling for impossible scenarios.
- If a change can be much smaller without losing behavior, make it smaller.

### Surgical Changes

Touch only what is required.

- Do not improve adjacent code, comments, or formatting unless needed.
- Do not refactor unrelated code.
- Match existing style, even when another style is tempting.
- Remove imports, variables, and functions only when your own changes made them unused.
- Mention unrelated dead code instead of deleting it.

Every changed line should trace directly to the user's request.

### Goal-Driven Execution

Turn work into verifiable goals.

```text
1. Change behavior -> verify with targeted test or inspection.
2. Update contracts/docs -> verify references and build/static checks.
3. Finish -> summarize changed files and verification.
```

## 2. Project Overview

`zenmind-desktop` is an Electron desktop control shell for bundled services and runtime plugins.

Desktop is responsible for:

- Discovering builtin services.
- Loading installed plugins.
- Installing service and plugin bundles.
- Writing default configuration.
- Running start, stop, deploy, and verification scripts.
- Exposing service state and control APIs to the renderer.

Service sources:

- `builtin`: bundled with the app. Current builtin services include `agent-container-hub`, `agent-platform`, `agent-webclient`, and `zenmind-app-server`.
- `plugin`: imported at runtime from `.tar.gz` archives. Desktop no longer bundles plugins in the installer.

Frontend modes:

- `none`: service appears only in Control Center.
- `embedded`: frontend can open inside the service detail page.
- `standalone`: frontend can open and appears in navigation while running.

## 3. Architecture

Electron uses these layers:

- `src/main`: windows, IPC, plugin loading, service lifecycle, auth, filesystem integration.
- `src/preload`: `contextBridge` layer that exposes a controlled desktop API.
- `src/renderer`: React shell, Control Center, settings, navigation, service/plugin webviews.
- `src/shared`: contracts, manifest types, auth bridge helpers, shared UI/runtime types.

Core flow:

- Renderer calls `window.electronAPI.*`.
- Preload bridges calls to `ipcRenderer.invoke(...)`.
- Main process registers `ipcMain.handle(...)` in `src/main/index.ts`.
- Service and plugin work is delegated to manager/loader modules.
- Webviews access service `healthMeta.webUrl` directly; Desktop no longer proxies all frontend assets.

Important modules include `services/manager`, `plugin-loader`, `plugin-uninstall`, `builtin-loader`, `service-registry`, `manifest-utils`, `auth-bridge`, `agent-auth`, `app-server-auth`, and `pan-auth`.

## 4. Repository Map

- `src/main/index.ts`: app lifecycle, window creation, IPC handlers, menu/tray hooks, shortcuts.
- `src/main/user-paths.ts`: platform-aware data, config, state, logs, cache, secrets, and profile roots.
- `src/main/navigation/custom-sidebar-store.ts`: embedded website configuration storage.
- `src/main/task-board-db.ts`: task board SQLite storage path and schema.
- `src/preload`: renderer-facing Desktop API and service webview bridges.
- `src/renderer/app-shell`: main shell, navigation, mounted embedded surfaces.
- `src/renderer/pages`: Control Center, settings, plugin pages, external webview, task board, help.
- `src/shared/contracts`: shared API and data contracts.
- `docs`: plugin development, data directory layout, and AI mistake notes.
- `test`: Node tests for service management, loader behavior, contracts, renderer constraints, and docs.

## 5. Data Directories

Desktop runtime data lives under a layered data root:

- macOS: `~/.zenmind/.desktop/`
- Windows: `%USERPROFILE%\.zenmind\.desktop\`

Layers:

- `config/`: desktop, service, plugin, and marketplace configuration.
- `data/`: persistent service and plugin runtime data.
- `state/`: pid files, initialization state, startup restore state, SSO session state.
- `logs/`: service and plugin logs.
- `cache/`: rebuildable cache, currently including marketplace cache.
- `secrets/`: local credentials and private keys.
- `profiles/`: Electron/Chromium profile data.

Embedded website entries are stored in `config/desktop/custom-sidebar-items.json`.

Electron cookies, localStorage, webview session data, and browser cache are stored under `profiles/electron/`.

Full details: `docs/data-directories.md`.

Program bundles do not live in the desktop data root. They live under:

- macOS: `~/Library/Application Support/ZenMind/`
- Windows: `%APPDATA%\ZenMind\`

## 6. Platform Compatibility

When behavior differs by platform, branch explicitly near the logic.

- Use `if (isWindows) { ... }` and `if (isMac) { ... }` style checks when paths, scripts, runtimes, packaging, or UI interactions differ.
- Do not rely on implicit shared fallback behavior when Windows and macOS have different requirements.
- Prefer Electron paths such as `app.getPath("home")`, `app.getPath("desktop")`, `app.getPath("appData")`, and `app.getPath("userData")`.
- For filesystem behavior, verify both the Windows path and the macOS path, even if debugging only one platform.
- Clarity is more important than clever abstraction for compatibility-sensitive code.

## 7. Shared Contracts

Core shared structures live in `src/shared/contracts`:

- `ServiceId`: dynamic string ID shared by builtin services and plugins.
- `ServiceKind`: `builtin` or `plugin`.
- `FrontendMode`: `none`, `embedded`, or `standalone`.
- `ServiceStatus`: install, configuration, dependency, running, stopped, and error states.
- `ServiceState`: renderer-facing service card state.
- `Manifest`: common service/plugin manifest shape.
- `ManifestCommand`: command string or command array.
- `DesktopApi`: full preload API exposed to the renderer.

Keep main, preload, renderer, and shared contracts in sync when changing APIs.

## 8. Service And Plugin Behavior

- Builtin resources are read from `process.resourcesPath/services` in production and `build/resources/services` in development.
- Development assets must be synced with `npm run sync:assets` before tests that depend on builtin bundles.
- Service initialization may copy template config to `.env`, repair script permissions, and run `scripts.deploy`.
- Desktop stops services it started during the session in `before-quit`.
- `agent-platform` startup injects Container Hub address, `SERVER_PORT`, `AGENT_AUTH_ENABLED=true`, and the local RSA public key path.
- `ManifestCommand` supports both `string` and `string[]`.
- `.ps1` scripts run through `powershell` on Windows and `pwsh` elsewhere.
- Plugins must include `manifest.json`; optional frontend assets depend on `frontend.mode`.
- Runtime plugin installs are scanned from Application Support on app launch.

## 9. Webviews And Renderer Rules

- Service and plugin webviews load the service's own web URL directly.
- `agent-webclient` and `pan-webclient` use the shared postMessage Token Bridge.
- Token bridge messages include `requestId`; Desktop replies with the matching token response.
- Preload changes require restarting the Electron process; page refresh alone is not enough.
- Keep `HashRouter`; it avoids route issues under Electron file protocol.
- Navigation includes fixed Control Center, plugin market, help, assistants, and embedded website groups.
- Running services with `frontendMode === "standalone"` may appear as navigation entries.
- Custom embedded websites are managed through the `customSidebar` API and rendered with `ExternalWebviewPage`.

## 10. Development And Packaging

- Key commands: `npm run dev`, `npm run sync:assets`, `npm run build`, `npm test`, `npm run dist:mac`, `npm run dist:win`.
- Current distribution targets are mainly macOS arm64 and Windows x64.
- Builtin service resources depend on external packaged artifacts; missing bundles can break install and tests.
- `agent-container-hub` depends on local Docker or Podman availability.
- `agent-container-hub` bundles use binary `backend/agent-container-hub`, pid/logs in `run/`, and root `manifest.json`.
- `agent-platform` and `zenmind-app-server` still follow their existing program bundle conventions.
- `pan-webclient` is imported through the plugin system; it is not bundled in Desktop.

## 11. Known Sensitive Areas

- User path logic in `src/main/user-paths.ts` must stay platform-explicit.
- Service lifecycle changes can affect startup restore, shutdown cleanup, logs, and pid handling.
- Auth bridge changes can affect both Desktop and embedded web clients.
- Manifest compatibility changes can affect builtin services and runtime plugins.
- Renderer API changes require updating preload and shared `DesktopApi` contracts together.
- Desktop pet and assistant settings share the desktop config root, so avoid filename collisions.

## 12. AI Behavior Red Lines

Unless the user clearly asks for implementation, output only plans and solution text.

- User asks "give a solution", "output a plan", or "analyze" -> do not edit files.
- User asks "implement", "modify", "apply changes", or "change code" -> perform the requested edits.
- If intent is unclear, ask whether they want a plan or direct implementation.
- This prevents wasted tokens and accidental code churn.
