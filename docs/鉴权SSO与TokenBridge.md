# 鉴权、SSO 与 Token Bridge

## 文档定位

本文描述 Desktop 的身份信任边界、登录与恢复流程，以及凭据向受信任运行面的传递原则。具体配置字段、IPC 类型、消息名和存储结构以源码、shared contract 与测试为准。

## 信任模型

Desktop 把身份能力拆成三层：

- `identity-center` 提供本地身份基础、密钥与 App access token。
- Desktop 主进程持有 SSO 会话和唯一的 canonical access token，并负责校验、换取、刷新与撤销。服务内部的短期 session 或一次性票据不得成为第二份持久 Desktop access token。
- renderer、webview 和外部服务只获得完成当前任务所需的最小信息，不直接接触 Cookie、私钥或服务间短期票据。

主进程是凭据边界。renderer 只接收规范化用户状态、本地头像协议 URL 和经授权的短期结果；日志、URL、普通配置与页面上下文不得携带原始凭据。

## 登录模式

Desktop 支持标准 OIDC 与基于浏览器 Cookie 的站点 SSO。两种模式共用统一的运行时状态，但保持各自的上游会话语义。

Cookie SSO 的主流程为：

```text
Electron 默认 session 完成登录
  -> 验证上游浏览器会话
  -> 取得稳定用户身份
  -> 交换 canonical access token
  -> 同步允许的 Cookie 与本地状态
  -> 发布 authenticated 状态
```

当 Cookie 换票响应同时包含生产与开发等多个 JWT 时，默认环境配置必须用预期 Issuer 与 Audience 精确选择 canonical token，不能依赖字段顺序或默认取第一个 token。若受信 HTTPS 换票端点明确保证每次只返回一枚 JWT，可显式配置 `validationMode: remote`：Desktop 仍要求响应中只有一枚 JWT，但将签名、Issuer、Audience、有效期和权限交由实际业务服务校验。两种模式都不会向 renderer 暴露 token，也不会在多枚候选中自动选第一枚。

会话、用户信息和 access token 是三个独立结果。交互式登录允许部分成功并向用户说明缺失步骤；不能用某一步的成功伪造另一步，也不能从未经验证的 token claims 推导用户身份。

## 启动恢复

磁盘状态只是恢复候选，不是登录事实。主窗口创建前，恢复控制器按当前 SSO 配置执行严格恢复，完成上游校验、token 换取、稳定身份确认与 Electron session 写入后才发布已登录状态。恢复策略由配置决定，不按品牌或域名硬编码，也不能因一种策略失败而自动尝试另一种凭据。

浏览器 SSO 默认使用 Cookie 恢复：验证上游浏览器会话，交换 access token，再从会话响应或用户信息接口确认稳定身份。用户信息接口若依赖派生 token Cookie，必须在换票后请求。

显式启用 Bearer 恢复的配置允许主进程把磁盘 access token 作为恢复候选，携带到已配置的同源换票接口，再用返回的 token 调用同源用户信息接口。只有取得稳定用户身份后才写入派生 Cookie 并发布 canonical 凭据；过程中不要求旧 Cookie 仍然存在，不从 token claims 推断登录成功，不跟随携带 Bearer 的请求重定向。未配置该策略的站点不会自动发送磁盘 token。该配置同时决定运行期续期的凭据来源：Bearer 模式向同一受信换票接口提交当前 canonical token，并省略 Cookie；默认 Cookie 模式继续使用浏览器会话。不能在恢复成功后静默改用另一种凭据续期。交互式登录和服务端票据换 Cookie 的流程保持各自语义。

恢复结果分为三类：

- `authenticated`：上游会话有效，以当前账号的新结果替换旧派生状态。
- `signed_out`：上游明确拒绝或已无会话，清除凭据、身份缓存及相关 Cookie。
- `temporarily_unavailable`：网络、限流或服务故障不能证明会话失效；保留恢复材料但本次运行保持未认证，后台单飞重试。

运行期 canonical token 刷新沿用相同的失效分类：上游明确拒绝会话时清除身份与凭据，并立即向界面及身份消费者发布未登录状态；已过期或业务请求已拒绝的 token 遇到临时故障时，撤销内存身份、保留恢复材料并进入后台恢复。提前刷新遇到临时故障且原 token 仍有效时可继续使用。迟到的刷新结果不得覆盖已经切换或退出的账号。派生 access-token Cookie 使用 JWT 的到期时间，上游浏览器会话 Cookie 保持服务端自己的期限，不假设两者相同或固定为八小时。

首次启动后导入 SSO 配置，只能把状态变为“可登录”，不能绕过启动恢复重新发布旧凭据。账号切换必须先完成退出清理，再发起新登录。

Desktop 设备身份与账号会话分开管理，但共同参与 Realtime generation 的身份键。Main 每个进程只在首次读取设备身份时探测一次 macOS IOPlatformUUID 或 Windows MachineGuid，确认后必须在该进程内保持同一 deviceId；若探测暂时不可用且磁盘已有有效机器绑定，必须保留原绑定且不得更新时间戳或改写身份文件。只有新进程首次读取到不同的有效机器标识时才重新绑定。账号、session、endpoint 或确认后的 deviceId 真实变化仍必须失效旧 generation，且不得恢复或自动重放未完成请求。

## 凭据分发

Desktop 为 Agent Platform 签发 app token 时，从已经完成 SSO 验证的内存 canonical token 的 issuer 与 subject 派生稳定个人主体；不同账号或 issuer 必须得到不同主体，同一账号刷新 token 不改变主体。派生函数只做映射，不替代 SSO 签名和会话校验。Identity Center 继续通过既有 username 参数签发，保留 app scope 与 device claim，不改写服务配置或削弱应用 grant 的主体校验。连接器认证仍复用当前部署的一套凭据，subject 不用于选择连接器凭据目录。

token 缓存和 capability 并发签发按个人主体隔离；返回 token 的主体必须与请求相同，异步签发结束后还需确认 Desktop 当前身份未改变。Main、WorkPanel BTW 和 Selection Explain 使用同一身份 provider，不能让普通聊天和辅助流获得不同的身份边界。未登录时保留既有应用身份行为，但不能据此访问需要个人身份的连接器。

### Agent WebClient Host 与可信 Bridge

Agent WebClient guest 不接收 access token。普通 Platform 数据请求与 Run 实时请求都通过结构化 Platform Frame Port 收发对象帧；上传、下载、语音等显式 HTTP-only 请求继续经过 Desktop host，由 main 注入和刷新凭据。Frame Port 不暴露 URL、token 或 WebSocket 语义，Primary、BTW 与 Selection Explain 三条物理 lane、协议握手、存活、认证、RunChannel 和 upstream observer 都完全由 main 的全局 Broker 拥有。

```text
页面发送 Platform request frame
  -> 固定 preload Frame Port 转成专用 IPC
  -> main 从真实 sender 与 Surface Registry 派生身份和 capability
  -> main 使用自身凭据调用 host HTTP 或共享 Realtime Broker
  -> 逐帧定向返回 Platform response/stream/error，业务 push 按可信 Session 广播
```

页面不能访问通用主进程 API。Frame Port 必须校验 origin、来源窗口、session partition、route、owner Chat 与活动状态；Run frame 不能广播给其他 webview，也不能通过页面 URL 或 guest storage 传递 token。若可信 guest 的首次握手早于 Surface Registry 登记，Main 只能在 1500ms 有界窗口内等待，并必须在登记后重新执行全部校验；等待期间不能签发 token、连接 Broker 或转发 frame。这个窗口只用于 surface 注册和 Main Chat route/owner 收敛，不用于猜测 Run stream 是否就绪；Overview/Debug clone 等待 canonical `run.start` 时由 Broker 事件驱动，并在父 observer、context 或 generation 变化时确定性取消。Desktop 不保留 guest 业务 `/ws`、SSE query/attach 或 HTTP Run control 兼容面；Program manifest 缺少 `/api` 的 `agent-platform-access-token` 声明，或重新声明 `/auth`、`/ws`、Agent Platform WebSocket/SSE 时，安装与启动必须失败。

Frame Port contract 与 Agent WebClient bundle、vendored contract hash 和 Desktop 内置资源必须原子发布及回滚。旧 Realtime Bridge Desktop、旧 WebClient 或旧 manifest 与 Frame Port 任一侧混用都属于不兼容部署，不允许回退到 Standalone transport。

### 内置服务与 Host Bash

Desktop 通过受控文件协议把 canonical token 的路径交给 `agent-platform`。Platform 在创建普通智能体 Host Bash 时按需读取并注入，不把 token 放入 Desktop 全局环境或服务启动参数。

Workspace Terminal、容器、代理、ACP、MCP、LSP 与 sidecar 默认不继承该凭据。扩展新的注入面必须单独完成威胁分析和授权设计。

### 业务服务授权

Provider 登记由运行环境 `provider-register.json` 选择 Grant 或登录凭据模式，文件缺失时不获取 Key。Grant 模式保持一次性消费与成功清理；登录模式使用 main 持有的 canonical access token 和已确认的 Desktop 设备号直接向 Transit Hub 绑定并领取 Key，不创建中间 Grant，也不把 access token 或返回的 Key 写回登记文件。

Transit Hub 使用受信任公钥验证身份，以签发方、稳定用户 ID 和设备号作为绑定。重复领取返回同一 Key，不重置额度和有效期；服务端只在该受保护接口解密返回绑定 Key。Desktop 不从未经验证的 JWT claims 自行建立用户身份，也不接受页面传入用户 ID 或模型凭据。

两种模式都沿用 Electron 的 macOS/Windows 系统代理解析，省略 Cookie、拒绝重定向并设置请求超时。登录模式只允许无 URL 凭据、查询参数和片段的 HTTPS 配置地址；401 仅允许 main 刷新一次 canonical token，不能回退到 Grant。返回前重新验证当前 token、设备、登记配置和身份 generation，迟到响应不得覆盖其他账号的配置。网络和业务失败均不放行依赖服务，错误不包含原始凭据。

登录模式选中的 Provider 属于此登记策略管理，其 Key 可在登录后替换并在身份失效且消费者停止后清除；其他 Provider 与服务内部配置不受此流程修改。生命周期门禁见[启动初始化与恢复](启动初始化与恢复.md)。

企业聊天等业务服务使用 canonical token 在主进程内换取自己的短期 session 或一次性票据。派生凭据只存在于所属 runtime，不进入 renderer、webview、持久配置或日志。

Kanban、Market、Tunnel Hub、会话分享和 WebApp Tunnel 发布统一使用同一枚 canonical token。Cookie SSO 通过官网会话换回的结果直接发布为 canonical token；Desktop 不再启动额外 site-token bridge，也不持久化 `sso-site-token.json`。各消费者可以在 401 后请求 Main 刷新 canonical token 一次，但不能自行登录、换取或保存另一枚 Desktop access token。

Tunnel 的开启设置表达用户意愿，与当前认证状态分离。初始化导入和设置保存只校验地址与设备配置，不要求登录；未登录或认证暂不可用时保留开启设置，停止连接与重试，正常登录或认证恢复后自动连接。退出登录不改写开启设置，用户显式关闭后登录也不得自动开启。停止连接必须使在途注册与连接失效，迟到结果不能重新建立旧身份连接。

Tunnel Hub 不再为 Desktop 派生或持久化第二份 relay token/device secret。Main 使用当前 canonical SSO JWT 调用设备注册 API，并通过加密 WebSocket 的首个 `tunnel.open` 帧提交同一身份和 `deviceId`；Relay 必须验证 JWT 签名、issuer、audience、有效期、`tunnel` scope，以及该用户对设备的所有权。普通 Agent 的独立 bearer token 协议不受此约束影响。

对话分享使用一次请求内的最小凭据。Desktop main 读取当前 Tunnel site token 与经过校验的 API origin，只在直连 Tunnel 的标准 `Authorization: Bearer` 中使用；Platform 短期 token 仅随内部 Worker 消息进入 Snapshot 请求的标准 Header，不写入 URL、缓存、日志或错误信息。WebClient 模板请求不携带该 token，Platform 不接收、校验或转发 Tunnel token。Desktop renderer、IPC 结果、日志和错误文本不得包含任何 token；无登录、Tunnel 未启用或 origin 无效时，Desktop 必须在生成 HTML 前失败关闭。

## Session 与页面隔离

- 登录页面、Website 与普通 WorkPanel Web 使用 Electron 持久化默认 session，共享 Chromium 管理的应用 Cookie；WorkPanel 仍不获得 token 文件或 Token Bridge。
- 浏览器 profile 在 Electron ready 前固定；登录、恢复、换票与退出必须等待 Cookie store 完成写入或删除，不能以 DOM Storage 刷盘替代 Cookie 持久化。Cookie 的上游有效期保持不变，不把会话 Cookie 擅自延长为持久 Cookie。
- 品牌隔离由外层数据根承担。Chromium 状态归 Desktop state 层管理，SSO 不创建命名 partition，Cookie 直接保存在默认 session 的数据根。升级时仅在新 Chromium 根尚不存在的情况下，于任何 Session 打开前将旧 SSO 存储整体提升为默认 session，并保留其他命名 partition；已存在的新存储不被旧数据覆盖或合并。
- 普通 WebApp、Help、内置 Browser 与内置服务不因 URL 相似而继承该应用 Cookie session 或 SSO 能力。
- 登录成功后的页面刷新由显式 capability 控制，不根据路由或域名猜测。
- 退出只清理配置中已知的身份来源与派生 Cookie，不得清空默认 session 的全部 Cookie，也不影响无关网站数据。
- 认证头像只允许来自配置的可信官网来源；主进程下载并转换为品牌隔离的本地协议 URL。

## 安全与失败原则

- 登录与退出回调、内嵌登录代理仅在交互流程内按需监听，由操作系统分配动态空闲端口；配置中的端口不作为固定监听端口。授权、换票、退出回调与代理重写必须使用同一次分配的实际地址，上游认证服务必须允许原生客户端的动态回环回调，不能因白名单不兼容而退回固定端口。
- `localhost` 登录回调在 Windows 与 macOS 上同时监听 IPv4、IPv6 本机回环地址，保持回调 URL 与同一个登录状态一致，不依赖浏览器和 Node 的 DNS 地址族选择一致，也不监听通配网络接口。仅在操作系统明确不支持 IPv6 时允许 IPv4 单栈；端口冲突必须失败并释放已绑定的监听器。成功、失败、取消、等待超时与应用退出时统一关闭全部监听器；回调响应须能完整返回，旧请求的迟到清理不得关闭新一轮监听器。成功回调由宿主唤回 Desktop，成功页不再链接到已释放的本地端口。
- 凭据写入 secrets/state 层，不进入普通 config、命令行、页面 URL 或遥测。
- canonical 文件发布必须原子化；撤销失败应显式返回，不能假装退出完成。
- canonical access token 只有一个持久事实源；启动恢复会清理已退役的重复 site-token 文件，任何消费者都不得重新创建或读取它。
- 临时故障遵循 fail closed：当前运行不使用未经重新验证的站点身份。
- Tunnel Hub 身份 JWT 只能由 Main 放入 WSS 首帧，不进入 URL、renderer、日志或 Tunnel 配置；Relay 应在 JWT 到期时终止对应 Desktop session，Desktop 再通过正常刷新和重连取得新 JWT。
- `tunnel-hub-token`、`tunnel-hub-device-secret` 与旧 registration token 都是已废弃凭据；读取或保存 Tunnel Hub 设置以及 runtime 启动时必须清理，不得作为 SSO 缺失时的回退。
- JWT 的 `iat`、`exp` 仅在校验内部使用 Unix 秒；进入 shared contract 的时间点统一转换为 `EpochMilliseconds`，参见[时间契约](时间契约.md)。
- macOS 与 Windows 的凭据文件权限、脚本入口和系统 session 行为必须显式实现并分别验证。
- Desktop WebSocket 的客户端身份校验属于[桌面协议与动作桥](桌面协议与动作桥.md)，不得与页面 Token Bridge 混为一套协议。

## 事实来源

- 身份与 bridge 实现：`src/main/modules/identity/identity-center-auth.ts`、`src/main/modules/identity/agent-auth.ts`、`src/main/modules/identity/oidc-sso.ts`
- shared contract：`src/shared/auth-bridge.ts`
- webview 边界：`src/preload/service-webview-main-world.ts`
- Realtime/WorkPanel bridge：`src/main/modules/agent-platform/ipc.ts`、`src/shared/contracts/agent-webclient-bridge.ts`
- Tunnel Hub 身份桥：`src/main/modules/tunnel/registration.ts`、`src/main/modules/tunnel/runtime.ts`、`src/main/modules/tunnel/client-endpoint.ts`
- 恢复和安全语义：`test/oidc-sso.test.mjs`、`test/service-webview-main-world.test.mjs`

## 连接器的实例授权

连接器绑定、启用和凭据由当前 Platform 实例统一管理，不随 Desktop 登录账号切换。保留主线为应用访问签发的已验证个人主体及其 WebApp、会话权限边界，但该主体不用于选择连接器凭据目录。企业 SSO 继续用于市场可见性和 OneID 令牌供给；退出后 OneID 调用受企业会话有效性约束，其他连接器授权由显式解绑清理。

## 独立浏览器 WebClient 会话

Local services 的显式打开动作允许系统浏览器以当前 Desktop 的 Platform 身份访问同一实例。入口仅由主窗口顶层 frame 调用，Main 解析运行服务与目标，不接受页面传入任意服务地址。内嵌 guest 的 Frame Port 强约束不变；浏览器版是单独监听器上的明确 standalone 模式，不是缺少 Bridge 时的降级通道。

Main 只把短时、一次性打开票据放入浏览器 URL fragment。打开页先清除 fragment，再同源 POST 换取随机 HttpOnly、SameSite=Strict 会话 Cookie。票据和会话只存在内存，数量与有效期有界；IPC 只返回不含票据的服务地址，不返回 Platform 或 SSO token。首次打开及会话到期需回到 Desktop 再次点击打开。

HTTP 请求与 WS upgrade 校验精确 Host、Origin、会话及有效期；写请求与 WS 必须来自该入口的精确 origin。API 由 Main 注入可信 provider 签发的 Platform token，并忽略浏览器提交的授权和 Cookie；WS token 仅放入上游握手子协议，响应中移除该子协议，浏览器不可见。浏览器连接强制普通 WebClient source，不能声明 Desktop 物理 lane。所有票据、请求和长连接按已签发 token 的 issuer、subject、device 绑定当前身份；claims 读取仅用于可信 token 的身份比较，不替代验证。身份不匹配、SSO 失效或服务停止时不得沿用旧会话访问新身份。

浏览器版不注入 Electron、WorkPanel 或原生页面能力。浏览器内聊天、查看器与管理功能由 WebClient standalone 实现；Desktop 原生动作仍遵守既有 Run 与 Surface 授权，普通浏览器会话不产生这些授权。首版不代理独立语音服务，运行配置关闭语音入口。
