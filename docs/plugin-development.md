# 插件开发指南

## 插件包结构

插件以 `.tar.gz` 格式分发，解压后应包含单个顶层目录：

```
my-plugin/
  plugin-manifest.json    # 必须 — 插件清单
  start.sh                # 启动脚本
  stop.sh                 # 停止脚本
  .env.example            # 配置模板（可选）
  my-binary               # 服务可执行文件（可选）
  frontend/dist/          # 前端构建产物（可选，有则为"服务+前端"类型）
```

## plugin-manifest.json 规范

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "v1.0.0",
  "description": "插件描述",
  "hasFrontend": true,
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
    "startCommand": ["./start.sh"],
    "stopCommand": ["./stop.sh"]
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
| `version` | ✅ | 版本号 |
| `description` | ✅ | 描述文字 |
| `hasFrontend` | ✅ | `true` = 服务+前端类型，`false` = 纯服务类型 |
| `configFiles` | ❌ | 配置文件列表 |
| `runtime` | ✅ | 运行时配置（PID/日志路径、启停命令） |
| `web` | ❌ | 有前端时必填，定义端口和路由 |

## 两种插件类型

### 纯服务类型 (`hasFrontend: false`)
- 注册后在控制中心左侧边栏显示服务卡片
- 点击可查看服务详情、启停、配置

### 服务+前端类型 (`hasFrontend: true`)
- 同样在控制中心显示服务卡片
- 服务运行后，详情区域出现"打开前端"按钮
- 顶部导航栏自动添加入口
- 前端通过 iframe 加载 `http://127.0.0.1:{port}{routePath}`

## 安装方式

在控制中心页面点击"安装插件"按钮，选择 `.tar.gz` 包即可。

## 打包示例

```bash
tar -czf my-plugin-v1.0.0-darwin-arm64.tar.gz my-plugin/
```
