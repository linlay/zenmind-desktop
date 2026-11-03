# Desktop 总登录与下游模块认证隔离排查报告

排查日期：2026 年 11 月 2 日，Asia/Shanghai。源码基线：`1230f025`，包含本聊天上一轮尚未提交的企业聊天隔离修复。

本报告记录当前实现、实际调用关系、已确认问题和验证边界，不包含整改方案。排查对象包括 Desktop SSO、Tunnel Hub、企业聊天、Market、云看板、使用情况、网站会话交换，以及本地 Agent Platform 身份的边界。

## 1 用户要求与当前结论

本次核对采用以下用户要求：

1. 用户主动登录，或者 Desktop 总登录自身执行 refresh，才向 Tunnel、企业聊天、Market 等下游产生一次身份刷新联动。
2. 下游功能失败只能影响该功能，不能反向改变 Desktop 总登录状态，也不能借总登录刷新打断其他下游。
3. Market 返回 401 同样属于下游失败，不能影响 Desktop 总登录状态。

**当前实现未完全满足这些要求。**

当前共享一份 canonical SSO 凭据，但下游同时拿到了请求总登录续期的能力。Tunnel、企业聊天、Market、使用情况、网站会话交换均存在反向请求总续期的路径。它们一般没有直接调用清除总登录的方法，但能够进入具有写凭据、发布认证状态、停止运行时等副作用的总续期流程。

上一轮已删除“总续期成功后无条件重建企业聊天”的调用，消除了本次重连故障的一处连带影响；下游反向触发总续期的入口仍然存在，其他模块的联动也没有因此全部消失。

此外，当前没有覆盖所有登录模式与所有入口的统一身份刷新分发机制。“一次”有不同层次：一次状态广播、一次 token 成功提交、一次业务连接重建，在代码中并不等价。

## 2 当前存在的三类身份

| 身份 | 当前所有者与消费者 | 与 Desktop 总登录的关系 |
| --- | --- | --- |
| Desktop canonical SSO 凭据 | Identity 模块持有；Tunnel、企业聊天、Market、云看板、使用情况等消费 | 用户账号的公共业务身份。OIDC 网关模式使用 `id_token`，不是 EIAM `access_token` |
| 下游派生会话 | 企业聊天拥有自己的 IM session 与 WS ticket；网站拥有自己的 Cookie 会话 | 由总登录凭据换取，各自另有有效期和运行时状态 |
| 本地 Platform App 身份 | 本地 Identity Center 签发，本地 Platform、Broker 和可信 WebClient 使用 | 与官网登录账号分开，不应随官网登录、续期或退出轮换本地聊天主体 |

SSO 私有恢复材料与公共业务投影也不同：`sso-credentials.json` 保存网关恢复凭据，`sso-id-token.txt` 是业务 token 投影。下游共享的是同一公共业务身份，不是分别持有独立 Desktop 登录。

Tunnel 内还存在上传给 Hub 的本地 Platform App Token 及其续期。这用于手机访问本地 Platform，和官网 SSO JWT 续期不是同一个流程。Tunnel 的这条本地票据更新失败不会经过本文所述的 `refreshIdentityToken` 路径。

来源：[鉴权设计](../docs/鉴权SSO与TokenBridge.md)、[身份状态](../src/main/modules/identity/sso-state.ts)、[Tunnel 运行时](../src/main/modules/tunnel/runtime.ts)。

## 3 Desktop 总登录当前由哪些入口触发

| 入口 | 当前实际行为 | 备注 |
| --- | --- | --- |
| 用户登录和登录回调 | 验证上游身份，提交凭据和账号，广播状态，触发业务联动 | 内嵌登录、标准 OIDC 回调和网关登录的路径不完全相同 |
| 启动恢复 | 校验磁盘恢复候选，成功后发布已认证结果 | 启动恢复也是当前实际触发来源，不要求用户每次重新点击登录 |
| 启动后的首次检查 | 调用公共 `refreshDesktopSsoIdentityToken()` | 不一定换票；是否换票取决于状态和到期判断 |
| 每五分钟检查 | 调用同一个公共续期函数 | 并非每五分钟必然取得新 token |
| 设备唤醒 | `powerMonitor.resume` 调用公共续期函数 | macOS、Windows 共享此业务入口 |
| OIDC 提前续期定时器 | 直接调用 Identity 内部的 `exchangeOidcTokens()` | 没有经过 app 层公共续期包装函数 |
| OIDC 到期保护 | 已发布 token 到期后撤销业务可用状态 | 即使自动续期预算已耗尽仍执行到期保护 |
| 用户显式重试总会话 | `sso.retrySession` 调用 `retrySession()` | OIDC 模式下能够重置本轮自动续期阻断 |
| 读取总登录状态 | `sso.getStatus` 先尝试恢复，再调用 `ensureBusinessToken()` | 不是纯只读查询；在需要续期时会产生认证请求 |
| 下游业务请求或 401 | 多个下游可调用公共续期或直接调用 `ensureBusinessToken(true)` | 与用户本次要求的单向依赖不一致，详见下一节 |

因此，不能把当前行为概括为“只有用户登录和一个 Desktop 定时器会触发刷新”。状态读取、业务请求以及多个不同的身份维护入口均参与其中。

来源：[启动与定时检查](../src/main/app/lifecycle/startup-assembly.ts) 的 `startNonCoreDesktopRuntime`；[总登录 IPC](../src/main/modules/identity/ipc.ts) 的 `sso.getStatus`、`sso.retrySession`；[SSO 控制器](../src/main/modules/identity/sso-controller-runtime.ts) 的 `scheduleOidcRenewal`、`ensureBusinessToken`。

## 4 下游模块逐项核对

### 4.1 Tunnel Hub

当前注册使用 canonical SSO Bearer 调用 `POST /api/desktop/devices/register`。注册响应为 401 时，调用注入的 `refreshIdentityToken()`，取得结果后再注册一次。

这份回调最终绑定到 `refreshDesktopSsoIdentityToken(true)`。因此，Tunnel 的业务拒绝能够强制发起一次总登录续期。

注册最终失败后，运行时进入重连。当前 CuteJ 的 `reconnectSeconds` 为 3；每轮重连重新执行注册，每轮注册又重新拥有一次强制续期机会。“一次换新”仅限制单轮注册，不限制持续失败期间的换新总次数。

注册错误当前只保留 HTTP 状态和状态文字。虽然代码读取了响应正文 `raw`，失败抛错时并未把服务端拒绝类别保留到运行时错误中。因此 Desktop 日志不能区分签名、公钥、Issuer、Audience、有效期等具体校验原因。

来源：[注册逻辑](../src/main/modules/tunnel/registration.ts) 第 127–140 行；[重连逻辑](../src/main/modules/tunnel/runtime.ts) 的 `scheduleReconnect`；[回调装配](../src/main/app/assembly/assistant.ts)、[Tunnel 注册控制器装配](../src/main/modules/assistant/runtime.ts)。

### 4.2 企业聊天

企业聊天用 canonical SSO token 换取 IM session，再取得一次性 ticket 并建立 WebSocket。换 IM session 返回 401 时，当前同样调用 `refreshDesktopSsoIdentityToken(true)`，然后重试换会话。

企业聊天自身还有多个刷新入口：开启功能、配置重载、显式刷新、IM session 到期前续期、WebSocket 断线恢复、`sync.reset_required`。这些是模块实际存在的会话维护流程，并不是都来自 Desktop 总登录。

`performRefresh()` 的实际动作较重：断开 socket、清除 IM session、重新换会话和 bootstrap，并将 `activeConversationId`、`activeMessages` 清空。因而把它当作普通“新 token 通知”调用，会产生可见的会话重置。

上一轮已删除 app 层公共总续期函数对它的无条件调用。但企业聊天换会话 401 后请求总续期的反向路径仍保留。

本次还确认两项独立现状：

- `applyDesktopSsoRestoreResult()` 收到非 authenticated 状态时直接停止 Tunnel，但该分支没有调用企业聊天的 `handleSignedOut()`。企业聊天显式清理挂在用户退出 IPC 路径上；后台认证撤销没有在此处获得同等的立即停止处理。企业聊天也未订阅 canonical 凭据撤销通知。
- 企业聊天进行中的换会话、bootstrap 和 ticket 请求缺少整个刷新批次的账号 generation 复验。隔离夹具已复现：换会话请求挂起时退出，迟到响应仍能重新写入旧用户并创建 socket，详见第 8 节。

来源：[企业聊天会话控制器](../src/main/modules/enterprise-chat/session-controller.ts) 的 `performRefresh`、`handleSignedOut`、`scheduleSessionRefresh`；[实时连接](../src/main/modules/enterprise-chat/realtime-connection.ts)；[身份装配](../src/main/app/assembly/identity.ts)；[退出 IPC](../src/main/modules/identity/ipc.ts)。

### 4.3 Market

Market 至少有两类独立的 401 换新路径。

**普通鉴权市场请求：** `requestMarket()` 首次使用现有 token 请求；返回 401 后，以 `unauthorized` 原因再次取 token。app 层的 `configureMarketTokenIssuer()` 将这个请求直接转为 `desktopSsoController.ensureBusinessToken(true)`。

**收藏与取消收藏：** `requestFavoriteUpdate()` 收到首次 401 后，也以 `unauthorized` 再取凭据；`ipc-services-market.ts` 中单独装配的 issuer 同样直接调用 `ensureBusinessToken(true)`。

这两条路径绕过了 app 层的 `createDesktopSsoTokenRefresher()` 包装。因此，上一轮从公共包装函数中删除企业聊天联动，并没有撤销 Market 请求总续期的能力，也没有让不同入口的下游通知行为变得一致。

Market 收到第二次 401 后，通常把请求收敛为市场认证错误；但在到达这一返回点以前，它已经可能触发了一次完整的总登录续期。若该续期进入总登录撤销分支，Market 的请求结果就会伴随全局登录变化。

部分市场列表还会并行聚合多个分类请求；单次 HTTP 请求的“一次重试”不等于整个市场加载过程只有一次认证尝试。Identity 内部的单飞只能合并时间上重叠的续期请求，不会自动阻止后续顺序请求再次续期。

公开市场与已登录市场也存在区别：`requestVisibleMarketJson()` 按当前 viewer 决定走公开读取还是鉴权读取，故不是所有市场请求都一定携带 SSO token。

来源：[市场公共 HTTP](../src/main/modules/marketplace/market-http.ts) 的 `requestMarket`、`requestVisibleMarketJson`；[市场 issuer](../src/main/app/assembly/identity.ts) 的 `configureMarketTokenIssuer`；[收藏请求](../src/main/modules/marketplace/runtime.ts) 的 `requestFavoriteUpdate`；[收藏 issuer](../src/main/app/ipc-services-market.ts) 的 `toggleMarketFavorite` 装配。

### 4.4 使用情况与 Transit Hub

使用情况支持 API Key 和 access-token 两种模式。

API Key 模式下，认证失败不会通过这里请求 Desktop SSO 续期。access-token 模式下，首次读取使用 `getToken(false)`；`/api/me` 或额度、用量、余额、日志、会话、价格分区出现 401 时，执行 `getToken(true)` 并重查。

app 层将该回调绑定到公共 `refreshDesktopSsoIdentityToken(force)`，所以使用情况查询也能反向触发总登录。`tokenRefreshAttempted` 限制一次整组查询中的重试，`peekToken` 阻止旧凭据查询跨越已发生的 token 替换；这些保护不等于取消反向续期能力。

来源：[使用情况查询](../src/main/modules/settings/usage-profile.ts) 的 `getDesktopUsageProfile`；[设置 IPC 装配](../src/main/app/ipc-connected-runtimes.ts) 的 `refreshUsageAccessToken`。

### 4.5 网站与 WebApp 会话交换

用户允许向已确认的网站交换地址提交凭据后，代码先执行 `refreshToken()`；目标网站返回 401 时，再执行 `refreshToken(true)` 并重试。

该回调由 app 层绑定到公共总续期函数。因此，网站自己的会话交换接口也能通过其 401 发起 Desktop 总续期。

这条路径已有页面、账号、撤销 epoch 和 Cookie 所有权校验，并订阅 canonical 凭据撤销。以上保护针对凭据传递和迟到结果，不能改变它能够请求总续期这一事实。

来源：[网站会话交换](../src/main/modules/webs/auth-session.ts)；[装配入口](../src/main/app/runtime.ts) 的 `registerWebappAuth`。

### 4.6 云看板

本次核对的云看板连接路径读取 canonical token 文件和当前用户信息；凭据不可用时返回 `auth_required`。没有发现云看板连接模块在 401 后调用总 SSO 续期的回调。

但它仍受到其他模块反向续期的间接影响。公共总续期包装函数在认为需要 refresh 且取得 token 后，会调用 `refreshKanbanDeviceInfo()`；该方法最终执行 `refreshConnection({ forceReconnect: true })`。因此，Tunnel、使用情况或网站触发公共总续期后，仍可能强制重连云看板。

普通配置和业务调用也会读取并更新云看板连接配置。当前并非所有重连都来自总登录事件。

来源：[云看板配置解析](../src/main/modules/kanban/runtime-config.ts)；[运行时设置](../src/main/modules/kanban/runtime-settings.ts) 的 `refreshDeviceInfo`、`refreshConnection`；[WS 连接](../src/main/modules/kanban/ws-connection.ts) 的 `start`；[公共续期包装](../src/main/app/assembly/identity.ts)。

### 4.7 对话分享与 WebApp Tunnel 发布

这些功能复用 Tunnel 的 canonical 身份、API origin 或连接能力。已核对的对话分享 Tunnel HTTP 客户端会把请求拒绝转换为业务错误，没有发现其 401 处理直接调用总续期。

它们与 Tunnel 存在实际功能依赖：Tunnel 不可用会影响分享、发布或外部访问。这种业务依赖与“认证失败反向修改 Desktop 总登录”不是同一个现象，不能混为一项。

本次没有复现分享或发布失败直接清除 Desktop 总登录的路径。

当前实现见[分享 HTTP 客户端](../src/main/modules/shares/http-client.ts)、[分享控制器](../src/main/modules/conversation-share/controller.ts)、[Tunnel 运行时](../src/main/modules/tunnel/runtime.ts)。

### 4.8 本地 Platform 与员工身份模型请求

本地 Platform 主体与官网账号分离。主聊天、旁聊、详细解释使用本地 App 身份；员工身份 Provider 和 OneID 调用另行读取 canonical SSO 投影文件。官网 token 更新会影响这些身份消费者的后续请求，但不应把本地 Platform 主体等同为官网账号。

本次没有修改或运行审计 agent-platform 仓库的完整请求链，不能据此断言 Platform 内全部消费者均符合隔离要求。

另有一处文档与实现关系值得区分：鉴权文档声明官网登录变化不影响本地聊天，但 app 层 `applyDesktopSsoRestoreResult()` 在非 authenticated 时仍调用 `stopBrowserWebclient()`。它针对独立浏览器 WebClient 入口，不等于直接停止本地 Platform 或内嵌 Broker，但说明失去官网认证时并非所有本地访问面都完全不受影响。

## 5 下游失败如何影响到总登录

当前没有发现 Tunnel、IM、Market 自己直接执行 `clearDesktopSsoLocalSession()`。实际影响经过同一条间接链路：

```text
下游请求返回 401
  → 下游请求强制刷新 canonical SSO
  → Identity 执行真正的身份请求和凭据提交
  → 根据这次身份请求结果更新 Desktop 总登录
  → 认证结果进一步影响其他身份消费者
```

各类结果当前有明确区别：

| 结果 | Identity 当前处理 | 对总登录的影响 |
| --- | --- | --- |
| 下游原始 401，但尚未调用身份服务 | 下游不能仅凭它直接清除总登录 | 原始业务 401 本身不是总登录撤销依据 |
| OIDC token 刷新接口明确返回 401 | 清除总登录和凭据，发布 signed_out | 这是身份服务拒绝，不是把下游 401 原样当成退出依据 |
| OIDC userinfo 拒绝或其他临时失败，旧 token 仍有效 | 设 `oidcBlocked`，保留现有已认证状态并向调用方报错 | 仍会改变总续期控制状态；后续自动续期可被阻断 |
| OIDC 续期失败且旧 token 已到期 | 撤销业务投影，发布 temporarily_unavailable，保留可恢复材料 | 业务身份暂不可用 |
| Cookie 或 Bearer 换票明确拒绝上游会话 | 按 definitive 分类清除总登录 | 分类包含身份换票返回的 401、403、204 及重定向状态 |
| Cookie 或 Bearer 临时续期失败，旧 token 仍有效 | 保留总登录，本次调用失败 | 已有回归测试覆盖这类保护 |
| Cookie 或 Bearer 临时失败且 token 已失效 | 发布 temporarily_unavailable | 保留恢复材料，不继续暴露过期业务身份 |

这里不能得出“任何下游 401 都会退出 Desktop”，也不能得出“下游 401 完全不会影响 Desktop”。准确情况是：下游有权限启动会改变总登录或总续期控制状态的流程。

OIDC 有按当前 credential generation 协调的单飞、失败阻断和身份切换检查；Cookie 或 Bearer 分支也有 refresh promise 与旧会话比较。这些限制并不消除反向调用关系。

来源：[SSO 控制器](../src/main/modules/identity/sso-controller-runtime.ts) 的 `exchangeOidcTokens`、`ensureBusinessToken`、`isDefinitiveRestoreFailure`；[SSO 恢复状态](../src/main/modules/identity/sso-restore.ts)。

## 6 总登录成功后当前怎样刷新下游

现有联动分散在多个入口，尚不能认定为“每次总 refresh 成功只给每个下游通知一次”。

| 位置 | 当前联动 | 现有约束或缺口 |
| --- | --- | --- |
| `startSsoCredentialDependentRuntimes()` | 开启企业聊天、启动 Tunnel | 有全局 started 标记；它表达是否启动过，不表达是哪一次身份提交 |
| `applyDesktopSsoRestoreResult()` 首次进入 authenticated | 启动身份消费者，再刷新云看板、Market 和企业聊天 | 企业聊天的 setEnabled 与 refresh 可能由同一恢复链触发；有 refresh promise 合并重叠请求，但没有按身份事件保证一次 |
| 登录 IPC 的 `onAfterStatusChanged` | 交换业务 token，刷新云看板与企业聊天 | 与恢复结果发布不是同一个统一分发入口 |
| 公共 `createDesktopSsoTokenRefresher()` | 续期前应用恢复结果，取得 token 后可能强制刷新云看板 | 上一轮已移除企业聊天；仍保留业务副作用 |
| OIDC 提前续期、`retrySession()`、Market 直接续期 | 直接进入控制器，成功发布 restore result | 已启动时，app 层 started 标记会让恢复处理提前返回，不等同于公共包装函数的通知行为 |
| `sso.getStatus` 内部续期 | 调用控制器 | 与公共包装的后续通知不同；Cookie 或 Bearer 成功分支主要持久化 token，也不等同于 OIDC 的完整 publish 路径 |
| 认证撤销 | app 层停止 Tunnel，网站交换模块订阅撤销；用户退出 IPC 另行清理企业聊天 | 不同消费者的立即停止入口不对称 |

同一个控制器可能同时被公共包装、Market issuer、状态读取和内部定时器调用。单飞避免部分并发重复请求，但不同调用者在 await 之后仍有各自的后续动作，不能把单飞视为下游通知去重。

## 7 本次企业聊天重连的运行证据

证据来自 `~/.cutej/.desktop/logs/desktop/main.log` 和当时的 Desktop 界面。所有时间均转换为北京时间。

1. 15:35 至 15:39 左右，日志反复出现 Tunnel 注册 401、SSO refresh 请求成功、Tunnel 再次注册失败、进入 reconnecting。
2. 相邻失败轮次间隔约三秒，与本机 Tunnel `reconnectSeconds: 3` 一致。
3. 当时公共总续期函数仍包含 `enterpriseChatRuntime.refresh()`。该调用会关闭 IM 连接并清空当前会话。
4. 界面可短暂显示“已连接”，但当前聊天对象丢失，输入区保留未发出的“你好”。
5. 15:39:42、15:39:45、15:39:48，Tunnel 注册响应转为 503。
6. 15:39:51，Tunnel 成功注册并连接。
7. 15:40:49，日志记录用户退出，随后完成服务停止与退出清理。

**已确认的连带链路：Tunnel 持续失败导致总登录频繁续期，总续期成功又重建企业聊天。**

**尚未确认的部分：Hub 当时为什么拒绝那些 token。** Desktop 日志没有保留具体校验分类，本次没有取得当时部署的 Hub 服务端校验日志。不能仅凭后来成功或中间出现 503，断言是哪个服务端配置被改动。

李晶消息的真实服务端投递未在本聊天中完成验证。用户此前要求暂不重启、保留修复，助手未重启 CuteJ，也未发送测试消息。后续日志中的成功连接和用户退出不能算作助手实施修复后的实机验收。

## 8 验证结果与覆盖边界

### 8.1 上一轮已经完成的修复

- 删除公共 SSO 续期成功后无条件执行的 `enterpriseChatRuntime.refresh()`，并移除该包装函数的企业聊天依赖。
- 更新企业聊天设计说明和手工回归条目。
- 增加重复业务续期不应重建健康 IM 会话的回归测试。
- 已完成 Main 构建和 CuteJ bundle 构建；上一轮相关 108 项测试通过，架构检查通过。

这是一项局部修复，不能视为本报告中所有隔离问题已经修复。按用户要求，没有由助手重启加载该修复。

### 8.2 本轮已有用例复核

本轮执行 12 个相关测试文件，覆盖 SSO、IM、Tunnel、Market、使用情况、网站交换与看板鉴权装配。结果为 **319 项测试，318 项通过，1 项失败**。

失败项为 `marketplace.test.mjs` 的 `skill package installs and uninstalls all included skills as one transaction`，第 1278 行断言预期三次调用、实际六次。单独串行重跑该用例仍失败。该断言是技能包交易调用次数，不能将其当作 Market 401 隔离失败的直接证据；本轮未修改该业务代码，也未确定此失败的根因。

现有部分通过用例恰好在验证旧行为，例如“企业聊天 401 后刷新一次 Desktop JWT”和“网站交换 401 后请求一次换新”。所以已有测试通过，不代表满足本次用户提出的严格单向依赖要求。

测试记录保存在本机临时文件 `/tmp/zenmind-auth-audit-tests.log` 和 `/tmp/zenmind-auth-audit-market-recheck.log`，不是产品日志。

### 8.3 企业聊天退出期间迟到响应复现

本轮使用编译后的 `EnterpriseChatRuntime`、虚构身份和内存 HTTP/WS 夹具执行以下顺序，没有访问真实企业聊天服务或发送消息：

1. 开始 `runtime.refresh()`，让 IM session exchange 保持挂起。
2. 清空夹具中的 Desktop 身份，并执行 `runtime.handleSignedOut()`。
3. 确认企业聊天状态为 signed_out，当前用户为空。
4. 放行旧的 exchange 响应，再等待 refresh 完成。

实际输出：

```json
{"stage":"after-sign-out","state":"signed_out","userPresent":false}
{"stage":"after-late-response","state":"connecting","userPresent":true,"socketsCreated":1}
```

这证明已发起的旧刷新可以在退出清理之后重新填入 IM 身份并创建连接。复现到的是企业聊天下游状态被迟到响应恢复，**不是** Desktop 总登录被重新登录，不能混淆二者。

### 8.4 平台与外部服务边界

本轮在 macOS 上执行源码核对和 Node 测试；部分用例显式覆盖 darwin 与 win32 参数，但未执行 Windows 原生 Desktop 验收。

本次核对没有实际更改生产 Tunnel Hub、IM Server、Market Server 或账号配置。Hub 的实际拒绝原因、这些外部服务是否存在其他认证兼容问题，不在当前客户端证据能够确定的范围内。

## 9 已确认现状清单

| 编号 | 当前事实 | 状态 |
| --- | --- | --- |
| A01 | Tunnel 401 可以强制请求总 SSO 续期，失败后按本机三秒配置重新进入同一流程 | 仍存在 |
| A02 | 企业聊天换 session 的 401 可以强制请求总 SSO 续期 | 仍存在 |
| A03 | Market 普通鉴权请求和收藏请求分别可以强制请求总 SSO 续期 | 仍存在 |
| A04 | 使用情况 access-token 查询、网站会话交换可以请求总 SSO 续期 | 仍存在 |
| A05 | 被业务触发的 Identity 续期能更新凭据、进入 signed_out 或 temporarily_unavailable，或设置 OIDC 自动续期阻断 | 条件和边界见第 5 节 |
| A06 | 公共总续期无条件重建企业聊天，导致其他模块失败连带影响 IM | 上一轮已修复源码，未由助手重启验收 |
| A07 | 公共续期包装仍可强制刷新云看板连接，直接调用控制器的路径行为又不相同 | 仍存在 |
| A08 | 登录、启动恢复、定时续期、状态读取和业务触发之间没有统一的下游一次性分发事实 | 源码已确认 |
| A09 | 总身份后台失效与用户显式退出，对企业聊天的立即清理路径不对称 | 源码已确认 |
| A10 | 企业聊天旧刷新请求在退出后仍可能恢复旧 IM 身份并创建 socket | 隔离夹具已复现 |
| A11 | 现有鉴权设计明确允许消费者在 401 后请求一次总续期 | 与用户本次严格要求存在设计差异 |
| A12 | 当时 Hub 原始 401 的具体校验原因 | 尚未确认 |

本轮仅形成排查报告，没有实施新的业务代码修改，也没有把上述现状描述当作新的架构决策写回 `docs/`。

## 10 后续整改状态

2026 年 11 月 2 日同日完成整改，设计结论已写回[鉴权设计](../docs/鉴权SSO与TokenBridge.md)的“下游凭据只读消费”一节。下表对应第 9 节编号，记录的是源码与自动化测试层面的状态。

| 编号 | 整改后 |
| --- | --- |
| A01 | Tunnel 注册 401/403 抛出凭据被拒错误，不再请求总续期；按 30 秒起、10 分钟封顶退避，Desktop 提交另一枚 token 时立即重试一次 |
| A02 | 企业聊天换会话 401/403 只进入错误状态并记住被拒 token，Desktop 提交另一枚 token 时重试一次 |
| A03 | Market 普通请求与收藏的 issuer 只读取已发布 token；401 仅在在途期间 Identity 已换新时用新 token 重试一次，并显示市场拒绝原因 |
| A04 | 使用情况与网站会话交换改为只读 token，同样只在已有新 token 时重试一次 |
| A05 | 业务不再能触发 Identity 续期；Identity 只由登录、显式重试、启动恢复、提前续期定时器、周期检查和唤醒驱动；`sso.getStatus` 改为纯读取 |
| A06 | 保持上一轮修复 |
| A07 | 定时维护不再重连看板；同账号续期只更新看板缓存凭据，看板 WS 比较连接地址时忽略 token |
| A08 | app 层统一分发器按 issuer、sub、audience 区分账号变化、同账号续期与同账号恢复；登录 IPC 不再单独刷新看板和企业聊天 |
| A09 | 后台 signed_out 与用户退出一样调用企业聊天 `handleSignedOut()` |
| A10 | 企业聊天按会话 epoch 丢弃退出后迟到的换会话、bootstrap 与 ticket 结果，回归测试覆盖第 8.3 节复现 |
| A11 | 设计文档已改为“下游只读消费”，`npm run architecture:check` 拦截 Identity 之外的续期入口与已退役的刷新钩子 |
| A12 | Tunnel 保留脱敏后的 Hub 拒绝原因（JWT 形态字符串被替换），用于定位公钥等配置问题 |

实机验收按[手工回归清单](../qa/manual-regression.md)的“下游认证拒绝隔离”执行，尚未完成。第 8.2 节记录的 Market 技能包交易调用次数失败与本次整改无关，仍然存在。
