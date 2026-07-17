# ZenMind Desktop

## 1. 项目概览

`zenmind-desktop` 是 ZenMind 的 Electron 应用壳，基于 Electron、React、Vite 和 TypeScript 构建。它负责把内置服务、插件、市场资源、网站入口、本地网站应用、智能助理和桌面协议能力组织成统一的桌面体验。

当前 Desktop 以 `manifest.json` 为服务发现和安装事实源：

- 内置服务从 `build/resources/services` 或打包后的 `resources/services` 自动发现。
- 插件统一通过 `.zip` 导入，安装到品牌隔离的平台程序数据目录。
- 桌面运行数据按品牌隔离在 `~/.zenmind/.desktop`、`~/.cutej/.desktop` 等目录。
- 渲染层 webview 直接访问服务或本地网站应用的 `webUrl`，需要认证的嵌入页通过 Desktop bridge 获取 token。

核心内置服务：

- `identity-center`：认证、OIDC、JWK 与 App access token。
- `agent-platform`：智能体运行时。
- `agent-webclient`：智能助理前端。
- `agent-container-hub`：宿主机容器与沙箱能力。

## 2. 技术栈

- Electron main / preload / renderer
- React 18 + Vite
- TypeScript
- Node.js 标准库文件系统、进程、HTTP、SQLite 能力
- electron-builder 打包 macOS DMG 与 Windows NSIS

## 3. 快速开始

前置要求：

- Node.js 18 及以上
- npm 9 及以上
- macOS arm64 或 Windows x64 开发环境
- `zip` / `unzip` / `tar`
- 如需启动 `agent-container-hub`，本机需要 Docker 或 Podman

常用命令：

```bash
npm install
npm run dev
npm run build
npm test
```

开发模式会同步品牌与内置资源、编译 Electron 主进程、启动 Vite 和 Electron。测试入口 `npm test` 会先执行 i18n 检查和完整构建，再运行 `test/*.test.mjs`。

## 4. 目录结构

```text
.
├── brands/                 # 品牌配置、图标和文案
├── build/                  # 生成的品牌配置、资源和打包中间产物
├── docs/                   # 中文专题文档
├── scripts/                # 开发、同步、打包和验证脚本
├── src/
│   ├── main/               # Electron 主进程
│   ├── preload/            # webview / renderer preload
│   ├── renderer/           # React 渲染层
│   └── shared/             # main / preload / renderer 共享契约
├── test/                   # Node 测试
├── AGENTS.md
├── CLAUDE.md
├── package.json
└── VERSION
```

## 5. 调试面板

| 平台 | 快捷键 | 效果 |
| --- | --- | --- |
| macOS | `Cmd + Option + I` | 打开或关闭 DevTools |
| Windows | `Ctrl + Shift + I` | 打开或关闭 DevTools |
| macOS | `Cmd + Shift + D` | 打开 Copilot 或当前 webview 的 DevTools |
| Windows | `Ctrl + Shift + D` | 打开 Copilot 或当前 webview 的 DevTools |

## 6. 专题文档索引

- [架构与模块边界](docs/架构与模块边界.md)：进程、模块、服务和前端边界。
- [时间契约](docs/时间契约.md)：epoch-ms、RFC3339、JWT 秒级字段和 shared contract 规则。
- [配置化与品牌](docs/配置化与品牌.md)：`BRAND`、品牌生成物、环境变量与配置来源。
- [数据目录](docs/数据目录.md)：桌面数据根、程序数据根、服务/插件/webs 数据分层。
- [内置资源与Manifest](docs/内置资源与Manifest.md)：内置服务资源包、manifest 字段和同步脚本。
- [启动初始化与恢复](docs/启动初始化与恢复.md)：启动阶段、首启 bootstrap、核心服务恢复顺序。
- [服务生命周期](docs/服务生命周期.md)：安装、初始化、启动、停止、日志和健康检查。
- [前端嵌入与导航](docs/前端嵌入与导航.md)：webview、独立/内嵌前端、导航入口和路由同步。
- [鉴权SSO与TokenBridge](docs/鉴权SSO与TokenBridge.md)：identity-center、OIDC、JWK、access token 与 postMessage bridge。
- [插件开发](docs/插件开发.md)：插件包、manifest、脚本、初始化和卸载。
- [市场系统](docs/市场系统.md)：市场 catalog、安装记录、下载缓存和各资源分区。
- [外部网站](docs/外部网站.md)：URL 网站入口、排序、Copilot 绑定和数据文件。
- [本地网站应用](docs/本地网站应用.md)：webapp 包结构、Node 后端、静态前端代理、运行状态。
- [智能助理集成](docs/智能助理集成.md)：agent-platform bridge、聊天、附件、quick/copilot。
- [桌宠系统](docs/桌宠系统.md)：桌宠设置、资产、窗口、状态和 agent 绑定。
- [看板与云同步](docs/看板与云同步.md)：本地 SQLite、云只读缓存、远端控制和 automation。
- [桌面协议与动作桥](docs/桌面协议与动作桥.md)：Desktop WebSocket、HTTP action bridge 和动作命名。
- [版本化打包与卸载](docs/版本化打包与卸载.md)：macOS/Windows 打包、env/demo 资源和卸载。
- [手工测试用例](docs/手工测试用例.md)：文档化手工回归路径。

## 7. 开发约束

- 平台差异必须显式区分 macOS / Windows，不依赖隐式 fallback。
- 文件系统和用户目录优先使用 Electron `app.getPath("home")`、`app.getPath("desktop")`、`app.getPath("appData")`。
- cloud Kanban issue 在 Desktop UI/runtime 中是只读缓存；运行状态同步继续使用 `run.event.append`。
- 真实 token、私钥、证书、`.env.local` 和本地配置不得提交。
