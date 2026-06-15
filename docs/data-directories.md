# ZenMind Desktop 数据目录

ZenMind Desktop 会把本机运行数据保存在分层的桌面端数据根目录中。运行根目录按品牌 id 派生：`BRAND=zenmind` 使用 `.zenmind`，`BRAND=cutej` 使用 `.cutej`。根目录按平台区分，例如 ZenMind 默认品牌为：

- macOS：`~/.zenmind/.desktop/`
- Windows：`%USERPROFILE%\.zenmind\.desktop\`

CuteJ 品牌对应：

- macOS：`~/.cutej/.desktop/`
- Windows：`%USERPROFILE%\.cutej\.desktop\`

服务和插件的程序文件不存放在这个目录中，而是安装到平台应用支持目录：

- macOS：`~/Library/Application Support/ZenMind/`
- Windows：`%APPDATA%\ZenMind\`

## 目录结构

```text
~/<brand-runtime-root>/
├── desktop-init.json
├── provider-register.json
└── .desktop/
    ├── config/
    │   └── desktop/
    │       ├── profile.json
    │       ├── pet.json
    │       ├── sso.json
    │       └── control.json
    ├── data/
    │   ├── pets/
    │   │   └── <pet-id>/
    │   │       ├── pet.json
    │   │       └── ...
    │   ├── websites/
    │   │   └── <website-id>/
    │   │       ├── website.json
    │   │       ├── frontend/
    │   │       ├── backend/
    │   │       └── icon.png
    │   ├── env-initial/
    │   │   ├── env.zip
    │   │   └── manifest.json
    │   ├── services/
    │   └── plugins/
    ├── state/
    │   ├── desktop/
    │   │   ├── bootstrap.json
    │   │   ├── env-bootstrap.json
    │   │   ├── pet-state.json
    │   │   └── sso-session.json
    │   └── websites/
    │       └── <website-id>/
    │           └── runtime.json
    └── logs/
        └── websites/
            └── <website-id>/
                ├── main.log
                └── error.log
```

完整 Desktop 数据根目录还包含服务、插件、日志、缓存、凭据和浏览器 profile：

```text
~/<brand-runtime-root>/.desktop/
├── config/
│   ├── desktop/
│   │   ├── profile.json
│   │   ├── pet.json
│   │   ├── sso.json
│   │   └── control.json
│   ├── websites/
│   │   └── order.json
│   ├── services/
│   │   └── <service-id>/
│   │       └── .env
│   ├── plugins/
│   │   └── <plugin-id>/
│   │       └── .env
│   └── marketplace/
│       └── settings.json
├── data/
│   ├── pets/
│   │   └── <pet-id>/
│   ├── websites/
│   │   └── <website-id>/
│   │       ├── website.json
│   │       ├── frontend/
│   │       └── backend/
│   ├── env-initial/
│   │   ├── env.zip
│   │   └── manifest.json
│   ├── services/
│   │   └── <service-id>/
│   └── plugins/
│       └── <plugin-id>/
├── state/
│   ├── desktop/
│   │   ├── bootstrap.json
│   │   ├── env-bootstrap.json
│   │   ├── last-running-services.json
│   │   ├── pet-state.json
│   │   └── sso-session.json
│   ├── services/
│   │   └── <service-id>/
│   │       ├── init-state.json
│   │       └── pid/
│   ├── plugins/
│   │   └── <plugin-id>/
│   │       ├── init-state.json
│   │       └── pid/
│   ├── websites/
│   │   └── <website-id>/
│   │       └── runtime.json
│   └── marketplace/
├── logs/
│   ├── services/
│   │   └── <service-id>/
│   ├── plugins/
│   │   └── <plugin-id>/
│   └── websites/
│       └── <website-id>/
│           ├── main.log
│           └── error.log
├── cache/
│   └── marketplace/
├── secrets/
│   └── pan-private-key.pem
└── profiles/
    └── electron/
```

## 分层职责

| 目录 | 用途 |
| --- | --- |
| `config/` | 用户可编辑或 Desktop 管理的配置。 |
| `data/` | 用户内容和资产，以及服务/插件持久化运行数据，例如用户导入 pet、网站入口、初始 env.zip 留档、数据库、生成的密钥、业务数据文件。 |
| `state/` | 可由应用重建或更新的运行状态，例如初始化状态、PID 文件、SSO 会话状态、启动恢复状态。 |
| `logs/` | 服务、插件和本地网站小应用日志。 |
| `cache/` | 可重建缓存，目前包含 marketplace 缓存。 |
| `secrets/` | Desktop 管理的本地凭据和私钥。 |
| `profiles/` | Electron 和 Chromium 的浏览器配置数据。 |

## 关键文件

- `~/<brand-runtime-root>/desktop-init.json`：env 包携带的一次性初始化模板。首启拆写到 `.desktop/` 下的 canonical 文件并记录 `state/desktop/bootstrap.json` 后会删除运行时副本，后续不再作为运行时真相；可用 `kanban.enabled: false` 首启隐藏看板入口。
- `~/<brand-runtime-root>/provider-register.json`：一次性 registration token 文件，用完后清 token 或删除，不合并进 profile。
- `config/desktop/profile.json`：保存长期用户偏好，包括外观、语言、Copilot/Quick 助手默认值和导航偏好。
- `config/desktop/pet.json`：保存桌宠设置，包括 enabled、selectedPetId、position 和窗口偏好；不保存 `boundAgentKey`。
- `config/desktop/sso.json`：保存 Desktop SSO 登录配置。session/token 进入 `state/desktop/`。
- `config/desktop/control.json`：保存控制类设置，目前包含 task board 远端控制配置。
- `data/pets/<pet-id>/pet.json`：用户导入 pet 的资产描述。内置 pet 使用 `builtin:<id>` 指向应用内置资源，用户 pet 使用 `user:<pet-id>` 指向该目录。
- `config/webs/order.json`：网站/网站应用侧边栏排序 canonical 文件，条目使用 `website:<id>` 或 `webapp:<id>` entryKey。
- `data/webs/websites/<website-id>/website.json`：外部 URL 网站 manifest。
- `data/webs/webapps/<webapp-id>/webapp.json`：本地网站应用 manifest 和资产目录。
- `data/env-initial/env.zip`：首个导入或内置的 env.zip 留档。
- `data/env-initial/manifest.json`：记录 env.zip 来源、版本、sha256、大小和留档时间。
- `config/services/<service-id>/.env`：保存从服务模板复制或派生出的服务配置。
- `config/plugins/<plugin-id>/.env`：保存从插件模板复制或派生出的插件配置。
- `state/desktop/last-running-services.json`：保存下次启动时需要恢复的服务列表。
- `state/desktop/bootstrap.json`：记录 `desktop-init.json` 的一次性应用结果，包括初始化 `assistant`。
- `state/desktop/env-bootstrap.json`：记录 env.zip 实际导入结果，并指向 `data/env-initial/` 留档。
- `state/desktop/pet-state.json`：保存桌宠运行状态，例如 unreadCount。
- `state/desktop/sso-session.json`：保存 Desktop SSO 会话状态。
- `state/services/<service-id>/init-state.json`：保存服务初始化状态。
- `state/plugins/<plugin-id>/init-state.json`：保存插件初始化状态。
- `state/webs/webapps/<webapp-id>/runtime.json`：保存本地网站应用最近一次运行状态、端口、URL 和 PID。
- `logs/webs/webapps/<webapp-id>/main.log`：本地网站应用后端标准输出。
- `logs/webs/webapps/<webapp-id>/error.log`：本地网站应用后端错误输出和启动/停止错误。
- `secrets/pan-private-key.pem`：保存 Desktop 管理的 pan-webclient RSA 私钥。
- `profiles/electron/`：保存 Electron `userData` profile，包括 Chromium cookie、localStorage、webview session 数据、浏览器缓存等。

## 内嵌网站与网站应用存储

内嵌网站入口和本地网站应用归入内部 `webs` 域，并拆成两个子目录。外部 URL 网站只写 `data/webs/websites/<website-id>/website.json`；本地网站应用写 `data/webs/webapps/<webapp-id>/webapp.json`，并在同一目录携带前端、Node 后端和静态资产：

```text
~/<brand-runtime-root>/.desktop/data/webs/
├── websites/
│   └── docs/
│       ├── website.json
│       └── icon.png
└── webapps/
    └── demo-node-html/
        ├── webapp.json
        ├── frontend/
        │   ├── index.html
        │   └── app.js
        └── backend/
            └── server.mjs
```

外部 URL 网站使用 schema v1：

```json
{
  "schemaVersion": 1,
  "id": "docs",
  "kind": "website",
  "label": "Docs",
  "url": "https://docs.example.com/",
  "agentKey": "desktopAssistant",
  "createdAt": "2026-06-10T00:00:00.000Z",
  "updatedAt": "2026-06-10T00:00:00.000Z"
}
```

本地网站应用使用 schema v1：

```json
{
  "schemaVersion": 1,
  "id": "demo-node-html",
  "kind": "webapp",
  "label": "Demo App",
  "frontend": {
    "root": "frontend",
    "index": "index.html",
    "spa": true,
    "apiPrefix": "/api"
  },
  "backend": {
    "runtime": "node",
    "entry": "backend/server.mjs",
    "args": [],
    "env": {},
    "port": 0,
    "healthPath": "/api/health"
  },
  "agentKey": "desktopAssistant"
}
```

Desktop 点击本地网站应用入口时按需启动 Node 后端和本地前端 server。`backend.port: 0` 表示自动分配空闲端口；后端进程会收到 `PORT`、`HOST=127.0.0.1`、`WEBAPP_ID`、`WEBAPP_ROOT`、`WEBAPP_STATE_DIR` 和 `WEBAPP_LOG_DIR`。前端 server 绑定 `127.0.0.1`，并把 `frontend.apiPrefix` 下的请求代理到同一个应用的后端。

Manifest 中的路径必须是项目目录内的相对路径。Desktop 会拒绝绝对路径、`..`、隐藏逃逸、symlink 逃逸和非 `node` 后端 runtime。运行状态和日志分别写入：

```text
~/<brand-runtime-root>/.desktop/state/webs/webapps/<webapp-id>/runtime.json
~/<brand-runtime-root>/.desktop/logs/webs/webapps/<webapp-id>/main.log
~/<brand-runtime-root>/.desktop/logs/webs/webapps/<webapp-id>/error.log
```

打包时设置 `DEMO=1` 或 `DEMO=true` 后，内置 `demo-node-html` 模板会在启动时复制到 `data/webs/webapps/demo-node-html/`；目标已存在时按安装包内模板强制刷新。未设置 `DEMO` 时安装包不包含 demo，启动时也不会创建 demo 网站应用。旧 `data/websites/`、`config/websites/order.json`、`state/websites/`、`logs/websites/` 和 `config/desktop/custom-sidebar-items.json` 只作为一次性迁移来源，迁移记录写入 `state/webs/migration.json`，旧目录保留为备份。网站自身的浏览器数据不保存在 manifest 中。cookie、localStorage、IndexedDB、webview session 数据和缓存由 Electron/Chromium 管理，位于：

```text
~/<brand-runtime-root>/.desktop/profiles/electron/
```

## 程序安装目录

桌面端数据根目录不存放服务或插件程序包。程序文件位于 Application Support：

```text
~/Library/Application Support/ZenMind/
├── services/
│   └── <service-id>/<version>/
└── plugins/
    └── <plugin-id>/<version>/
```

Windows 使用相同分层，根目录为：

```text
%APPDATA%\ZenMind\
├── services\
│   └── <service-id>\<version>\
└── plugins\
    └── <plugin-id>\<version>\
```
