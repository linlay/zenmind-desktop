# ZenMind Desktop `index.ts` 重构与瘦身总结报告

为了解决 Electron 主进程入口文件 `src/main/index.ts` 过于臃肿（重构前数千行代码）、模块耦合严重、难以进行单元测试等问题，我们通过**测试驱动开发（TDD）**模式，对主进程架构进行了深度重构与解耦。

本报告总结了此次重构的架构设计、模块划分、平台收口、状态整合以及测试验证结果。

---

## 1. 重构目标与核心设计

### 1.1 核心问题
* **单文件膨胀**：`index.ts` 承载了窗口管理、桌面宠物、进程生命周期、SSO 认证、文件读写、数十个 IPC 监听注册等绝大多数主进程逻辑。
* **难以测试**：核心业务逻辑直接调用 Electron 运行时 API（如 `ipcMain.handle`、`BrowserWindow`），导致无法在没有 Electron 环境的纯 Node.js 环境下运行单元测试。
* **平台耦合**：多处直接使用 `process.platform` 来控制平台差异，缺乏统一收口，导致代码碎片化严重。

### 1.2 重构方案：依赖注入（DI）与 Context 模式
1. **模块逻辑纯净化**：将所有业务逻辑和 IPC Handler 提取到独立模块中，模块只声明接口、类型和构造逻辑，所需的外部运行时依赖（如 `app`、`shell`、`mainWindow` 等）全部通过构造参数注入。
2. **Context 上下文整合**：定义全局上下文对象 `MainProcessContext`，其持有公共状态（`MainAppState`）与运行时依赖，所有 IPC Options 工厂函数均基于 Context 装配。
3. **测试 Mock 友好**：IPC Handler 注册函数（如 `registerShellIpcHandlers`）接受 Mock 的 `ipcMain` 和 Options 依赖，使得业务逻辑和 IPC 管道映射完全可以在纯 Node.js (TAP runner) 下进行高效测试。

---

## 2. 模块拆分与提取清单

所有的 IPC 监听逻辑与周边功能全部从 `index.ts` 中剥离，分类整理到独立的源文件中：

| 功能模块 | 对应抽取文件 / 路径 | 说明 |
| :--- | :--- | :--- |
| **Startup / Restore** | [`src/main/startup-restore.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/startup-restore.ts) | 启动恢复状态机逻辑解耦与可测化 |
| **Platform Adapter** | [`src/main/platform-adapter.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/platform-adapter.ts) | 统一封装平台初始化、DevTools 快捷键及 SSO UA 分支 |
| **SSO Controller** | [`src/main/sso-controller.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/sso-controller.ts) | SSO 浏览器窗口管理与 Cookie 同步逻辑 |
| **Desktop Pet Controller** | [`src/main/desktop-pet-controller.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/desktop-pet-controller.ts) | 桌面宠物的拖拽、计算、预览状态管理等核心逻辑 |
| **Window Manager** | [`src/main/window-manager.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/window-manager.ts) | 主窗口配置创建、权限管理与生命周期托管 |
| **Shell Handlers** | [`src/main/ipc/shell-handlers.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/ipc/shell-handlers.ts) | 托管 `shell.*`、`desktopDialog.*`、`desktopDownloads.*`、`diagnostics.*` |
| **Assistant Handlers** | [`src/main/ipc/assistant-handlers.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/ipc/assistant-handlers.ts) | 托管 `assistant.*`、`currentPage.*`、`desktopActions.*` 等助手相关交互 |
| **Services Handlers** | [`src/main/ipc/services-handlers.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/ipc/services-handlers.ts) | 托管服务列表、启停、配置读写、日志监控（21 个 Handler） |
| **Kanban Handlers** | [`src/main/ipc/kanban-handlers.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/ipc/kanban-handlers.ts) | 托管看板议题增删改查、自定义侧边栏配置（12 个 Handler） |
| **SSO Handlers** | [`src/main/ipc/sso-handlers.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/ipc/sso-handlers.ts) | 托管 SSO 状态、登录/登出及 `agentAuth.issueAccessToken` |
| **Settings Handlers** | [`src/main/ipc/settings-handlers.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/ipc/settings-handlers.ts) | 托管本地目录根、多语言国际化环境切换、应用菜单刷新 |
| **Marketplace Handlers** | [`src/main/ipc/marketplace-handlers.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/ipc/marketplace-handlers.ts) | 托管插件安装卸载、应用市场同步、沙箱镜像导入导出 |

---

## 3. 上下文与状态治理

### 3.1 MainAppState 整合
创建了统一的 [`src/main/app-state.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/app-state.ts) 对象，将原先凌乱散落在 `index.ts` 各处的全局状态变量（如主窗口句柄、宠物设置与状态、服务队列、退出清理标志等）整合进单一的 `appState` 实例中：
* `mainWindow`: Electron 浏览器主窗口引用。
* `desktopPetWindow`: 桌面宠物窗口。
* `desktopPetSettings` & `desktopPetState`: 宠物持久化配置与当前逻辑状态。
* `isHandlingQuit` & `shutdownCleanupComplete`: 记录退出生命周期状态。

### 3.2 MainProcessContext 声明
基于 [`src/main/main-process-context.ts`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/src/main/main-process-context.ts)，我们在 `index.ts` 启动时创建主上下文，并传递给所有 IPC 模块装配函数：
```typescript
export interface MainProcessContext {
  state: MainAppState;
  app: unknown;
  ipcMain: unknown;
  platform: NodeJS.Platform;
  shell: unknown;
  session: unknown;
  nativeTheme: unknown;
}
```

---

## 4. 跨平台路径测试修复 (`src/main/user-paths.ts`)

在重构后的自动化测试验证中，发现在 Windows 宿主机上运行 macOS (`darwin`) 平台相关的路径计算测试时，单元测试会由于路径格式（反斜杠 `\` 与驱动器前缀 `C:\`）而报错。

**解决方案**：
我们在 `src/main/user-paths.ts` 中重构了 `pathApiForPlatform` 逻辑，当传入非 Windows (`win32`) 平台时，显式指定使用 `path.posix` 进行解析与拼装。这一改动使测试套件能够脱离运行主机的操作系统环境，在 Windows 上也能完美验证 macOS/Linux 下的路径推导：
```typescript
function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path.posix;
}
```

---

## 5. 测试与验证结果

此次重构严格执行 TDD 流程：
1. **编写红灯测试**：在未重构前编写目标模块的 `*.test.mjs` 测试文件，确保用例均能正常捕获失败。
2. **实现模块与 DI 映射**：提取业务代码，实现 options 装配工厂。
3. **验证绿灯**：单跑模块单元测试与集成测试，最终在主入口 `index.ts` 中进行接入。

### 5.1 核心 IPC 处理器测试用例统计
* [`test/main-process-context.test.mjs`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/test/main-process-context.test.mjs) (15 tests) - **PASS** 🟢
* [`test/settings-handlers.test.mjs`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/test/settings-handlers.test.mjs) (5 tests) - **PASS** 🟢
* [`test/desktop-pet-handlers.test.mjs`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/test/desktop-pet-handlers.test.mjs) (4 tests) - **PASS** 🟢
* [`test/sso-handlers.test.mjs`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/test/sso-handlers.test.mjs) (5 tests) - **PASS** 🟢
* [`test/kanban-handlers.test.mjs`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/test/kanban-handlers.test.mjs) (12 tests) - **PASS** 🟢
* [`test/shell-handlers.test.mjs`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/test/shell-handlers.test.mjs) (4 tests) - **PASS** 🟢
* [`test/user-paths.test.mjs`](file:///c:/Users/42134/Desktop/zenmind-workspace/zenmind-desktop/test/user-paths.test.mjs) (8 tests) - **PASS** 🟢

### 5.2 全局集成测试
运行项目全局单元测试套件：
```bash
pnpm test
```
**结果**：**658 个单元测试全部绿灯通过**。

---

## 6. 面向开发者的后续指南

当下，`src/main/index.ts` 的定位已经转变为纯粹的**“模块装配与启动引导器”**。

如果你需要新增一个 IPC Handler：
1. **定义 Options 接口**：在相应的 `src/main/ipc/*-handlers.ts` 的 Options 接口中声明你所需的动作函数。
2. **实现 Handler 逻辑**：在对应的 `registerXYZIpcHandlers` 方法中使用 `ipcMain.handle` 注册新管道。
3. **编写单元测试**：在 `test/*-handlers.test.mjs` 中通过传递 mock 的 options 来充分测试你的 handler，无需启动真实的 Electron 窗口或网络服务。
4. **Context 中装配**：在 `src/main/main-process-context.ts` 中相应的 Factory 处补上依赖映射，并在 `src/main/index.ts` 的 `registerIpcHandlers` 调用处将真实的实现函数传入。
