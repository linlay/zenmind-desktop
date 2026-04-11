# 插件开发指南

## 插件包结构

插件以 `.tar.gz` 格式分发，解压后应包含单个顶层目录：

```text
my-plugin/
  manifest.json           # 必须 — 插件清单
  start.sh                # 启动脚本
  stop.sh                 # 停止脚本
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

兼容性说明：
- Desktop 不再扫描 `plugin-manifest.json`。
- 如 `manifest.json` 中仍保留旧字段 `frontendMode` / `hasFrontend` / `runtime.startCommand`，当前会做兼容映射，但不建议继续使用。

## 三种插件类型

### 无前端 (`frontend.mode: "none"`)
- 注册后在控制中心左侧边栏显示服务卡片。
- 点击可查看服务详情、启停、配置。

### 内嵌前端 (`frontend.mode: "embedded"`)
- 同样在控制中心显示服务卡片。
- 服务运行后，详情区域出现“打开前端”按钮。
- 不会出现在顶部导航栏。
- 前端由服务自身进程直接提供，Desktop iframe 直接访问 `web.routePath`。

### 独立前端 (`frontend.mode: "standalone"`)
- 同样在控制中心显示服务卡片。
- 服务运行后，详情区域出现“打开前端”按钮。
- 顶部导航栏自动添加入口。
- 前端由服务自身进程直接提供，Desktop iframe 直接访问 `healthMeta.webUrl`。

## 安装方式

在控制中心页面点击“安装插件”按钮，选择 `.tar.gz` 包即可。

## 打包示例

```bash
tar -czf my-plugin-v1.0.0-darwin-arm64.tar.gz my-plugin/
```
