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

需要重新构建并同步四个内置服务时，macOS/Linux 使用 `scripts/build-builtin-services.sh`，Windows 使用 `scripts/build-builtin-services.ps1`；普通开发与发布只校验已经同步的资源。

## 4. 目录结构

```text
.
├── brands/                 # 品牌配置、图标和文案
├── build/                  # 生成的品牌配置、资源和打包中间产物
├── contracts/              # 由源码生成的机器可读对外契约
├── docs/                   # 架构与专题设计文档
├── qa/                     # 手工回归清单
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

- [设计文档总览](docs/README.md)：文档边界、事实源分工、阅读路径与全部专题索引。
- [手工回归清单](qa/manual-regression.md)：跨模块和用户可见工作流的发布验证。

## 7. 开发约束

- 平台差异必须显式区分 macOS / Windows，不依赖隐式 fallback。
- 文件系统和用户目录优先使用 Electron `app.getPath("home")`、`app.getPath("desktop")`、`app.getPath("appData")`。
- cloud Kanban issue 正文在 Desktop UI/runtime 中是只读缓存；Contract 1.0 仅允许受限原子操作，运行状态同步使用 `run.event.append`。
- 真实 token、私钥、证书、`.env.local` 和本地配置不得提交。
