# CLAUDE.md

## 1. 项目概览
`zenmind-desktop` 是一个桌面端控制壳项目，目标是把内置服务和第三方插件随 Electron 应用分发，并提供统一的服务控制台。桌面端负责发现内置服务、运行时加载插件、安装资源包、写入默认配置、执行启动与停止脚本，并向渲染层暴露服务状态与控制能力。

项目支持两种服务来源：
- **内置服务（builtin）**：随应用打包分发，当前包含 `agent-container-hub` 和 `zenmind-app-server`。
- **插件（plugin）**：运行时通过 `.tar.gz` 包导入，存储在 `userData/plugins/` 目录，启动时自动扫描加载。插件包必须包含 `plugin-manifest.json` 清单文件。

插件分为两种类型：
- **纯服务类型**（`hasFrontend: false`）：注册后在控制中心左侧边栏显示服务卡片，可启停、配置。
- **服务+前端类型**（`hasFrontend: true`）：除服务卡片外，运行后在详情区显示"打开前端"按钮，顶部导航栏自动添加入口，前端通过 iframe 加载。

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
- `src/renderer`：React 界面，展示控制中心和插件前端页面。
- `src/shared`：主进程与渲染层共用的类型契约。

核心调用链如下：
- 渲染层通过 `window.electronAPI.services.*` 发起服务操作，通过 `window.electronAPI.plugins.*` 发起插件管理操作。
- preload 层把调用桥接到 `ipcRenderer.invoke(...)`。
- 主进程在 `src/main/index.ts` 注册对应 `ipcMain.handle(...)` 处理器。
- `service-manager` 执行资源校验、安装、配置读写、脚本调用、状态探测与日志元数据收集。
- `plugin-loader` 负责插件的扫描加载、安装和卸载。
- `service-registry` 维护内置服务静态注册表和插件动态注册表，通过 `getAllServices()` 统一返回。

## 4. 目录结构
- `src/main`：Electron 主进程入口、服务注册表、服务管理、插件加载器、Pan 鉴权。
  - `index.ts`：窗口创建、IPC 注册、应用生命周期。
  - `service-registry.ts`：内置服务定义 + 插件动态注册/注销。
  - `service-manager.ts`：服务安装、启停、配置读写、状态探测。
  - `plugin-loader.ts`：插件扫描、安装（从 tar.gz）、卸载。
  - `pan-auth.ts`：Pan 网盘私钥导入与会话管理，支持从认证服务自动导出密钥对。
- `src/preload`：桌面 API 暴露层，包含 `services`、`plugins`、`panAuth` 三个命名空间。
- `src/renderer`：React 页面、上下文和样式。
  - `pages/ControlCenterPage.tsx`：服务控制中心，左侧服务列表 + 右侧详情面板。
  - `pages/PluginPage.tsx`：通用插件前端页面，通过 iframe 加载插件 web 服务。
  - `pages/PanPage.tsx`：网盘专用页面（保留，但当前路由未挂载，由插件系统动态接管）。
  - `pages/PlaceholderPage.tsx`：占位页面。
  - `components/Header.tsx`：顶部导航栏，动态展示运行中且有前端的插件入口。
  - `services/ServicesContext.tsx`：React Context，封装所有服务和插件操作。
- `src/shared`：共享类型定义。
- `scripts`：开发辅助脚本和内置资源同步逻辑。
- `build/resources/services`：开发期内置服务资源同步输出目录。
- `docs`：插件开发指南。
- `test`：Node 测试，覆盖资源包校验、服务管理和构建约束。

## 5. 数据结构
核心共享结构定义在 `src/shared/contracts.ts`：
- `ServiceId`：`string` 类型，支持任意动态 ID（内置服务和插件共用）。
- `ServiceKind`：`"builtin" | "plugin"`，区分内置服务和插件。
- `ServiceStatus`：描述未安装、已停止、运行中、缺配置、缺依赖、错误等状态。
- `ServiceConfigFile`：单个配置文件的键、标签、相对路径、绝对路径和是否存在。
- `ServiceHealthMeta`：PID、PID 文件路径、日志路径、访问入口、端口和前置条件列表。
- `ServiceState`：渲染层展示服务卡片时使用的统一结构，包含 `hasFrontend` 字段标识是否有前端页面。
- `PluginManifest`：插件清单结构，描述插件 ID、名称、版本、是否有前端、运行时配置和 web 配置。
- `PluginInstallResult`：插件安装/卸载操作结果。
- `ServiceCommandResult` / `ServiceConfigReadResult` / `ServiceImportResult` / `ServiceLogsMeta`：分别用于命令返回、配置读取、文件导入和日志元数据查询。

## 6. API 定义
当前通过 preload 暴露的 IPC 能力如下：

### services 命名空间
- `services.list`：列出所有服务状态（包含内置服务和已安装插件）。
- `services.installBuiltin`：安装指定内置服务。
- `services.getStatus`：读取单个服务状态。
- `services.start`：启动服务。
- `services.stop`：停止服务。
- `services.restart`：重启服务。
- `services.readConfig`：读取指定配置项内容。
- `services.writeConfig`：写入指定配置项内容。
- `services.importFile`：导入外部文件到服务目录。
- `services.getLogsMeta`：读取日志路径与存在性信息。

### plugins 命名空间
- `plugins.install`：弹出文件选择对话框，选择 `.tar.gz` 插件包进行安装。
- `plugins.uninstall`：卸载指定插件（删除目录并注销注册）。

### panAuth 命名空间
- `panAuth.importPrivateKey`：导入 Desktop App 私钥。
- `panAuth.getStatus`：读取私钥配置状态。
- `panAuth.ensureSession`：建立或刷新网盘本地会话。
- `panAuth.setupFromAppServer`：从认证服务（zenmind-app-server）导出 JWK 密钥对并安装私钥。
- `panAuth.distributePublicKey`：将已安装的私钥对应的公钥写入指定服务的配置目录。

这些接口默认通过 `ipcRenderer.invoke` 调用，返回值类型以 `DesktopApi` 契约为准。

## 7. 插件系统

### 插件包结构
```
my-plugin/
  plugin-manifest.json    # 必须
  start.sh                # 启动脚本
  stop.sh                 # 停止脚本
  .env.example            # 配置模板（可选）
  frontend/dist/          # 前端构建产物（可选，hasFrontend: true 时需要）
```

### 插件生命周期
1. 用户在控制中心点击"安装插件"，选择 `.tar.gz` 包。
2. 主进程解压到 `userData/plugins/{id}/`，读取 `plugin-manifest.json` 并注册。
3. 控制中心左侧边栏立即出现新服务卡片。
4. 启动后，有前端的插件会在详情区显示"打开前端"按钮，顶部导航栏自动添加入口。
5. 下次启动 Electron 时，`loadInstalledPlugins` 自动扫描 `userData/plugins/` 并重新注册。
6. 卸载时删除插件目录并从注册表移除。

### 插件与内置服务的区别
- 内置服务从 `build/resources/services`（开发）或 `process.resourcesPath/services`（生产）读取 tar.gz 资源包，安装到 `userData/services/{id}/{version}/`。
- 插件直接安装到 `userData/plugins/{id}/`，无需 tar.gz 资源包中转。
- 内置服务在控制中心显示"安装"按钮，插件显示"卸载插件"按钮。

## 8. 开发要点
- 开发模式依赖 `scripts/dev.mjs` 串起资源同步、主进程编译、Vite 启动和 Electron 启动。
- 内置资源必须先经过 `npm run sync:assets`，否则安装与测试会因为缺少资源包失败。
- 渲染层必须继续使用 `HashRouter`，以避免 Electron 文件协议下的路由问题。
- 生产环境从 `process.resourcesPath/services` 读取内置资源；开发环境从 `build/resources/services` 读取。
- 服务安装后会自动尝试把模板配置复制为 `.env`，因此配置模板应始终随服务资源一起分发。
- 桌面端退出时会在 `before-quit` 中停止本次会话启动过的服务。
- preload 脚本在 Electron 窗口创建时加载，修改后必须重启整个 Electron 进程才能生效，仅刷新页面无效。
- 顶部导航栏由 `Header.tsx` 动态生成，运行中且 `hasFrontend: true` 的插件会自动出现在导航栏中。

## 9. 开发流程
### 本地开发
1. 执行 `npm install`
2. 执行 `npm run dev`
3. 在桌面界面中验证内置服务状态和操作流程
4. 通过控制中心"安装插件"按钮测试插件导入

### 构建
1. 执行 `npm run build`
2. 检查 `dist/` 与 `dist-electron/` 是否生成

### 测试
1. 执行 `npm test`
2. 确认资源包校验、构建产物约束和服务管理相关测试全部通过

### 打包
1. 执行 `npm run dist:mac`
2. 使用 `electron-builder` 生成 macOS arm64 DMG

## 10. 已知约束与注意事项
- 当前打包目标主要是 macOS arm64，其他平台尚未在本仓库配置完整分发链路。
- 内置服务资源依赖外部打包产物，资源包内容缺失会直接导致安装或测试失败。
- `agent-container-hub` 依赖本机可用的 Docker 或 Podman。
- `zenmind-app-server` 作为内置服务运行时使用单二进制 Program Mode，不依赖 Docker。
- `pan-webclient` 已从内置服务移除，改为通过插件系统导入。需先在 pan-webclient 项目执行 `make release-program` 生成包含 `plugin-manifest.json` 的 tar.gz，再在控制中心安装。
- pan-webclient 的登录鉴权依赖 RSA 密钥对：私钥由桌面端持有用于签发 JWT，公钥由 pan-webclient 持有用于验签。密钥对可从 zenmind-app-server 的 JWK 存储中导出，通过 `panAuth.setupFromAppServer` 和 `panAuth.distributePublicKey` 自动配置。
- 服务运行目录位于 Electron `userData` 路径下，实际行为与当前操作系统用户环境相关。
- 插件的 `plugin-manifest.json` 中 `id` 字段用作目录名和路由参数，必须唯一且 URL 安全。
