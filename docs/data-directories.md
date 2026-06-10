# ZenMind Desktop 数据目录

ZenMind Desktop 会把本机运行数据保存在分层的桌面端数据根目录中。根目录按平台区分：

- macOS：`~/.zenmind/.desktop/`
- Windows：`%USERPROFILE%\.zenmind\.desktop\`

服务和插件的程序文件不存放在这个目录中，而是安装到平台应用支持目录：

- macOS：`~/Library/Application Support/ZenMind/`
- Windows：`%APPDATA%\ZenMind\`

## 目录结构

```text
~/.zenmind/
├── desktop-default.json
├── desktop-register.json
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
    │   │       └── icon.png
    │   ├── env-initial/
    │   │   ├── env.zip
    │   │   └── manifest.json
    │   ├── services/
    │   └── plugins/
    └── state/
        └── desktop/
            ├── bootstrap.json
            ├── env-bootstrap.json
            ├── pet-state.json
            └── sso-session.json
```

完整 Desktop 数据根目录还包含服务、插件、日志、缓存、凭据和浏览器 profile：

```text
~/.zenmind/.desktop/
├── config/
│   ├── desktop/
│   │   ├── profile.json
│   │   ├── pet.json
│   │   ├── sso.json
│   │   └── control.json
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
│   └── marketplace/
├── logs/
│   ├── services/
│   │   └── <service-id>/
│   └── plugins/
│       └── <plugin-id>/
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
| `logs/` | 服务和插件日志。 |
| `cache/` | 可重建缓存，目前包含 marketplace 缓存。 |
| `secrets/` | Desktop 管理的本地凭据和私钥。 |
| `profiles/` | Electron 和 Chromium 的浏览器配置数据。 |

## 关键文件

- `~/.zenmind/desktop-default.json`：env 包携带的初始化模板。首启拆写到 `.desktop/` 下的 canonical 文件后不再作为运行时真相。
- `~/.zenmind/desktop-register.json`：一次性 registration token 文件，用完后清 token 或删除，不合并进 profile。
- `config/desktop/profile.json`：保存长期用户偏好，包括外观、语言、助手默认值、Quick Assistant 和导航偏好。
- `config/desktop/pet.json`：保存桌宠设置，包括 enabled、selectedPetId、lastVisible、position 和窗口偏好；不保存 `boundAgentKey`。
- `config/desktop/sso.json`：保存 Desktop SSO 登录配置。session/token 进入 `state/desktop/`。
- `config/desktop/control.json`：保存控制类设置，目前包含 task board 远端控制配置。
- `data/pets/<pet-id>/pet.json`：用户导入 pet 的资产描述。内置 pet 使用 `builtin:<id>` 指向应用内置资源，用户 pet 使用 `user:<pet-id>` 指向该目录。
- `data/websites/<website-id>/website.json`：每个网站一个目录，保存 label、url、agentKey、创建/更新时间等入口信息。
- `data/env-initial/env.zip`：首个导入或内置的 env.zip 留档。
- `data/env-initial/manifest.json`：记录 env.zip 来源、版本、sha256、大小和留档时间。
- `config/services/<service-id>/.env`：保存从服务模板复制或派生出的服务配置。
- `config/plugins/<plugin-id>/.env`：保存从插件模板复制或派生出的插件配置。
- `state/desktop/last-running-services.json`：保存下次启动时需要恢复的服务列表。
- `state/desktop/bootstrap.json`：记录 `desktop-default.json` 的一次性应用结果，包括 bootstrapAssistant。
- `state/desktop/env-bootstrap.json`：记录 env.zip 实际导入结果，并指向 `data/env-initial/` 留档。
- `state/desktop/pet-state.json`：保存桌宠运行状态，例如 unreadCount。
- `state/desktop/sso-session.json`：保存 Desktop SSO 会话状态。
- `state/services/<service-id>/init-state.json`：保存服务初始化状态。
- `state/plugins/<plugin-id>/init-state.json`：保存插件初始化状态。
- `secrets/pan-private-key.pem`：保存 Desktop 管理的 pan-webclient RSA 私钥。
- `profiles/electron/`：保存 Electron `userData` profile，包括 Chromium cookie、localStorage、webview session 数据、浏览器缓存等。

## 内嵌网站存储

内嵌网站入口按网站拆分到 `data/websites/`，一个网站一个目录：

```text
~/.zenmind/.desktop/data/websites/
└── docs/
    ├── website.json
    └── icon.png
```

文件结构如下：

```json
{
  "schemaVersion": 1,
  "id": "docs",
  "label": "Docs",
  "url": "https://docs.example.com/",
  "agentKey": "desktopAssistant",
  "createdAt": "2026-06-10T00:00:00.000Z",
  "updatedAt": "2026-06-10T00:00:00.000Z"
}
```

旧 `config/desktop/custom-sidebar-items.json` 会在首次读取时迁移到新目录。网站自身的浏览器数据不保存在 `website.json` 中。cookie、localStorage、IndexedDB、webview session 数据和缓存由 Electron/Chromium 管理，位于：

```text
~/.zenmind/.desktop/profiles/electron/
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
