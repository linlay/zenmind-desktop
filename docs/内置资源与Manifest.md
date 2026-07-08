# 内置资源与Manifest

## 当前状态

Desktop 内置服务使用按平台生成的资源包或目录分发。资源根目录开发态默认为 `build/resources/services`，打包态默认为 Electron `process.resourcesPath/services`，可用 `DESKTOP_BUILTIN_ASSETS_ROOT` 覆盖。

每个内置服务必须提供 `manifest.json`。Desktop 读取 manifest 后通过 `normalizeManifest()` 归一化服务定义，再注册到运行时 service registry。

## 核心流程

```text
npm run sync:assets
  -> scripts/lib/builtin-assets.mjs
  -> scan workspace or DESKTOP_BUILTIN_ASSETS_SOURCE
  -> filter manifest.kind === "builtin"
  -> filter target os / arch
  -> build/resources/services/<service-id>/<archive>
  -> build/resources/services/manifest.json

npm run dev / npm run dist:mac
  -> scripts/sync-builtin-assets.mjs --use-existing
  -> validate build/resources/services
  -> fail if the current build resources are missing or incomplete

loadBuiltinServices()
  -> read installed services under program data
  -> read bundled assets under resources/services
  -> select latest version per service id
  -> registerService()
```

平台资源格式：

- Windows：`.zip`。
- macOS / Linux：`.tar.gz` 或 `.tgz`。
- 开发态也支持包含 `manifest.json` 的目录型资源。

## 配置与接口

关键 manifest 字段：

- `id`、`name`、`kind`、`version`、`description`。
- `platform.os` / `platform.arch`：平台筛选。
- `frontend.mode`：`none`、`embedded`、`standalone`。
- `scripts.start`、`scripts.stop`、`scripts.deploy`：生命周期脚本。
- `configFiles`：`.env` 等配置模板。
- `runtime.pidRelativePath`、`runtime.logRelativePath`、`runtime.errorLogRelativePath`、`runtime.requiredPaths`。
- `web.portEnvKey`、`web.defaultPort`、`web.routePath`。
- `desktop.bundleTopLevelDir`、`desktop.envBindings`、`desktop.capabilities`、`desktop.actions`。

核心服务端口默认值由 `manifest-utils.ts` 对特定服务做 Desktop 覆写：

- `agent-container-hub`：默认 `7079`。
- `agent-platform`：默认 `7078`。
- `agent-webclient`：默认 `7080`。

## 约束与注意事项

- `sync:assets` 只同步 `manifest.json.kind === "builtin"` 的产物。
- `dev` 和 `dist:mac` 不扫描周边服务项目；它们只校验当前 `build/resources/services`。刷新内置服务资源请先运行 `scripts/build-all-dist.sh --sync-os darwin --sync-arch arm64`，或显式运行 `npm run sync:assets`。
- 新增内置服务必须保证 bundle 内的 `runtime.requiredPaths` 完整。
- macOS 内置二进制如需预签名，使用 Darwin signing 相关环境变量和 `--sign-darwin`；`--use-existing --sign-darwin` 只处理 `build/resources/services` 中已有的 Darwin 目录资源，并刷新资源 manifest 的 `assetSignature`。
- `agent-container-hub` 是 install-only startup service；核心必需资源校验当前主要覆盖 `identity-center`、`agent-platform`、`agent-webclient`。

## 相关文件

- `src/main/builtin-loader.ts`
- `src/main/manifest-utils.ts`
- `src/main/services/service-registry.ts`
- `scripts/sync-builtin-assets.mjs`
- `scripts/lib/builtin-assets.mjs`
- `test/builtin-assets.test.mjs`
- `test/electron-bundle-paths.test.mjs`
