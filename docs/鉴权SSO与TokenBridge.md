# 鉴权SSO与TokenBridge

## 当前状态

Desktop 以 `identity-center` 为本地认证基础。主进程负责 bootstrap JWK/public key、签发 App access token、处理 Desktop SSO 会话，并通过 webview bridge 把 token 安全交给需要认证的嵌入页。

`agent-webclient` 是当前明确接入 postMessage token bridge 的服务。

## 核心流程

```text
identity-center prepare
  -> ensureIdentityCenterJwk()
  -> Desktop capability auth.accessToken
  -> issueAgentAccessToken()
  -> PluginPage / service-webview preload
  -> agent-webclient postMessage request
  -> desktop:agent-auth:response
```

OIDC SSO：

```text
config/desktop/sso.json
  -> OIDC start
  -> local callback server
  -> token exchange / user info / cookies
  -> state/desktop/sso-session.json
  -> secrets/sso-site-token.json
```

Tunnel Hub 注册只使用由 `siteTokenBridge` 换取的 `sso-site-token.json`；普通 Desktop 登录写入的 `state/desktop/sso-access-token.txt` 不参与 Tunnel 注册。

`siteTokenBridge` 的打开方式跟随顶层 `sso.browserMode`：`system` 使用系统浏览器，`embedded` 使用 Desktop SSO WebView 与同一 SSO partition。嵌入式 cookie 登录完成后也会继续启动 `siteTokenBridge`，但 Desktop 不根据 brand 做任何分支。

Desktop WebSocket 鉴权：

- token 可来自 query `token` 或 WebSocket subprotocol。
- JWT 必须是 RS256。
- `scope` 必须是 `app`。
- `device_id` 必须匹配当前 Desktop 安装级 device id。

## 配置与接口

关键文件：

- `config/desktop/sso.json`：SSO 配置。
- `state/desktop/sso-session.json`：SSO 会话状态。
- `secrets/sso-site-token.json`：站点 token。
- `config/services/identity-center/.env`：identity-center 配置。

Token bridge 类型：

- request：`desktop:agent-auth:request`。
- response：`desktop:agent-auth:response`，同时携带 `token` 和可选 `desktopAuthContext`。
- storage key：`agent-webclient.appAccessToken`、`agent-webclient.appAuthContext`。
- 当前文档上下文：`window.__AGENT_APP_AUTH_CONTEXT`。

## 约束与注意事项

- Desktop 本地凭据写入 `secrets/` 或 `state/`，不要进入 `config/` 文档示例。
- `identity-center` 是 token 签发与校验基础，不进入 webview bridge 协议名称；嵌入页只依赖 Desktop agent auth bridge。
- token cache 会根据 JWT `exp` 和刷新原因复用或失效；`unauthorized` 会强制丢弃缓存。JWT 原始 `iat`/`exp` 仅在解码和校验内部按 Unix 秒处理；需要进入 shared contract 的具体时间点必须转换为 `EpochMilliseconds`，详见[时间契约](时间契约.md)。
- Desktop 先应用 `desktopAuthContext`、清理不匹配的旧 token，再写入响应 token；该上下文不再通过 agent-webclient URL 传递。
- Windows 身份脚本走 PowerShell，macOS / Linux 优先走 `.sh`，需要显式平台分支。
- webview 内页面只能通过 bridge 获取 token，不直接访问主进程 API。

## 相关文件

- `src/main/identity-center-auth.ts`
- `src/main/agent-auth.ts`
- `src/main/oidc-sso.ts`
- `src/main/sso-site-token.ts`
- `src/main/device-identity.ts`
- `src/shared/auth-bridge.ts`
- `src/preload/service-webview-main-world.ts`
- `test/oidc-sso.test.mjs`
- `test/agent-webclient-auth-injection.test.mjs`
