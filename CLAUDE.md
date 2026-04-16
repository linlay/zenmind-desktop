# CLAUDE.md

## 1. 项目概览
`zenmind-desktop` 是一个桌面端控制壳项目，目标是把内置服务和第三方插件随 Electron 应用分发，并提供统一的服务控制台。桌面端负责发现内置服务、运行时加载插件、安装资源包、写入默认配置、执行启动与停止脚本，并向渲染层暴露服务状态与控制能力。

项目支持两种服务来源：
- **内置服务（builtin）**：随应用打包分发，当前包含 `agent-container-hub`、`agent-platform` 和 `zenmind-app-server`。
- **插件（plugin）**：运行时通过 `.tar.gz` 包导入，存储在 `userData/plugins/` 目录，启动时自动扫描加载。插件包必须包含 `manifest.json` 清单文件。

前端按三种模式区分：
- **无前端**（`frontendMode: "none"`）：只在控制中心显示。
- **内嵌前端**（`frontendMode: "embedded"`）：可在详情页打开，但不会出现在顶部导航栏。
- **独立前端**（`frontendMode: "standalone"`）：可在详情页打开，运行中会出现在顶部导航栏。

## 2. 技术栈
- Electron 36
- React 18
- React Router 6，渲染层使用 `HashRouter`
- Vite 7
- TypeScript 5
- electron-builder 24
- Node.js 原生 `node:test`
- npm 作为默认脚本入口

## 3. 架构设计
项目采用 Electron 标准三层结构：
- `src/main`：主进程，负责窗口创建、IPC 注册、插件加载、服务安装与生命周期管理。
- `src/preload`：通过 `contextBridge` 暴露受控桌面 API 给渲染层。
- `src/renderer`：React 界面，展示控制中心和服务前端页面。
- `src/shared`：主进程与渲染层共用的类型契约和认证桥接逻辑。

核心调用链如下：
- 渲染层通过 `window.electronAPI.services.*` 发起服务操作，通过 `window.electronAPI.plugins.*` 发起插件管理操作，通过 `window.electronAPI.agentAuth.*` 发起令牌签发。
- preload 层把调用桥接到 `ipcRenderer.invoke(...)`。
- 主进程在 `src/main/index.ts` 注册对应 `ipcMain.handle(...)` 处理器。
- `service-manager` 执行资源校验、安装、配置读写、脚本调用、状态探测与日志元数据收集。
- `plugin-loader` 负责插件的扫描加载、安装和卸载。
- `plugin-uninstall` 负责卸载确认对话框和卸载流程编排。
- `builtin-loader` 负责从内置 tar.gz 资源包提取 `manifest.json` 并注册 builtin 服务。
- `service-registry` 维护统一的动态服务注册表，通过 `getAllServices()` 统一返回。
- `env-file` 提供 `.env` 文件的解析和读取工具函数。
- `pan-auth` 负责 Desktop App 私钥导入、RSA 密钥对管理和 JWT 签发。
- `agent-auth` 负责签发 Desktop AGENT access token，复用 `pan-auth` 的密钥对。
- `auth-bridge`（shared）定义特定插件的 postMessage 认证桥接协议，当前覆盖 `agent-webclient` 和 `pan-webclient`。
- 渲染层 iframe 直接访问各服务自身监听端口，不再经过桌面端中转。需要认证的插件通过 postMessage Token Bridge 获取 Desktop 签发的 JWT。

## 4. 目录结构
- `src/main`
  - `index.ts`：窗口创建、IPC 注册、应用生命周期、DevTools 快捷键。
  - `builtin-loader.ts`：扫描内置资源包并提取 `manifest.json`。
  - `manifest-utils.ts`：Manifest 解析、兼容映射、`ServiceDefinition` 归一化和 tar.gz 清单读取。
  - `service-registry.ts`：统一服务注册/注销与查询。
  - `service-manager.ts`：服务安装、启停、配置读写、状态探测。
  - `plugin-loader.ts`：插件扫描、安装（从 tar.gz）、卸载。
  - `plugin-uninstall.ts`：插件卸载确认对话框与流程编排。
  - `pan-auth.ts`：Pan 网盘私钥导入、RSA 密钥对生成与 JWT 签发。
  - `agent-auth.ts`：Desktop AGENT access token 签发，复用 pan-auth 密钥对。
  - `env-file.ts`：`.env` 文件解析与读取。
- `src/preload`：桌面 API 暴露层，包含 `services`、`plugins`、`panAuth`、`agentAuth` 四个命名空间。
- `src/renderer`
  - `pages/ControlCenterPage.tsx`：服务控制中心。
  - `pages/PluginPage.tsx`：通用服务前端页面，通过 iframe 加载服务 web 入口，支持 postMessage Token Bridge 认证。
  - `pages/PlaceholderPage.tsx`：占位页面，用于小宅助理、智能体、插件市场、帮助等预留入口。
  - `components/Header.tsx`：顶部导航栏，动态展示运行中且 `frontendMode === "standalone"` 的服务入口。
  - `services/ServicesContext.tsx`：React Context，封装所有服务和插件操作。
- `src/shared`
  - `contracts.ts`：共享类型定义，包含 `DesktopApi` 接口。
  - `auth-bridge.ts`：插件认证桥接协议定义和 URL 构建逻辑。
- `scripts`：开发辅助脚本和内置资源同步逻辑。
- `build/resources/services`：开发期内置服务资源同步输出目录。
- `docs`：插件开发指南。
- `test`：Node 测试，覆盖资源包校验、服务管理和构建约束。

## 5. 数据结构
核心共享结构定义在 `src/shared/contracts.ts`：
- `ServiceId`：`string` 类型，支持任意动态 ID（内置服务和插件共用）。
- `ServiceKind`：`"builtin" | "plugin"`，区分内置服务和插件。
- `FrontendMode`：`"none" | "embedded" | "standalone"`，区分服务前端暴露方式。
- `ServiceStatus`：描述未安装、已停止、运行中、缺配置、缺依赖、错误等状态。
- `ServiceConfigFile`：单个配置文件的键、标签、相对路径、绝对路径、是否必须和是否存在。
- `ServiceHealthMeta`：PID、PID 文件路径、日志路径、访问入口、端口和前置条件列表。
- `ServiceState`：渲染层展示服务卡片时使用的统一结构，包含 `frontendMode` 字段。
- `Manifest`：内置服务和插件共用的统一清单结构，包含 `kind`、`frontend`、`api`、`backend`、`scripts`、`configFiles`、`runtime`、`web`、`prerequisites` 与 `desktop` 扩展字段。
- `ManifestCommand`：`string | string[]`，支持单字符串或命令数组两种写法。
- `DesktopApi`：preload 暴露给渲染层的完整 API 接口定义。
- `AgentAuthRefreshReason`：`"missing" | "unauthorized"`，令牌签发原因。
- `AgentAuthIssueResult`：令牌签发结果。
- `PluginInstallResult`：插件安装/卸载结果。

认证桥接结构定义在 `src/shared/auth-bridge.ts`：
- `PluginAuthBridgeProtocol`：定义 `requestType` 和 `responseType` 消息类型。
- 当前注册了 `agent-webclient` 和 `pan-webclient` 两个桥接协议。

## 6. API 定义
当前通过 preload 暴露的 IPC 能力如下：

### services 命名空间
- `services.list`：列出所有服务状态（包含内置服务和已导入插件）。
- `services.installBuiltin`：安装指定内置服务。
- `services.initialize`：执行服务初始化流程（补默认配置、修复脚本权限、执行 `scripts.deploy`）。
- `services.getStatus`：读取单个服务状态。
- `services.start`：启动服务。
- `services.stop`：停止服务。
- `services.restart`：重启服务。
- `services.readConfig`：读取指定配置项内容。
- `services.writeConfig`：写入指定配置项内容。
- `services.importFile`：导入外部文件到服务目录。
- `services.getLogsMeta`：读取日志路径与存在性信息。

### plugins 命名空间
- `plugins.install`：弹出文件选择对话框，选择 `.tar.gz` 插件包进行导入。
- `plugins.uninstall`：卸载指定插件（弹出确认对话框，确认后删除目录并注销注册）。

### panAuth 命名空间
- `panAuth.importPrivateKey`：导入 Desktop App 私钥。
- `panAuth.getStatus`：读取私钥配置状态。

### agentAuth 命名空间
- `agentAuth.issueAccessToken`：签发 Desktop AGENT access token，接受 `reason` 参数（`"missing"` 或 `"unauthorized"`）。自动确保 RSA 密钥对存在后签发 JWT。

## 7. 插件系统
### 插件包结构
```text
my-plugin/
  manifest.json           # 必须
  start.sh                # 启动脚本
  stop.sh                 # 停止脚本
  .env.example            # 配置模板（可选）
  frontend/dist/          # 前端构建产物（可选，frontend.mode != "none" 时需要）
```

### 插件生命周期
1. 用户在控制中心点击"导入插件"，选择 `.tar.gz` 包。
2. 主进程解压到 `userData/plugins/{id}/`，读取 `manifest.json` 并注册。
3. 控制中心左侧边栏立即出现新服务卡片，状态为"待初始化"。
4. 用户完成必要的配置编辑后，点击"初始化"；Desktop 会补齐模板配置、修复脚本权限，并执行 `scripts.deploy`。
5. 初始化成功后，插件进入可启动状态；启动后，`frontendMode !== "none"` 的插件会在详情区显示"打开前端"按钮；`frontendMode === "standalone"` 时会出现在顶部导航栏。
6. 下次启动 Electron 时，`loadInstalledPlugins` 自动扫描 `userData/plugins/` 并重新注册；未初始化的插件仍会保持"待初始化"。
7. 卸载时弹出确认对话框，确认后停止运行中的服务、删除插件目录并从注册表移除。

### 认证桥接
需要认证的插件（如 `agent-webclient`、`pan-webclient`）通过 postMessage Token Bridge 与 Desktop 通信：
1. 插件 iframe 发送 `{ type: requestType, requestId, action: "getAccessToken" | "refreshAccessToken", reason? }` 消息。
2. `PluginPage` 监听消息，调用 `agentAuth.issueAccessToken` 签发 JWT。
3. 将 `{ type: responseType, requestId, token }` 回传给 iframe。

## 8. 开发要点
- 开发模式依赖 `scripts/dev.mjs` 串起资源同步、主进程编译、Vite 启动和 Electron 启动。
- 内置资源必须先经过 `npm run sync:assets`，否则安装与测试会因为缺少资源包失败。
- `npm run sync:assets` 会从工作区各项目的 `dist/release/*.tar.gz` 中提取 `manifest.json`，只同步 `kind === "builtin"` 的 bundle。支持 `--os` 和 `--arch` 参数按平台过滤。
- `agent-platform` 作为 builtin 启动前会自动注入 Container Hub 地址、`SERVER_PORT`、`AGENT_AUTH_ENABLED=true` 和本地 RSA 公钥路径。
- 渲染层必须继续使用 `HashRouter`，以避免 Electron 文件协议下的路由问题。
- 生产环境从 `process.resourcesPath/services` 读取内置资源；开发环境从 `build/resources/services` 读取。
- 服务初始化阶段会尝试把模板配置复制为 `.env`，因此配置模板应始终随服务资源一起分发。
- 桌面端退出时会在 `before-quit` 中停止本次会话启动过的服务。
- preload 脚本在 Electron 窗口创建时加载，修改后必须重启整个 Electron 进程才能生效，仅刷新页面无效。
- 顶部导航栏由 `Header.tsx` 动态生成，固定项为"控制中心"（前）和"插件市场"、"帮助"（后），运行中且 `frontendMode === "standalone"` 的服务会自动插入中间。
- 有前端的服务 iframe 会直接指向服务自身的 `healthMeta.webUrl`。特定插件（`agent-webclient`、`pan-webclient`）会通过 `auth-bridge.ts` 构建带参数的嵌入 URL。
- `ManifestCommand` 支持 `string` 和 `string[]` 两种写法。`.ps1` 脚本会自动通过 `powershell`（Windows）或 `pwsh`（其他平台）执行。

## 9. 打包约定
- `agent-container-hub` 的 builtin bundle 对齐 Hub 新规范：
  - 文件名不再带 `program`
  - 二进制位于 `backend/agent-container-hub`
  - PID / 日志位于 `run/`
  - 根目录必须包含 `manifest.json`
- `agent-platform` 和 `zenmind-app-server` 仍沿用现有 program bundle 规范。
- macOS 打包使用 `npm run dist:mac`，输出 DMG，使用 ad-hoc 签名。
- Windows 打包使用 `npm run dist:win`，输出 NSIS 安装包。

## 10. 已知约束与注意事项
- 当前打包目标主要是 macOS arm64 和 Windows x64，其他平台尚未在本仓库配置完整分发链路。
- 内置服务资源依赖外部打包产物，资源包内容缺失会直接导致安装或测试失败。
- `agent-container-hub` 依赖本机可用的 Docker 或 Podman。
- `pan-webclient` 和 `agent-webclient` 已从内置服务移除，改为通过插件系统导入。
- 服务运行目录位于 Electron `userData` 路径下，实际行为与当前操作系统用户环境相关。
- RSA 密钥对由 Desktop 统一管理，存储在 `userData/credentials/` 下，同时用于 pan-webclient 和 agent-platform 的认证。
