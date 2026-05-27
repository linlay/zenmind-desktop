# ZenMind Desktop 数据目录

ZenMind Desktop 会把本机运行数据保存在分层的桌面端数据根目录中。根目录按平台区分：

- macOS：`~/.zenmind/.desktop/`
- Windows：`%USERPROFILE%\.zenmind\.desktop\`

服务和插件的程序文件不存放在这个目录中，而是安装到平台应用支持目录：

- macOS：`~/Library/Application Support/ZenMind/`
- Windows：`%APPDATA%\ZenMind\`

## 目录结构

```text
~/.zenmind/.desktop/
├── config/
│   ├── desktop/
│   │   ├── custom-sidebar-items.json
│   │   ├── desktop-pet.json
│   │   ├── preferences.json
│   │   └── settings.json
│   ├── services/
│   │   └── <service-id>/
│   │       └── .env
│   ├── plugins/
│   │   └── <plugin-id>/
│   │       └── .env
│   └── marketplace/
│       └── settings.json
├── data/
│   ├── services/
│   │   └── <service-id>/
│   └── plugins/
│       └── <plugin-id>/
├── state/
│   ├── desktop/
│   │   ├── last-running-services.json
│   │   └── desktop-sso-session.json
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
| `data/` | 服务和插件的持久化运行数据，例如数据库、生成的密钥、业务数据文件。 |
| `state/` | 可由应用重建或更新的运行状态，例如初始化状态、PID 文件、SSO 会话状态、启动恢复状态。 |
| `logs/` | 服务和插件日志。 |
| `cache/` | 可重建缓存，目前包含 marketplace 缓存。 |
| `secrets/` | Desktop 管理的本地凭据和私钥。 |
| `profiles/` | Electron 和 Chromium 的浏览器配置数据。 |

## 关键文件

- `config/desktop/custom-sidebar-items.json`：保存侧边栏“内嵌网站”分组中的自定义网站入口。
- `config/desktop/desktop-pet.json`：保存桌宠设置。
- `config/desktop/preferences.json`：保存桌面端语言和偏好设置。
- `config/desktop/settings.json`：保存助手和 Desktop Copilot 设置。
- `config/services/<service-id>/.env`：保存从服务模板复制或派生出的服务配置。
- `config/plugins/<plugin-id>/.env`：保存从插件模板复制或派生出的插件配置。
- `state/desktop/last-running-services.json`：保存下次启动时需要恢复的服务列表。
- `state/desktop/desktop-sso-session.json`：保存 Desktop SSO 会话状态。
- `state/services/<service-id>/init-state.json`：保存服务初始化状态。
- `state/plugins/<plugin-id>/init-state.json`：保存插件初始化状态。
- `secrets/pan-private-key.pem`：保存 Desktop 管理的 pan-webclient RSA 私钥。
- `profiles/electron/`：保存 Electron `userData` profile，包括 Chromium cookie、localStorage、webview session 数据、浏览器缓存等。

## 内嵌网站存储

内嵌网站入口以 JSON 列表形式保存在：

```text
~/.zenmind/.desktop/config/desktop/custom-sidebar-items.json
```

文件结构如下：

```json
{
  "items": [
    {
      "id": "custom-...",
      "label": "网站名称",
      "url": "https://example.com/",
      "iconId": "custom-...",
      "agentKey": "optional-agent-key",
      "createdAt": 1710000000000,
      "updatedAt": 1710000000000
    }
  ]
}
```

网站自身的浏览器数据不保存在这个 JSON 文件中。cookie、localStorage、IndexedDB、webview session 数据和缓存由 Electron/Chromium 管理，位于：

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
