# CLAUDE.md

## 1. 项目概览
`zenmind-desktop` 是一个桌面端控制壳项目，目标是把内置服务随 Electron 应用分发，并提供统一的服务控制台。桌面端负责发现内置服务、安装资源包、写入默认配置、执行启动与停止脚本，并向渲染层暴露服务状态与控制能力。

当前已接入的内置服务有两个：
- `agent-container-hub`：为本地智能体运行提供容器沙箱能力。
- `pan-webclient`：提供内置网盘能力，包含后端程序和已构建前端资源。

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
- `src/main`：主进程，负责窗口创建、IPC 注册、服务安装与生命周期管理。
- `src/preload`：通过 `contextBridge` 暴露受控桌面 API 给渲染层。
- `src/renderer`：React 界面，展示控制中心和具体服务页面。
- `src/shared`：主进程与渲染层共用的类型契约。

核心调用链如下：
- 渲染层通过 `window.electronAPI.services.*` 发起服务操作。
- preload 层把调用桥接到 `ipcRenderer.invoke(...)`。
- 主进程在 `src/main/index.ts` 注册对应 `ipcMain.handle(...)` 处理器。
- `service-manager` 执行资源校验、安装、配置读写、脚本调用、状态探测与日志元数据收集。

## 4. 目录结构
- `src/main`：Electron 主进程入口、服务注册表、服务管理实现。
- `src/preload`：桌面 API 暴露层。
- `src/renderer`：React 页面、上下文和样式。
- `src/shared`：共享类型定义，例如 `ServiceState`、`ServiceCommandResult`。
- `scripts`：开发辅助脚本和内置资源同步逻辑。
- `build/resources/services`：开发期内置服务资源同步输出目录。
- `test`：Node 测试，覆盖资源包校验、服务管理和构建约束。

## 5. 数据结构
核心共享结构定义在 `src/shared/contracts.ts`：
- `ServiceId`：当前支持 `agent-container-hub` 和 `pan-webclient`。
- `ServiceStatus`：描述未安装、已停止、运行中、缺配置、缺依赖、错误等状态。
- `ServiceConfigFile`：单个配置文件的键、标签、相对路径、绝对路径和是否存在。
- `ServiceHealthMeta`：PID、PID 文件路径、日志路径、访问入口、端口和前置条件列表。
- `ServiceState`：渲染层展示服务卡片时使用的统一结构。
- `ServiceCommandResult` / `ServiceConfigReadResult` / `ServiceImportResult` / `ServiceLogsMeta`：分别用于命令返回、配置读取、文件导入和日志元数据查询。

## 6. API 定义
当前通过 preload 暴露的 IPC 能力如下：
- `services.list`：列出所有服务状态。
- `services.installBuiltin`：安装指定内置服务。
- `services.getStatus`：读取单个服务状态。
- `services.start`：启动服务。
- `services.stop`：停止服务。
- `services.restart`：重启服务。
- `services.readConfig`：读取指定配置项内容。
- `services.writeConfig`：写入指定配置项内容。
- `services.importFile`：导入外部文件到服务目录。
- `services.getLogsMeta`：读取日志路径与存在性信息。

这些接口默认通过 `ipcRenderer.invoke` 调用，返回值类型以 `DesktopApi` 契约为准。

## 7. 开发要点
- 开发模式依赖 `scripts/dev.mjs` 串起资源同步、主进程编译、Vite 启动和 Electron 启动。
- 内置资源必须先经过 `npm run sync:assets`，否则安装与测试会因为缺少资源包失败。
- 渲染层必须继续使用 `HashRouter`，以避免 Electron 文件协议下的路由问题。
- 生产环境从 `process.resourcesPath/services` 读取资源；开发环境从 `build/resources/services` 读取。
- 服务安装后会自动尝试把模板配置复制为 `.env`，因此配置模板应始终随服务资源一起分发。
- 桌面端退出时会在 `before-quit` 中停止本次会话启动过的服务。

## 8. 开发流程
### 本地开发
1. 执行 `npm install`
2. 执行 `npm run dev`
3. 在桌面界面中验证内置服务状态和操作流程

### 构建
1. 执行 `npm run build`
2. 检查 `dist/` 与 `dist-electron/` 是否生成

### 测试
1. 执行 `npm test`
2. 确认资源包校验、构建产物约束和服务管理相关测试全部通过

### 打包
1. 执行 `npm run dist:mac`
2. 使用 `electron-builder` 生成 macOS arm64 DMG

## 9. 已知约束与注意事项
- 当前打包目标主要是 macOS arm64，其他平台尚未在本仓库配置完整分发链路。
- 内置服务资源依赖外部打包产物，资源包内容缺失会直接导致安装或测试失败。
- `agent-container-hub` 依赖本机可用的 Docker 或 Podman。
- `pan-webclient` 在缺少真实 RSA 公钥时会处于前置条件未满足状态。
- 服务运行目录位于 Electron `userData` 路径下，实际行为与当前操作系统用户环境相关。
