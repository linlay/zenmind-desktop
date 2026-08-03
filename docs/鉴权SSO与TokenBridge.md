# 鉴权SSO与TokenBridge

## 当前状态

Desktop 以 `identity-center` 为本地认证基础。主进程负责 bootstrap JWK/public key、签发 App access token、处理 Desktop SSO 会话，并通过 webview bridge 把 token 安全交给需要认证的嵌入页。

`agent-webclient` 是当前明确接入 postMessage token bridge 的服务。

企业聊天不使用 webview token bridge。主进程把 canonical SSO access token 直接提交给
`zenmind-im-server /api/v1/session/exchange`，换取只保存在内存中的短期 IM session token，
再申请一次性 WebSocket ticket。renderer 不接触上述三类凭据。

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

官网 Server Broker SSO：

```text
config/desktop/sso.json
  -> 官网 desktop-sso/start
  -> local callback server
  -> one-time ticket -> 官网 HttpOnly Cookie
  -> Cookie + CSRF -> 单个 12 小时 JWT
  -> state/desktop/sso-access-token.txt
  -> 同一 JWT 兼容写入 secrets/sso-site-token.json
```

企业聊天：

```text
state/desktop/sso-access-token.txt
  -> main enterprise chat runtime
  -> IM session exchange
  -> short-lived token + one-time WS ticket
  -> sync.resume / direct messages
```

嵌入式 Cookie SSO 按同一文件协议分步完成：

```text
loginCompletionUrls 命中
  -> browserSession Cookie 校验成功 -> sso-session.json
  -> 已验证响应头取得稳定用户 ID -> sso-user-info.json
  -> cookie userInfo 可选增强用户资料
  -> cookieAccessTokenExchange 成功 -> sso-access-token.txt
```

三个文件互不代写。后一步失败只更新运行时的 warning/error，不删除本次已经成功的文件；因此 access token 交换返回 401 时，Desktop 仍保持浏览器登录态和已经取得的用户信息。新 session 验证成功后才清理上一 session 的下游 user-info/access-token，避免不同账号的数据混用。标准 OIDC 从验证后的 ID token 先写基础 user-info，Bearer userinfo 成功时再增强该文件。

session 验证成功后 `authenticated=true`，但当前登录尝试继续保持 `pending=true`。userinfo 与 access token 两步都尝试结束后才统一 finalize；三步全成功时登录 WebView 自动关闭，部分成功或失败时 WebView 被逐项结果面板替换，由用户选择关闭或重试。Cookie SSO 的基础用户信息来自同一次已验证 `/oauth2/auth` 响应中配置的 `userInfoHeaders`：`sub`（稳定用户 ID）是唯一必需字段，email 与 name 均可为空，name 缺失时使用 `sub` 显示。`/oauth2/userinfo` 仅做可选增强，空 email 不会把已经完成的 userInfo 步骤改为失败。只有响应头和增强接口都没有稳定用户 ID 时，token 成功才形成 `{session:true,userInfo:false,accessToken:true}` 的两文件状态。

普通登录或部分成功页的“重试”继续复用专用 SSO partition 的上游会话。已登录账号菜单只显示“退出登录”；注销同时清理三个凭据文件、专用 SSO partition 的全部 Cookie，以及默认 session 中配置所知 SSO origins 的 Cookie，但不触碰其他网站 Cookie。server 与 browser-cookie 会话通过 Cookie、CSRF Token 和后台 `POST /api/auth/logout` 注销，不把该状态修改接口作为网页打开；只有标准 OIDC 会话使用配置中的 `logoutUrl` 打开 IdP end-session endpoint。用户需要切换账号时，先退出，再重新登录选择账号。

展开态侧栏底部的 Settings 菜单触发器同时展示账户状态：已登录且未选中 Settings 菜单中的固定路由时，使用规范化用户信息显示“头像 + `name -> email -> sub -> 已登录` 回退名称 + 齿轮”；选中 Agents、Skills Center、MCP Connectors、Registries、Archived Chats 或 Market 后，触发器改为“当前路由名 + 用户头像 + 齿轮”，头像紧邻齿轮左侧，头像回退字符仍从用户名而非路由名取值。未登录时显示“未登录 + 齿轮”。SSO 未配置或状态尚未加载时继续显示原“设置”入口；侧栏收起时所有状态均只显示齿轮。该展示不改变菜单内容、打开前状态刷新、登录或退出流程。

官网账号头像不按 Google、邮箱或其他登录方式分支。official-server 根据当前账号保存的头像
URL 决定是否返回认证头像地址；没有头像 URL 的账号继续显示姓名首字符。启用
`sso.avatarCache` 后，Desktop 只接受 `trustedOrigin` 对应的官网头像 URL，主进程使用已经
同步到 default session 的官网 Cookie 下载并写入 `data/desktop/sso-avatar/`，renderer
只接收品牌隔离的 `<brand>-sso-avatar:` 本地协议 URL。第三方头像 URL、官网 Cookie 和本地
文件路径都不得进入 renderer；下载、类型或来源校验失败时显示姓名首字符。登录新账号和退出
登录都会清理本地头像缓存。标准 OIDC 未配置 `avatarCache` 时维持原头像 URL 行为。

Tunnel Hub、Kanban 与 Market 继续读取 `sso-site-token.json`，企业聊天读取
`state/desktop/sso-access-token.txt`；两个文件保存的是官网同一次 Cookie 换取的同一枚 JWT，
不再启动第二次 `siteTokenBridge` 浏览器登录。Desktop 不验证该 JWT，也不依赖 JWKS。
Desktop 启动时、JWT 剩余不足 15 分钟时，以及 Market、Tunnel Hub 或企业聊天返回 401 时，
会使用持久化官网 Cookie 和 CSRF Token 重新换取 JWT；只有 Cookie 失效才需要重新打开浏览器登录。

Desktop 只读取上述 canonical SSO 文件。历史配置、会话和 access-token 文件不会被读取、迁移或在 logout 时清理。

Desktop WebSocket 鉴权：

- token 可来自 query `token` 或 WebSocket subprotocol。
- JWT 必须是 RS256。
- `scope` 必须是 `app`。
- `device_id` 必须匹配当前 Desktop 安装级 device id。

## 配置与接口

关键文件：

- `config/desktop/sso.json`：SSO 配置。
- `state/desktop/sso-session.json`：schema v2 SSO 会话状态，不包含 user 或 access token；旧版内嵌 user 的会话仍可读取。
- `state/desktop/sso-user-info.json`：schema v2 规范化用户信息及来源。
- `state/desktop/sso-access-token.txt`：仅保存已成功取得的原始 access token。
- `data/desktop/sso-avatar/`：认证官网头像的本地缓存；文件名仅含用户/来源摘要，登录切换和退出时清理。
- 已解锁的 Settings → Debug → State 会把 access token 文件作为固定白名单状态文件明文展示并允许复制；普通设置页和未解锁会话不显示这一入口。
- `secrets/sso-site-token.json`：站点 token。
- `config/services/identity-center/.env`：identity-center 配置。

Token bridge 类型：

- request：`desktop:agent-auth:request`。
- response：`desktop:agent-auth:response`，同时携带 `token` 和可选 `desktopAuthContext`。
- storage key：`agent-webclient.appAccessToken`、`agent-webclient.appAuthContext`。
- 当前文档上下文：`window.__AGENT_APP_AUTH_CONTEXT`。

## 约束与注意事项

- Desktop 本地凭据写入 `secrets/` 或 `state/`，不要进入 `config/` 文档示例。
- `DesktopSsoStatus.completedSteps` 分别反映 session、userInfo、accessToken 是否完成；session 成功即 `authenticated=true`，但在剩余步骤 finalize 前保持 `pending=true`。userinfo 或 token 任一缺失时，侧栏和结果面板必须显示对应受限登录状态。
- Cookie SSO 只信任已验证 browserSession 响应头或 Cookie userinfo 返回的稳定用户 ID；不得从未经验证的 access token claims 伪造用户信息。email 不是身份成功条件，显示名缺失时回退到稳定用户 ID。
- Cookie 只保存在 Electron 的持久化 SSO partition，不写入上述三个状态文件，也不得进入日志。
- `sso.avatarCache` 只配置 `{ enabled, trustedOrigin }`；下载超时、大小、图片类型和重定向限制是
  Desktop 安全策略，不下放到环境配置。server/browser-cookie 模式只应把官网认证头像 URL
  交给该链路，不应把 Google 等 provider URL 暴露到 renderer。
- macOS/Linux 和 Windows 均通过 Electron home/runtime 路径解析状态目录；macOS/Linux 上三个文件保持 `0600`，不得硬编码用户目录。
- `identity-center` 是 token 签发与校验基础，不进入 webview bridge 协议名称；嵌入页只依赖 Desktop agent auth bridge。
- `zenmind-im-server` 独立校验企业 access token；Desktop 不把 IM session token 或 ticket 发送到 renderer、webview 或日志。
- token cache 会根据 JWT `exp` 和刷新原因复用或失效；`unauthorized` 会强制丢弃缓存。JWT 原始 `iat`/`exp` 仅在解码和校验内部按 Unix 秒处理；需要进入 shared contract 的具体时间点必须转换为 `EpochMilliseconds`，详见[时间契约](时间契约.md)。
- Desktop 先应用 `desktopAuthContext`、清理不匹配的旧 token，再写入响应 token；该上下文不再通过 agent-webclient URL 传递。
- Windows 身份脚本走 PowerShell，macOS / Linux 优先走 `.sh`，需要显式平台分支。
- webview 内页面只能通过 bridge 获取 token，不直接访问主进程 API。

## 相关文件

- `src/main/identity-center-auth.ts`
- `src/main/agent-auth.ts`
- `src/main/oidc-sso.ts`
- `src/main/sso-site-token.ts`
- `src/main/enterprise-chat-runtime.ts`
- `src/main/device-identity.ts`
- `src/shared/auth-bridge.ts`
- `src/preload/service-webview-main-world.ts`
- `test/oidc-sso.test.mjs`
- `test/agent-webclient-auth-injection.test.mjs`
