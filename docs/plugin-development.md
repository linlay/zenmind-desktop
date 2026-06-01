# 插件开发指南

## 插件包结构

插件按平台分发：
- macOS / Linux 使用 `.tar.gz`
- Windows 使用 `.zip`

两种格式解压后都应包含单个顶层目录，内部目录结构保持一致：

```text
my-plugin/
  manifest.json           # 必须 — 插件清单
  start.sh|start.ps1      # 启动脚本
  stop.sh|stop.ps1        # 停止脚本
  .env.example            # 配置模板（可选）
  my-binary               # 服务可执行文件（可选）
  frontend/dist/          # 前端构建产物（可选，frontend.mode != "none" 时需要）
```

不再需要 `frontend.toml`。前端静态资源和 API 都应由插件自身服务进程在自己的监听端口上直接提供。

## manifest.json 规范

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "kind": "plugin",
  "version": "v1.0.0",
  "description": "插件描述",
  "frontend": {
    "mode": "standalone",
    "entry": "/",
    "directAccess": true,
    "hostManaged": false
  },
  "backend": {
    "entry": "my-binary"
  },
  "scripts": {
    "start": "start.sh",
    "stop": "stop.sh"
  },
  "configFiles": [
    {
      "key": "env",
      "label": ".env",
      "relativePath": ".env",
      "templateRelativePath": ".env.example",
      "required": true
    }
  ],
  "runtime": {
    "pidRelativePath": ".runtime/my-plugin.pid",
    "logRelativePath": ".runtime/my-plugin.log",
    "errorLogRelativePath": ".runtime/my-plugin.stderr.log",
    "requiredPaths": [
      "my-binary",
      "start.sh",
      "stop.sh",
      ".env.example",
      "manifest.json"
    ]
  },
  "web": {
    "routePath": "/",
    "portEnvKey": "PORT",
    "defaultPort": 9000
  }
}
```

## 字段说明

| 字段 | 必须 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一标识，用作目录名和路由参数 |
| `name` | ✅ | 显示名称 |
| `kind` | ✅ | 固定为 `plugin` |
| `version` | ✅ | 版本号 |
| `description` | ✅ | 描述文字 |
| `frontend.mode` | ✅ | `none` / `embedded` / `standalone` |
| `scripts.start` / `scripts.stop` | ✅ | 启停脚本入口 |
| `configFiles` | ❌ | 配置文件列表 |
| `runtime` | ✅ | 运行时元数据（PID/日志路径、bundle 完整性校验项） |
| `web` | ❌ | `frontend.mode != "none"` 时通常需要，定义端口和路由 |
| `desktop` | ❌ | Desktop 专用扩展字段，插件通常只需要 `bundleTopLevelDir` |

`runtime.errorLogRelativePath` 是可选字段，用于声明独立 stderr 文件路径；如果插件把 stderr 合并进主日志，可省略该字段。

脚本约定：
- macOS / Linux 插件使用 `.sh` 脚本，例如 `start.sh`、`stop.sh`、`deploy.sh`
- Windows 插件使用 `.ps1` 脚本，例如 `start.ps1`、`stop.ps1`、`deploy.ps1`
- `manifest.json` 中的 `scripts.start`、`scripts.stop`、`scripts.deploy` 应与对应平台脚本文件名保持一致
- `scripts.deploy` 会被 Desktop 作为“初始化”钩子执行；脚本需要幂等，能够安全重复运行
- 插件后端如需设备标识，应读取启动环境变量 `DESKTOP_DEVICE_ID`。该值由 Desktop 生成并代表当前 Desktop 安装级 UUID，插件不应自行生成另一套 device id。

认证说明：
- 需要认证的 webview 插件通过 Desktop Token Bridge 获取 JWT 后，可从 JWT payload 的 `device_id` 读取同一个安装级设备标识。
- 第一版不会向不走认证的纯前端插件额外暴露 device id bridge；这类插件如需设备标识，应通过自己的后端读取 `DESKTOP_DEVICE_ID` 后再提供给前端。

兼容性说明：
- Desktop 不再扫描 `plugin-manifest.json`。
- 如 `manifest.json` 中仍保留旧字段 `frontendMode` / `hasFrontend` / `runtime.startCommand`，当前会做兼容映射，但不建议继续使用。

## 三种插件类型

### 无前端 (`frontend.mode: "none"`)
- 注册后在控制中心左侧边栏显示服务卡片。
- 导入后先进入“待初始化”，完成初始化后才可正常启停、配置。

### 内嵌前端 (`frontend.mode: "embedded"`)
- 同样在控制中心显示服务卡片。
- 服务运行后，详情区域出现“打开前端”按钮。
- 不会出现在顶部导航栏。
- 前端由服务自身进程直接提供，Desktop webview 直接访问 `web.routePath`。

### 独立前端 (`frontend.mode: "standalone"`)
- 同样在控制中心显示服务卡片。
- 服务运行后，详情区域出现“打开前端”按钮。
- 顶部导航栏自动添加入口。
- 前端由服务自身进程直接提供，Desktop webview 直接访问 `healthMeta.webUrl`。

## 安装方式

Desktop 按平台只接受对应格式的插件包：
- Desktop macOS / Linux 版只接受 `.tar.gz`
- Desktop Windows 版只接受 `.zip`

导入与初始化分为两步：
1. 在控制中心点击“导入插件”，选择平台对应的插件包。
2. Desktop 解压并注册插件，服务卡片进入“待初始化”状态。
3. 用户按需修改从模板回填的配置后，点击“初始化”。
4. Desktop 会补齐缺失配置文件、修复脚本权限并执行 `scripts.deploy`。

## 打包示例

```bash
tar -czf my-plugin-v1.0.0-darwin-arm64.tar.gz my-plugin/
```

```powershell
Compress-Archive -Path .\my-plugin -DestinationPath .\my-plugin-v1.0.0-windows-amd64.zip -Force
```

命名规范：
- `<id>-<version>-darwin-<arch>.tar.gz`
- `<id>-<version>-linux-<arch>.tar.gz`
- `<id>-<version>-windows-<arch>.zip`
