# 鉴权、SSO 与 Token Bridge

## 文档定位

本文描述 Desktop 的身份信任边界、登录与恢复流程，以及凭据向受信任运行面的传递原则。具体配置字段、IPC 类型、消息名和存储结构以源码、shared contract 与测试为准。

## 信任模型

Desktop 把身份能力拆成三层：

- `identity-center` 提供本地身份基础、密钥与 App access token。
- Desktop 主进程持有 SSO 会话、canonical access token 和派生凭据，并负责校验、换票、刷新与撤销。
- renderer、webview 和外部服务只获得完成当前任务所需的最小信息，不直接接触 Cookie、私钥或服务间短期票据。

主进程是凭据边界。renderer 只接收规范化用户状态、本地头像协议 URL 和经授权的短期结果；日志、URL、普通配置与页面上下文不得携带原始凭据。

## 登录模式

Desktop 支持标准 OIDC 与基于浏览器 Cookie 的站点 SSO。两种模式共用统一的运行时状态，但保持各自的上游会话语义。

Cookie SSO 的主流程为：

```text
专用 Electron session 完成登录
  -> 验证上游浏览器会话
  -> 取得稳定用户身份
  -> 交换 canonical access token
  -> 同步允许的 Cookie 与本地状态
  -> 发布 authenticated 状态
```

会话、用户信息和 access token 是三个独立结果。交互式登录允许部分成功并向用户说明缺失步骤；不能用某一步的成功伪造另一步，也不能从未经验证的 token claims 推导用户身份。

## 启动恢复

磁盘状态只是恢复候选，不是登录事实。主窗口创建前，恢复控制器只执行一次严格恢复：验证上游会话、确认稳定用户身份、重新换取 access token、刷新 Electron session，全部成功后才发布已登录状态。

恢复结果分为三类：

- `authenticated`：上游会话有效，以当前账号的新结果替换旧派生状态。
- `signed_out`：上游明确拒绝或已无会话，清除凭据、身份缓存及相关 Cookie。
- `temporarily_unavailable`：网络、限流或服务故障不能证明会话失效；保留恢复材料但本次运行保持未认证，后台单飞重试。

首次启动后导入 SSO 配置，只能把状态变为“可登录”，不能绕过启动恢复重新发布旧凭据。账号切换必须先完成退出清理，再发起新登录。

## 凭据分发

### Agent WebClient Host 与可信 Bridge

Agent WebClient guest 不接收 access token。普通 HTTP 请求继续经过 Desktop host，由 main 注入和刷新凭据；WebSocket-like Platform Frame Port 只收发序列化 Platform frame，物理连接和认证完全由 main 拥有。

```text
页面发送 Platform request frame
  -> 固定 preload Frame Port 转成专用 IPC
  -> main 从真实 sender 与 Surface Registry 派生身份和 capability
  -> main 使用自身凭据调用 host HTTP 或共享 Realtime Broker
  -> 逐帧定向返回 Platform response/stream/error，push 按可信 socket 广播
```

页面不能访问通用主进程 API。Frame Port 必须校验 origin、来源窗口、session partition、route、owner Chat 与活动状态；Run frame 不能广播给其他 webview，也不能通过页面 URL 或 guest storage 传递 token。Desktop 不保留 guest 业务 `/ws`、SSE query/attach 或 HTTP Run control 兼容面；Program manifest 缺少 `/api` 的 `agent-platform-access-token` 声明，或重新声明 `/auth`、`/ws`、Agent Platform WebSocket/SSE 时，安装与启动必须失败。

Frame Port contract 与 Agent WebClient bundle、vendored contract hash 和 Desktop 内置资源必须原子发布及回滚。旧 Realtime Bridge Desktop、旧 WebClient 或旧 manifest 与 Frame Port 任一侧混用都属于不兼容部署，不允许回退到 Standalone transport。

### 内置服务与 Host Bash

Desktop 通过受控文件协议把 canonical token 的路径交给 `agent-platform`。Platform 在创建普通智能体 Host Bash 时按需读取并注入，不把 token 放入 Desktop 全局环境或服务启动参数。

Workspace Terminal、容器、代理、ACP、MCP、LSP 与 sidecar 默认不继承该凭据。扩展新的注入面必须单独完成威胁分析和授权设计。

### 业务服务换票

企业聊天等业务服务使用 canonical token 在主进程内换取自己的短期 session 或一次性票据。派生凭据只存在于所属 runtime，不进入 renderer、webview、持久配置或日志。

Kanban、Market、Tunnel Hub 等消费者共享同一登录事实，但各自仍需遵守自己的服务边界和失败策略，不能各自启动隐式的第二套登录流程。

对话分享使用一次请求内的最小凭据转交。Desktop main 读取当前 Tunnel site token 与经过校验的 API origin，通过约定私有 header 调用本机 Agent Platform；Platform 自身 token 仍只放标准 `Authorization`。Platform 转发 Tunnel 请求后不持久化这些值，Desktop renderer、IPC 结果、日志和错误文本都不得包含 token 或私有 header 内容。无登录、Tunnel 未启用或 origin 无效时，Desktop 必须在调用 Platform 前失败关闭。

## Session 与页面隔离

- 登录页面和需要 Cookie SSO 的 Website 使用专用、持久化的 Electron partition。
- 普通 WebApp、Help、浏览器页面与内置服务不因 URL 相似而继承 SSO 能力。
- 登录成功后的页面刷新由显式 capability 控制，不根据路由或域名猜测。
- 退出只清理配置中已知的身份来源与派生 Cookie，不影响无关网站数据。
- 认证头像只允许来自配置的可信官网来源；主进程下载并转换为品牌隔离的本地协议 URL。

## 安全与失败原则

- 凭据写入 secrets/state 层，不进入普通 config、命令行、页面 URL 或遥测。
- canonical 文件发布必须原子化；撤销失败应显式返回，不能假装退出完成。
- 临时故障遵循 fail closed：当前运行不使用未经重新验证的站点身份。
- JWT 的 `iat`、`exp` 仅在校验内部使用 Unix 秒；进入 shared contract 的时间点统一转换为 `EpochMilliseconds`，参见[时间契约](时间契约.md)。
- macOS 与 Windows 的凭据文件权限、脚本入口和系统 session 行为必须显式实现并分别验证。
- Desktop WebSocket 的客户端身份校验属于[桌面协议与动作桥](桌面协议与动作桥.md)，不得与页面 Token Bridge 混为一套协议。

## 事实来源

- 身份与 bridge 实现：`src/main/identity-center-auth.ts`、`src/main/agent-auth.ts`、`src/main/oidc-sso.ts`
- shared contract：`src/shared/auth-bridge.ts`
- webview 边界：`src/preload/service-webview-main-world.ts`
- Realtime/WorkPanel bridge：`src/main/ipc/agent-webclient-bridge-handlers.ts`、`src/shared/contracts/agent-webclient-bridge.ts`
- 恢复和安全语义：`test/oidc-sso.test.mjs`、`test/service-webview-main-world.test.mjs`
