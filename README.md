# ZenMind

## 1. 项目简介
`zenmind-desktop` 是 ZenMind 的应用壳项目，基于 Electron、React 和 Vite 构建。它负责把内置服务打包进桌面应用，并提供统一的安装、配置、启动、停止、重启和日志查看入口。

当前 Desktop 已统一切换到 `manifest.json` 驱动架构：
- 内置服务从 `.tar.gz` 资源包里的 `manifest.json` 自动发现。
- 插件从平台程序数据目录自动扫描注册，统一使用 macOS `~/Library/Application Support/ZenMind/plugins/<plugin-id>/<version>/`，Windows `%APPDATA%\ZenMind\plugins\<plugin-id>\<version>\`。
- Desktop 不再随安装包内置任何插件，插件统一通过导入 archive 的方式接入。
- 插件导入后需要在控制中心执行一次初始化；Desktop 会补齐模板配置并执行 `scripts.deploy`。
- Desktop 不再在 `service-registry.ts` 中硬编码任何内置服务结构。

当前仓库重点覆盖两类服务：
- `agent-container-hub`：宿主机容器服务，为后续智能体运行时提供沙箱能力。
- `agent-platform`：智能体运行时服务。
- `agent-webclient`：智能助理前端，作为内置服务随 Desktop 分发。
- `zenmind-app-server`：认证与管理服务，提供 OAuth2/OIDC、管理后台和 App 访问令牌。
- `pan-webclient`：网盘服务，通过插件系统导入。

桌面端不再启动统一静态资源服务。各服务在自己的端口上直接提供前端，渲染层 webview 直接访问对应 `healthMeta.webUrl`。需要认证的服务或插件（如 `agent-webclient`、`pan-webclient`）通过 postMessage Token Bridge 获取 Desktop 签发的 JWT。

## 2. 快速开始
### 前置要求
- Node.js 18 及以上
- npm 9 及以上
- macOS arm64 或 Windows x64 开发环境
- `tar` 命令可用
- 如需启动 `agent-container-hub`，本机需要 Docker 或 Podman

### 安装依赖
```bash
npm install
```

### 本地开发
```bash
npm run dev
```

开发模式会先同步内置资源、编译 Electron 主进程，再启动 Vite 和 Electron。默认会使用 `http://127.0.0.1:5173` 作为渲染进程开发地址。

### 构建
```bash
npm run build
```

该命令会依次执行：
- `npm run build:main`：编译 Electron 主进程与 preload
- `npm run build:renderer`：构建 React 渲染层

### 测试
```bash
npm test
```

测试会先执行完整构建，再运行 `test/*.test.mjs` 下的 Node 测试。

## 3. 调试面板

桌面应用在开发模式和打包后的正式版本中，都支持通过快捷键打开或关闭 Chromium DevTools 调试面板。

| 平台 | 快捷键 | 效果 |
|------|--------|------|
| macOS | `Cmd + Option + I` | 打开/关闭 DevTools 调试面板 |
| Windows | `Ctrl + Shift + I` | 打开/关闭 DevTools 调试面板 |

DevTools 可用于查看控制台日志、网络请求、DOM 结构以及页面运行时状态，便于排查桌面端和嵌入页面的问题。

## 4. 配置说明
### 内置资源目录
- 开发环境默认从 `build/resources/services` 读取内置服务资源包。
- 打包后默认从应用资源目录下的 `services` 读取。
- 如需覆盖资源目录，可设置环境变量 `ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT`。
- 每个内置资源包都必须在根目录包含 `manifest.json`，Desktop 会从中读取 `kind`、`scripts`、`runtime`、`web` 和 `desktop` 扩展字段。

### 前端访问模式
- `frontendMode: "none"`：无前端，仅在控制中心管理。
- `frontendMode: "embedded"`：前端由服务自身进程托管，可在详情页打开，但不会出现在顶部导航。
- `frontendMode: "standalone"`：前端由服务自身端口直接提供，详情页可打开，运行中会出现在顶部导航。
- webview 直接访问服务状态里的 `healthMeta.webUrl`，例如 `http://127.0.0.1:11950/admin/`。
- 需要认证的服务或插件（如 `agent-webclient`、`pan-webclient`）通过 `auth-bridge.ts` 构建带参数的嵌入 URL，并通过 postMessage Token Bridge 获取 JWT。

### 服务配置文件
- 新安装的 Desktop 配置与运行数据根目录按品牌 id 派生：`BRAND=zenmind` 为 macOS `~/.zenmind/.desktop`、Windows `%USERPROFILE%\.zenmind\.desktop`；`BRAND=cutej` 为 macOS `~/.cutej/.desktop`、Windows `%USERPROFILE%\.cutej\.desktop`。目录按 `config/`、`data/`、`state/`、`logs/`、`cache/`、`secrets/`、`profiles/` 分层；这里不存放可替换程序产物。
- 首次启动导入 `env.zip` 时，解压生成的环境目录为品牌运行根目录，例如 `~/.zenmind` 或 `~/.cutej`，不放在 AppData 下。
- 服务程序安装到 macOS `~/Library/Application Support/ZenMind/services/<service-id>/<version>/` 或 Windows `%APPDATA%\ZenMind\services\<service-id>\<version>\`，服务配置保存到 Desktop 配置根目录的 `config/services/<service-id>/`，运行数据保存到 `data/services/<service-id>/`。
- 每个内置服务会在安装时自动完成初始化；缺失的 `.env` 会从 `.env.example` 复制生成，随后由桌面端进行读写。
- 插件程序安装到 macOS `~/Library/Application Support/ZenMind/plugins/<plugin-id>/<version>/` 或 Windows `%APPDATA%\ZenMind\plugins\<plugin-id>\<version>\`，插件配置保存到 Desktop 配置根目录的 `config/plugins/<plugin-id>/`。
- 插件导入只负责解包和注册；点击控制中心中的“初始化”后，Desktop 才会补齐缺失配置、修复脚本权限并执行 `scripts.deploy`。

### 敏感信息管理
- 真实密钥、证书和本地环境差异配置不提交到仓库。
- pan-webclient 使用的 RSA 密钥对由 Desktop 管理，存储在 `secrets/` 下；agent-platform 使用 `zenmind-app-server` 的 JWK。
- `.env.local`、编辑器配置和构建产物应由 `.gitignore` 管理。
- 示例配置应保留在随服务分发的模板文件中，不要把真实值写入文档。

## 5. 部署
### 桌面构建
```bash
npm run build
```

构建完成后，渲染层产物位于 `dist-renderer/`，Electron 主进程产物位于 `dist-electron/`。

### macOS 打包
```bash
npm run dist:mac
```

使用 `electron-builder` 输出 DMG 安装包，目标 arm64 架构，使用 ad-hoc 签名。
如需把首启环境包内置进应用，可传入 `ENV_ZIP`：

```bash
BRAND=cutej ENV_ZIP=/path/to/env.zip npm run dist:mac
```

`ENV_ZIP` 必须是标准环境包：解压后只能有一个顶层 `env/` 目录，实际运行内容位于 `env/VERSION`、`env/agents/`、`env/registries/` 等路径下。Desktop 首启导入只复制缺失文件；已存在的 agent、provider、owner 等文件会跳过，不会覆盖、迁移或自动修复旧 seed。

也可以使用 Makefile 入口：

```bash
make release
```

在 macOS 上，`make release` 会重新生成图标并执行 macOS arm64 DMG 打包。

### Windows 打包
```bash
npm run dist:win
```

Windows 主机上会直接使用 `electron-builder` 输出 NSIS 安装包，目标 x64 架构。
如需内置同一份首启环境包，可使用：

```bash
BRAND=cutej ENV_ZIP=/path/to/env.zip npm run dist:win
```

在 macOS 或 Linux 主机上，请改用：

```bash
npm run dist:win-docker
```

该命令会先在宿主机执行 `npm run sync:assets -- --os=windows --arch=amd64`，把内置服务资源同步到 `build/resources/services/`，随后再通过 Docker 启动官方 `electronuserland/builder:wine` 镜像生成 Windows NSIS 包。这样可以规避宿主 macOS 生成损坏 NSIS 卸载器、在 Windows 上卸载时报 `Installer integrity check has failed` 的问题，同时避免容器内访问不到 monorepo 其他项目产物。

非 Windows 主机执行该命令前需要满足：
- 已安装并启动 Docker Desktop 或其他兼容 Docker 的运行时
- 容器可以访问 npm registry 以安装依赖

如果机器上已经残留旧的 per-user/per-machine 双安装记录，建议先手动清理旧版本，再验证新包的安装和卸载。

### 卸载
- macOS：运行 `/Applications/ZenMind.app/Contents/Resources/uninstall.sh`。脚本会先检查应用是否仍在运行，随后删除 `/Applications/ZenMind.app`，并弹窗询问是否清理当前品牌数据目录（例如 `~/.zenmind/.desktop` 或 `~/.cutej/.desktop`）和 `~/Library/Application Support/ZenMind`；默认保留数据。
- Windows：通过控制面板或开始菜单中的卸载入口执行 NSIS 卸载器。卸载会删除安装目录，并询问是否清理 `%APPDATA%\ZenMind`；默认保留数据。

### 打包资源约定
- `package.json` 中的 `build.files` 会打入桌面应用运行所需代码。
- `build.extraResources` 会把 `build/resources/services` 下的内置服务资源复制进应用包。
- `build.extraResources` 会把 `build/resources/env` 复制进应用包；设置 `ENV_ZIP=/path/to/env.zip` 打包时会生成 `build/resources/env/env.zip`，首启缺少运行环境时优先自动导入。`sync:env` 会拒绝当前品牌运行根包装目录（如 `.zenmind/`、`.cutej/`）、历史 `zenmind-env/`、裸顶层文件或嵌套 `env/env/` 结构。
- `build.extraResources` 同时会把 `scripts/uninstall.sh` 放入 macOS 应用包资源目录，供完整卸载使用。
- `build/installer.nsh` 会注入 NSIS 卸载流程，在 Windows 上给用户选择是否清理应用数据。
- `npm run sync:assets` 会扫描工作区内各服务目录以及聚合产物目录中的 `.tar.gz` / `.zip` 发布包，只同步 `manifest.json.kind === "builtin"` 的产物。支持 `--os` 和 `--arch` 参数按平台过滤。
- 如设置 `ZENMIND_BUILTIN_ASSETS_SOURCE`，`sync:assets` 会优先从该目录扫描 `<service-id>/<archive-file>` 结构的预收集产物，再 fallback 到工作区自动发现。`../zenmind-dist` 就符合这个目录结构。
- Desktop 通过 bundle 内的 `manifest.json.desktop.bundleTopLevelDir` 和 `runtime.requiredPaths` 校验资源完整性。
- 如新增内置服务，需要保证 release bundle 内自带完整 `manifest.json`，再执行打包。
- 如需覆盖已有品牌运行环境（例如 `~/.zenmind` 或 `~/.cutej`），使用 env 包内的显式脚本 `env/scripts/overwrite-env.sh` 或 `env/scripts/overwrite-env.ps1`。Desktop 不会自动调用覆盖脚本，也不提供自动覆盖入口。

## 6. 运维
### 常用命令
```bash
npm run sync:assets
npm run dev
npm run build
npm test
make release
npm run dist:mac
npm run dist:win
npm run dist:win-docker
```

### 日志与运行状态
- 桌面端通过主进程统一管理服务运行状态。
- 每个服务都会维护 PID 文件和日志文件路径，并在控制中心中展示。
- 服务实际程序目录位于 Application Support 的 `ZenMind/services/<service-id>/<version>/` 下；配置、状态和日志分别位于 Desktop 配置根目录的 `config/services/`、`state/services/`、`logs/services/`。

### 常见排查
- 启动失败时，先检查控制中心展示的状态文案、日志文件路径和 PID 文件路径。
- `agent-container-hub` 无法启动时，优先检查 Docker 或 Podman 是否可用。
- `pan-webclient` 无法启动时，优先确认 `.env` 已生成且 RSA 公钥已自动写入。
- `agent-platform` 认证使用 `zenmind-app-server` 的 JWK public key；Desktop 启动前会 bootstrap app-server JWK、同步 public key，并通过 app-server 签发 access token。
- 若测试失败，请先确认 `build/resources/services` 中的内置资源已同步完成。
