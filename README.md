# ZenMind Desktop

## 1. 项目概览

`zenmind-desktop` 是 ZenMind 的 Electron 应用壳，基于 Electron、React、Vite 和 TypeScript 构建。它负责把内置服务、插件、市场资源、网站入口、本地网页应用、智能助理和桌面协议能力组织成统一的桌面体验。

当前 Desktop 以 `manifest.json` 为服务发现和安装事实源：

- 内置服务从 `build/resources/services` 或打包后的 `resources/services` 自动发现。
- 插件统一通过 `.zip` 导入，安装到品牌隔离的平台程序数据目录。
- 桌面运行数据按品牌隔离在 `~/.zenmind/.desktop`、`~/.cutej/.desktop` 等目录。
- 渲染层 webview 直接访问服务或本地网页应用的 `webUrl`，需要认证的嵌入页通过 Desktop bridge 获取 token。

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

- Node.js 22.12.0 及以上
- npm 9 及以上
- macOS 12 及以上（arm64）或 Windows x64 开发环境
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

### 本地分享短链联调

本地联调复用正常配置与登录链路：在 `desktop-init.json` 或设置页中把 SSO 指向本地认证服务、启用 Tunnel 并填写本地 Loopback Relay，然后执行 `npm run dev` 并正常登录。登录生成的站点 Token 与 Tunnel 的 issuer、audience、公钥和 scope 必须一致。对话业务仍由常驻 Worker 从 Platform 冻结 Snapshot 与可用附件，公共分享模块上传已准备的通用信封和资源；本地 HTML 导出才读取模板并生成单文件。Main 使用 Identity 既有凭据与刷新链路直连 Tunnel，不接受命令行或环境变量提供的分享专用 Relay、Token 旁路。

对话、市场连接器及已发布 WebApp 共用发布、分享管理和撤销；每次创建独立保存内容，持续有效直到撤销。品牌短链接收只交给精确注册且上下文版本兼容的业务，首个市场动作是打开分享版本详情，不自动安装；历史版本无法确认时仅展示冻结资料。插件和 WebApp 的可选接收声明、隔离预览和在线服务绑定分别遵守各自领域边界，未安装或不可用时不进行安装恢复。新 Desktop 要求 Hub 支持通用分享 v2；旧 Hub 会明确提示升级，新 Hub 继续适配已发布 Desktop 的永久分享请求。

开发运行时允许从 Loopback WS Relay 派生 HTTP 分享 API；打包应用和非 Loopback 地址仍要求 TLS。

## 4. 目录结构

```text
.
├── brands/                 # 品牌配置、图标和文案
├── build/                  # 生成的品牌配置、资源和打包中间产物
├── contracts/              # 由源码生成的机器可读对外契约
├── docs/                   # 架构与专题设计文档
├── native/                 # 平台原生能力与构建输入
├── output/                 # 本地生成物与个人制作资源（不纳入版本控制）
├── qa/                     # 当前手工回归、验收脚本与可复用示例素材
├── scripts/                # 开发、同步、打包和验证脚本
├── src/
│   ├── main/               # Electron 主进程
│   ├── preload/            # webview / renderer preload
│   ├── renderer/           # React 渲染层
│   └── shared/             # main / preload / renderer 共享契约
├── test/                   # Node 测试
├── AGENTS.md
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
- [分享短链使用与对接](contracts/share-shortlink.md)：用户入口、Hub/网关、来源业务、插件/WebApp 接收与在线服务接入。
- [验收入口](qa/README.md)：当前 QA 材料、执行方式与维护范围。
- [手工回归清单](qa/manual-regression.md)：跨模块和用户可见工作流的发布验证。

## 7. 开发约束

- 平台差异必须显式区分 macOS / Windows，不依赖隐式 fallback。
- 文件系统和用户目录优先使用 Electron `app.getPath("home")`、`app.getPath("desktop")`、`app.getPath("appData")`。
- cloud Kanban issue 正文在 Desktop UI/runtime 中是只读缓存；Contract 1.0 仅允许受限原子操作，运行状态同步使用 `run.event.append`。
- 真实 token、私钥、证书、`.env.local` 和本地配置不得提交。

Platform TEAM 是普通 Agent mode，Desktop 请求、会话控制和 WebClient bridge 只使用根 agentKey；成员事件携带实际执行者身份，但不改变 Run owner。独立 Team 列表与旧身份字段已删除，需和 Platform、WebClient 同批发布。Kanban 组织团队标识不属于此协议。
