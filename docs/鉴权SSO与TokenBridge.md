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

上述分步语义只用于当前进程中的交互式登录。Desktop 重启时，Cookie SSO 的三个文件一律先作为“恢复候选”，不得直接发布 `authenticated=true`。在 Electron `userData` 确定后、创建主窗口前，主进程只执行一次 `restoreDesktopSsoSession()`：最长等待 5 秒校验 `browserSession`，成功后无条件重新执行 `cookieAccessTokenExchange`，即使磁盘 JWT 仍有超过 15 分钟的有效期也不得跳过。只有 session 校验、稳定用户 ID 处理、access token 换票、双 session Cookie 写入和存储刷新全部完成后，才提交完整已登录状态。标准 OIDC 且没有 Cookie 换票配置时继续按原文件恢复语义处理。

首次启动先进入未配置状态、随后由运行中的 env.zip 导入生成合法 `sso.json` 时，状态查询只把
内存状态协调为“已配置、未登录”，用于启用交互式登录入口；不得因此调用文件恢复或把磁盘上的
Cookie SSO session、用户信息、access token 候选重新发布为已登录。严格凭据恢复仍只能由上述
启动恢复控制器执行。

恢复校验的结果分为三类：

- `authenticated`：上游 Cookie 有效，换取新 JWT，并用本次账号覆盖旧 user/token，防止账号数据混用。
- `signed_out`：`401/403`、明确无 Cookie 会话或登录重定向；立即删除 session/user/token/site-token/头像缓存，并清理专用 SSO partition 与 default session 中配置已知的 SSO Cookie。
- `temporarily_unavailable`：断网、超时、`429`、`5xx` 或其他不能证明会话失效的错误；保留磁盘文件和作为权威来源的上游 session Cookie，但从两个 Electron session 移除派生的旧 `access_token` Cookie。当前运行态为 `authenticated=false`，不注入旧 JWT，也不启动依赖 SSO 凭据的企业聊天与 Tunnel Hub。5 分钟定时器和 `sso.getStatus` 复用同一个单飞重试；恢复后广播状态并刷新 Website、Kanban、Market、企业聊天和 Tunnel Hub。

session 验证成功后 `authenticated=true`，但当前登录尝试继续保持 `pending=true`。userinfo 与 access token 两步都尝试结束后才统一 finalize；三步全成功时登录 WebView 自动关闭，部分成功或失败时 WebView 被逐项结果面板替换，由用户选择关闭或重试。Cookie SSO 的基础用户信息来自同一次已验证 `/oauth2/auth` 响应中配置的 `userInfoHeaders`：`sub`（稳定用户 ID）是唯一必需字段，email 与 name 均可为空，name 缺失时使用 `sub` 显示。`/oauth2/userinfo` 仅做可选增强，空 email 不会把已经完成的 userInfo 步骤改为失败。只有响应头和增强接口都没有稳定用户 ID 时，token 成功才形成 `{session:true,userInfo:false,accessToken:true}` 的两文件状态。

普通登录或部分成功页的“重试”继续复用专用 SSO partition 的上游会话。已登录账号菜单只显示“退出登录”；注销同时清理三个凭据文件、专用 SSO partition 的全部 Cookie，以及默认 session 中配置所知 SSO origins 的 Cookie，但不触碰其他网站 Cookie。server 与 browser-cookie 会话通过 Cookie、CSRF Token 和后台 `POST /api/auth/logout` 注销，不把该状态修改接口作为网页打开；只有标准 OIDC 会话使用配置中的 `logoutUrl` 打开 IdP end-session endpoint。用户需要切换账号时，先退出，再重新登录选择账号。

展开态侧栏底部的 Settings 菜单触发器同时展示账户状态：已登录且未选中 Settings 菜单中的路由时，使用规范化用户信息显示“头像 + `name -> email -> sub -> 已登录` 回退名称 + 齿轮”；选中 Agents、Skills Center、MCP Connectors、Registries、Archived Chats、Market 或 Help 后，触发器改为“当前路由名 + 用户头像 + 齿轮”，头像紧邻齿轮左侧，头像回退字符仍从用户名而非路由名取值。未登录时显示“未登录 + 齿轮”。SSO 未配置或状态尚未加载时继续显示原“设置”入口；侧栏收起时所有状态均只显示齿轮。该展示不改变菜单内容、打开前状态刷新、登录或退出流程。

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
当前严格启动恢复只适用于同时配置 `browserSession + cookieAccessTokenExchange` 的 Cookie SSO。
官网 Server Broker 在官网提供可由 Electron Cookie 调用的 session 验证 API，并接入 Desktop 的
`server` 恢复分支后，才能同样以上游 Cookie 为启动权威并强制换票；在此之前仍维持既有文件恢复
和 JWT 临近过期时换票的语义，不得宣称已经覆盖官网 Cookie 失效但本地 JWT 仍有效的启动场景。

Desktop 只读取上述 canonical SSO 文件。历史配置、会话和 access-token 文件不会被读取、迁移或在 logout 时清理。

Desktop WebSocket 鉴权：

- token 可来自 query `token` 或 WebSocket subprotocol。
- JWT 必须是 RS256。
- `scope` 必须是 `app`。
- `device_id` 必须匹配当前 Desktop 安装级 device id。

## 配置与接口

关键文件：

- `config/desktop/sso.json`：SSO 配置。
- `state/desktop/sso-session.json`：schema v2 SSO 会话状态，不包含 JWT、Cookie、user 或重复过期时间；旧版内嵌 user / idToken 的会话仍可读取，但新写入不再包含这些字段。Cookie SSO 完整成功示例：

  ```json
  {
    "schemaVersion": 2,
    "authenticated": true,
    "issuer": "https://ai.qiuer.net",
    "audience": "cutej-desktop",
    "authMode": "browser-cookie",
    "message": "单点登录已完成。",
    "updatedAt": "2026-08-03T02:14:16.411Z"
  }
  ```

  其中 `authenticated` 仅表示最近一次持久化验证成功，重启时仍须重新验证；临时网络失败保留该成功记录，但运行态不得据此显示已登录。明确失效或注销时直接删除文件，不写 `authenticated:false` 文件。
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
- Cookie 只保存在 Electron session，不写入上述三个状态文件，也不得进入日志。`persist:<storageNamespace>-sso` 只表示 partition 的存储目录可持久化，并不把没有 `Expires/Max-Age` 的 session Cookie 自动变成跨进程 Cookie。上游 Cookie 是否跨重启由服务端属性决定；Desktop 写入的 `access_token` Cookie 从 JWT `exp` 生成 `expirationDate`，同一枚 JWT 同时写入专用 SSO partition 和 default session。JWT 缺少合法未来 `exp` 时只写当前进程 session Cookie，下次启动仍强制重新校验和换票。
- Cookie 写入完成后必须刷新两个 Electron session 的存储，再发布 `authenticated=true`；从临时失败恢复成功时，只 reload 使用专用 SSO partition 的 Website WebView。Help、WebApp、agent-webclient 和普通服务 partition 不参与。
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
