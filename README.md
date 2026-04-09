# zenmind-desktop

## 1. 项目简介
`zenmind-desktop` 是 ZenMind 的桌面端壳项目，基于 Electron、React 和 Vite 构建。它负责把内置服务打包进桌面应用，并提供统一的安装、配置、启动、停止、重启和日志查看入口。

当前仓库重点覆盖两类内置服务：
- `agent-container-hub`：宿主机容器服务，为后续智能体运行时提供沙箱能力。
- `zenmind-app-server`：认证与管理服务，提供 OAuth2/OIDC、管理后台和 App 访问令牌。
- `pan-webclient`：网盘服务，通过插件系统导入。

## 2. 快速开始
### 前置要求
- Node.js 18 及以上
- npm 9 及以上
- macOS arm64 开发环境
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
- `npm run sync:assets`：同步内置服务资源到 `build/resources/services`
- `npm run build:main`：编译 Electron 主进程与 preload
- `npm run build:renderer`：构建 React 渲染层

### 测试
```bash
npm test
```

测试会先执行完整构建，再运行 `test/*.test.mjs` 下的 Node 测试。

## 3. 配置说明
### 内置资源目录
- 开发环境默认从 `build/resources/services` 读取内置服务资源包。
- 打包后默认从应用资源目录下的 `services` 读取。
- 如需覆盖资源目录，可设置环境变量 `ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT`。

### 服务配置文件
- 服务安装后会写入用户数据目录下的 `services/<service-id>/<version>/`。
- 每个内置服务默认会从 `.env.example` 复制生成 `.env`，随后由桌面端进行读写。
- `pan-webclient` 还需要导入真实的 `local-public-key.pem` 才能满足启动前置条件。

### 敏感信息管理
- 真实密钥、证书和本地环境差异配置不提交到仓库。
- `.env.local`、编辑器配置和构建产物应由 `.gitignore` 管理。
- 示例配置应保留在随服务分发的模板文件中，不要把真实值写入文档。

## 4. 部署
### 桌面构建
```bash
npm run build
```

构建完成后，渲染层产物位于 `dist/`，Electron 主进程产物位于 `dist-electron/`。

### macOS 打包
```bash
npm run dist:mac
```

当前仓库的打包配置以 macOS arm64 为主，使用 `electron-builder` 输出 DMG 安装包。对外显示名称保持为 `ZenMind Desktop`。

### 打包资源约定
- `package.json` 中的 `build.files` 会打入桌面应用运行所需代码。
- `build.extraResources` 会把 `build/resources/services` 下的内置服务资源复制进应用包。
- 如新增内置服务，需先补齐资源同步逻辑和服务注册，再执行打包。

## 5. 运维
### 常用命令
```bash
npm run sync:assets
npm run dev
npm run build
npm test
```

### 日志与运行状态
- 桌面端通过主进程统一管理服务运行状态。
- 每个服务都会维护 PID 文件和日志文件路径，并在控制中心中展示。
- 服务实际安装目录位于 Electron `userData` 目录下的 `services/<service-id>/<version>/`。

### 常见排查
- 启动失败时，先检查控制中心展示的状态文案、日志文件路径和 PID 文件路径。
- `agent-container-hub` 无法启动时，优先检查 Docker 或 Podman 是否可用。
- `pan-webclient` 无法启动时，优先确认 `.env` 已生成且 `local-public-key.pem` 已导入。
- 密钥对可通过控制中心从认证服务（zenmind-app-server）自动导出并分发给 pan-webclient。
- 若测试失败，请先确认 `build/resources/services` 中的内置资源已同步完成。
