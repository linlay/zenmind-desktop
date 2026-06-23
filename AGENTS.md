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

<!-- xgraph:start -->
## Project Context

Before work, read `.doc/index.json`.

Follow its `readOrder` progressively. Start from `.doc/catalog.json` or the catalog paths declared by the index, then inspect related module cards only as needed.

Keep this entry file short; use `.doc/rules/agent.md` for detailed behavior.

When an agent lifecycle hook is installed, let it run `xgraph finish`; otherwise run `xgraph sync` before finishing.

<!-- xgraph:end -->
