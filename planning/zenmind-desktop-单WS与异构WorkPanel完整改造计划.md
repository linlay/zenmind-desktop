# ZenMind Desktop 单 Agent Platform WS 与异构 WorkPanel 完整改造计划

> 目标仓库：`/Users/linlay/Project/zenmind/zenmind-desktop`  
> 配套 WebClient 计划：`planning/agent-webclient-双环境架构改造完整计划.md`  
> 本文是 Desktop 侧实施主计划；发生冲突时，以本文“已冻结决定”和配套 WebClient 计划中的已冻结决定为准。

## 1. 已冻结的产品与架构决定

### 1.1 复用一条 Agent Platform 业务 WS

同一 Desktop 登录身份、同一 Agent Platform endpoint 下，只允许 Main 进程持有一条 Agent Platform 业务 WebSocket。

- `/agent`、`/copilot`、`/summary`、`/debug`、`/project` guest 不直连 Agent Platform WS。
- Desktop Renderer 不持有 Agent Platform Token，也不建立这条业务 WS。
- Main 统一负责连接、鉴权、心跳、重连、request/response、stream、push 和反向 request。
- 一条物理连接可以承载多个逻辑 request 和多个 active stream。
- “一个可见 live stream”是 UI 投影规则，不是“只能运行一个 Run”。

这里的“单 WS”只约束 Agent Platform 业务实时连接，不包括：

- Desktop 自身的本地控制 WS；
- Voice ASR/TTS WS；
- IM、隧道、调试器或其他独立协议连接。

这些连接的协议、身份和生命周期不同，不强行合并。

### 1.2 不新增临时环境开关

继续直接使用现有 `DESKTOP_APP`：

- Desktop 启动内置 Agent WebClient 时保持 `DESKTOP_APP=true`；
- 不新增 `DESKTOP_RUN_BRIDGE_ENABLED`；
- 不要求 `DESKTOP_APP=true` 的 WebClient 服务实例同时被普通浏览器完整访问；
- Desktop 模式的 bridge 缺失、版本不兼容或鉴权失败必须显示阻断错误，不能静默回退成 guest 自连 WS。

`DESKTOP_APP` 只决定 WebClient 的运行装配。Desktop Main 的 Realtime Broker 是 Desktop 正式能力，不由第二个临时 flag 决定是否存在。

### 1.3 Realtime 统一所有权，Run/Push 分离能力

Desktop Main 对外提供统一的 Agent Platform Realtime Broker，但内部至少分开：

- Run：query、attach、control、response、stream；
- Push：连接级 `frame="push"` 订阅、过滤和扇出；
- Inbound Request：Platform 发往客户端的反向 request；
- Connection：鉴权、心跳、重连、状态和诊断。

不能把 `push` 塞进某个可见 Run 的 timeline，也不能为 Push 再建第二条 WS。

### 1.4 并发 Run，单可见流，多消费者

`/agent` 和 `/copilot` 可以同时运行。Desktop 同一时刻最多只有一个 UI 可见 Run binding：

- 主 Chat 是 primary consumer；
- Summary 和 Debug 可以同时作为该 binding 的只读 consumer；
- 同一个上游 stream 只 attach 一次，再由 Main 本地扇出；
- 后台 Run 继续在 Platform 运行，Main 继续 drain 其 stream，并维护必要的 seq/终态/有界 replay；
- 内部运行消费者不受“一个 UI 可见流”限制；
- 切换可见 Run 不等于 interrupt，也不允许重新发起已经 accepted 的 query。

Summary 的文件变化、Artifacts、Planning 等内容来自 live stream，不能只订阅 push。

### 1.5 `/agent`、`/copilot` 不再带 WebClient 右侧栏

Desktop 中的 `/agent`、`/copilot` guest 只承载各自主要内容。Summary 和 Debug 不再嵌在这两个页面内部：

- `/summary` 是独立 WebClient module Surface；
- `/debug` 是独立 WebClient module Surface；
- 由 Desktop WorkPanel 决定是否并排、显示在哪个 item、何时激活；
- Desktop 不尝试操纵 guest 内已不存在的 WebClient Sidebar。

### 1.6 WorkPanel 是 Desktop 的异构、保活容器

WorkPanel 同时支持：

- WebClient module WebView；
- Desktop 原生 React Surface；
- 普通 Web Surface。

切换 Tab、切换 Chat、切换外层 Desktop 路由，只改变 visible/active，不卸载、不关闭、不重新创建 guest。只有显式关闭 item、销毁 workspace 或应用退出才释放资源。

### 1.7 当前 Action 命名统一为 `desktop.workpanel.*`

新契约使用：

- `desktop.workpanel.getState`；
- `desktop.workpanel.openTab`；
- `desktop.workpanel.openWeb`；
- `desktop.workpanel.refreshWeb`；
- `desktop.workpanel.activateTab`；
- `desktop.workpanel.closeTab`；
- `desktop.workpanel.closeWorkpanel`。

Desktop 只接收正式 `desktop.workpanel.*` WorkPanel Action，不维护平行命名空间或隐式翻译层。

WorkPanel Action 采用断代升级，所有调用方原子切换到当前注册表。

### 1.8 本期默认不修改 Agent Platform

现有协议已经具备：

- `request/response/error` 按 request id 配对；
- `stream` 按 request id/stream id 路由；
- 一条连接维护多个 active stream；
- `push` 作为连接级通知。

因此 Surface 注册、权限、可见流选择、Main 到 guest 的扇出和 WorkPanel 生命周期由 Desktop 完成。本期不向 Agent Platform 泄漏 Electron Surface、WebView 或 WorkPanel 模型。

如果后续确认“多个 action-capable Run 并发时，Platform 反向 request 也必须精确定向”，再单独增加最小 opaque run correlation；不能让 Desktop 在来源不明确时猜目标。

## 2. 本次目标

1. 建立 Main 单例 `AgentPlatformRealtimeClient`，统一拥有 Agent Platform 业务 WS。
2. 建立 `RealtimeBroker`，在一条连接上复用多个 request、stream、push subscriber 和 Surface。
3. 建立可信的 Surface 身份与 capability 校验，guest 不能自报扩权。
4. 让 `/agent`、`/copilot`、`/summary`、`/debug` 通过窄 preload bridge 使用 Realtime Broker。
5. 支持 `/agent`、`/copilot` 并发 Run，同时只投影一个 UI 可见 live stream。
6. 让主 Chat、Summary、Debug 共享同一个 visible binding，不创建重复上游 attach。
7. 把当前 URL-only Chat WorkPanel 改造成异构、保活的 WorkPanel item 容器。
8. 落地 `desktop.workpanel.*`，让 WebClient OpenTargetIntent 和 Platform Desktop Action 进入同一命令服务。
9. 把现有 Assistant、Kanban、Pet 等 Agent Platform realtime consumer 迁到同一 Broker，消除永久并行连接。
10. 建立契约生成、测试、诊断、回滚和旧路径删除门禁。

## 3. 本次不做

- 不重写 Agent Platform 的 Run 语义或事件持久化。
- 不把 HTTP CRUD、历史查询、上传、资源 API 强行改成 WS。
- 不在 Desktop Main 重跑 WebClient 的完整 event processor。
- 不把 Summary/Debug 重新做成 Desktop 原生业务实现；它们仍是可独立使用的 WebClient module。
- 不要求同一个 `DESKTOP_APP=true` 服务实例兼容完整 Website Shell。
- 不把 WorkPanel item 定义泄漏到 Agent Platform 通用 WS frame。
- 不顺手重构无关的 Voice、IM、本地 WS 或插件协议。
- 不改变 Kanban Issue 的 Server-authoritative 边界和允许的原子操作集合。

## 4. 当前基线与需要替换的所有权

### 4.1 现有可复用基础

当前 Desktop 已具备以下基础，可渐进改造，不需要推倒重写：

- `src/main/assistant/core/assistant-ws-transport.ts` 已处理 `stream/error/response/push/request` frame，并维护多个 query；
- BrowserSurfaceRegistry 已能记录 Agent Chat、Copilot 和 Chat WorkPanel guest；
- `EmbeddedSurfaceHosts.tsx` 已长期挂载 Agent/Copilot service webview；
- AppShell 当前会保留多个 Chat WorkPanel workspace，只切 active/visible；
- `desktop-action-bridge.ts` 与 renderer action registry 已能承接 Desktop Action；
- service manager 已显式向 Agent WebClient 注入 `DESKTOP_APP=true`。

这些能力应被泛化或接入新模型，而不是再旁路实现一套。

### 4.2 当前冲突点

需要消除以下冲突：

1. `AssistantWsTransport` 目前是 Assistant 专用 owner，WebClient 仍可能拥有自己的 WS；目标是一个共享 Realtime owner。
2. 当前 Chat WorkPanel contract 主要是 `{url,title}`，不能表达 Summary、Debug 或 Native Surface。
3. WorkPanel Action 只允许当前 `desktop.workpanel.*` 契约，不维护平行动作 namespace。
4. 当前 `ChatWorkPanelSurface` 基本只包装 `ExternalWebviewPage`，不能承载判别联合 item。
5. 当前 guest 与 Main 之间没有完整的 Run/Push/visible binding bridge contract。
6. 当前 push 处理主要服务既有 Assistant 行为，尚未形成多 Surface typed subscription。

### 4.3 不能形成的中间态

以下中间态不允许进入可发布版本：

- WebClient guest 自连 WS 与 Main Broker 同时作为正式 owner；
- Assistant 使用旧 WS、WebClient 使用新 WS，两条连接永久并存；
- Summary 为了显示同一 Run 再单独 attach；
- 两套 Action 入口各维护一份 WorkPanel state；
- bridge 失败后单次操作偷偷回落到旧 WS；
- accepted query 因切换 Surface 或重连被重新提交。

## 5. 目标架构

```text
Agent WebView (/agent) -----------\
Copilot WebView (/copilot) --------\
Summary WebView (/summary) ---------> narrow preload bridge
Debug WebView (/debug) ------------/            |
Desktop internal consumers --------/             v
                                         RealtimeBroker
                                   /          |          \
                              RunRegistry   PushRouter   VisibleRunCoordinator
                                   \          |          /
                                    AgentPlatformRealtimeClient
                                                 |
                                    one Agent Platform WS
                                                 |
                                          Agent Platform
```

WorkPanel 独立于 Realtime 物理层：

```text
WebClient OpenTargetIntent ----\
Platform desktop.workpanel.* ----> WorkPanelCommandService
Desktop native UI ------------/          |
                                         v
                                WorkPanel workspace state
                              /             |             \
                    WebClient module     Native item     Web item
                    ServiceWebview       React Surface   ExternalWebview
```

### 5.1 状态所有权

| 状态 | 唯一 owner |
| --- | --- |
| Agent Platform 物理 WS、鉴权、重连 | Main `AgentPlatformRealtimeClient` |
| pending request、active stream、push subscription | Main `RealtimeBroker` |
| UI 可见 Run 与消费者集合 | Main `VisibleRunCoordinator` |
| Run canonical history、canonical seq | Agent Platform |
| WebClient conversation projection | 各 WebClient module guest |
| WorkPanel workspace、item 顺序、active item | Desktop Renderer/AppShell store |
| WorkPanel 指令校验与来源绑定 | Main + renderer command boundary |
| WebView 身份、origin、partition、owner | BrowserSurfaceRegistry/Main |

Main 只保存路由所需的最小运行状态和有界 replay，不成为第二个 Run 数据库。

## 6. Agent Platform Realtime Client

### 6.1 物理连接键

按稳定键维护连接：

```ts
type RealtimeConnectionKey = {
  endpoint: string;
  identitySessionId: string;
};
```

同一个键最多一个 active client。身份切换、退出登录或 endpoint 变化时，必须先使旧 client 进入 closing，清理订阅，再建立新 client，不能短暂双 owner。

### 6.2 Client 职责

`AgentPlatformRealtimeClient` 只负责协议与连接层：

- 建连与鉴权；
- Token 获取、刷新和过期处理；
- 心跳与连接健康；
- request id 生成和 frame 编解码；
- pending response/error 配对；
- stream/push/request frame 交给 Broker；
- 指数退避、抖动和可取消重连；
- 连接级 backpressure、最大 frame 和协议错误；
- metrics 与结构化诊断。

它不感知 React、WorkPanel Tab 或 WebClient 页面组件。

### 6.3 从 `AssistantWsTransport` 泛化

优先提取现有 transport 中已经稳定的：

- URL/鉴权构造；
- frame parser；
- 心跳；
- query/attach/control primitives；
- reconnect 和 close 语义。

目标不是让新 Broker 包住一个永久的 Assistant owner，而是把物理 client 泛化后，让 Assistant 变成 Broker 的 adapter/client。

迁移完成后，禁止以下依赖方向：

```text
RealtimeBroker -> AssistantWsTransport
```

允许：

```text
AssistantRuntime -> AssistantRealtimeAdapter -> RealtimeBroker
```

## 7. Realtime Broker

### 7.1 建议状态模型

```ts
type RealtimeBrokerState = {
  pendingRequests: Map<UpstreamRequestId, PendingRequest>;
  runsById: Map<RunId, BrokerRun>;
  streamsByRequestId: Map<UpstreamRequestId, BrokerStream>;
  subscriptionsById: Map<SubscriptionId, LocalSubscription>;
  pushSubscriptionsByType: Map<string, Set<SubscriptionId>>;
  visibleBinding: VisibleRunBinding | null;
};

type LocalSubscriber =
  | { kind: "surface"; surfaceId: string; capability: SurfaceCapability }
  | { kind: "internal"; consumerId: string };
```

具体字段以现有 Platform frame 和 Desktop 类型为准，但以下索引关系必须显式存在：

```text
real IPC sender/webContents
  -> registered surface
  -> local request/subscription
  -> upstream request/stream
  -> runId + lastSeq
```

### 7.2 frame 路由

- `response`：严格按上游 request id 完成对应 pending request。
- `error`：严格按 id 失败对应 request/stream，并保留稳定错误码。
- `stream`：按 request id/stream id 找到 active stream，校验 run/seq 后交给 RunRegistry。
- `push`：交给 PushRouter，按 type/filter 扇出，不广播到所有 Surface。
- `request`：交给 InboundRequestRouter，完成 target/capability 校验后定向，无法证明目标时 fail closed。
- 未知 frame/id、重复 terminal、seq 回退和非法 shape：记录诊断并拒绝，不猜测、不广播。

### 7.3 Query、Attach 与共享订阅

- 每次新 query 只产生一个上游 request id。
- 收到 accepted/run identity 后固定 `runId`，断线或 Surface 切换不能重新 query。
- 同一 Run 的 attach 使用 singleflight；多个本地 subscriber 共享一个上游 attach。
- 每个本地 subscriber 有独立 subscription id 和消费 cursor。
- 本地 detach 只移除一个 subscriber。
- 最后一个 UI subscriber 离开不自动 interrupt Run。
- 是否保留上游 attach 由 Run 生命周期和内部 consumer 决定，不由 WebView 是否可见直接决定。
- interrupt/cancel/steer/submit 等控制操作按真实 Run 权限执行，不能由 Summary/Debug 发起。

### 7.4 Replay 与 backpressure

Main 为活动 Run 保留有界 ring buffer，只用于：

- IPC 短暂阻塞；
- visible binding 切换窗口；
- 新本地 consumer 的短距离补帧；
- 重连后的 seq 对齐诊断。

建议初始上限：每 Run `2000 events` 或 `4 MiB`，先达到者淘汰；IPC 建议按 `32 events` 或 `64 KiB` 批量投递。它们是性能初值，不是协议常量，D12 压测后调整。

超过本地 replay 范围时：

1. 向 consumer 返回稳定的 `replay_required`/`seq_expired`；
2. WebClient 通过 HTTP/canonical history 重建 projection；
3. 再从正确 lastSeq attach；
4. 禁止 Main 伪造缺失事件。

### 7.5 内部消费者不受 UI 可见限制

Assistant、Kanban、Pet 或其他 Main 内部流程如果确实需要后台 Run raw stream，可作为 `kind="internal"` subscriber 订阅目标 Run。

“一个可见 stream”只限制 WebClient UI raw live projection；不能因此丢弃业务内部需要处理的后台事件。

## 8. Visible Run Coordinator

### 8.1 Binding 模型

```ts
type VisibleRunBinding = {
  epoch: number;
  chatId: string;
  runId: string;
  upstreamRequestId: string;
  primarySurfaceId: string;
  consumerSurfaceIds: Set<string>;
};
```

`consumerSurfaceIds` 通常包含：

- 当前可见 `/agent` 或 `/copilot`；
- 同 workspace 的 `/summary`；
- 用户已打开的 `/debug`。

Summary/Debug 没有资格成为 primary，也没有 Run control 权限。

### 8.2 绑定切换

切换顺序固定为：

1. AppShell/可信 Desktop 导航确定新的主 Surface 与 chat/run；
2. Main 校验该 Surface、owner workspace、run 归属；
3. `epoch += 1`，原子替换 visible binding；
4. 新 consumer 先获取 snapshot/canonical replay；
5. 从正确 cursor 开始接收 live batch；
6. guest 丢弃旧 epoch 的迟到消息。

guest 不能通过自报 `chatId/runId` 抢占 visible binding。visibility、active tab 和 primary owner 必须来自 Desktop 可信状态。

### 8.3 后台 Run

后台 active stream：

- Main 继续读取，避免 WS backpressure；
- RunRegistry 更新 lastSeq、terminal 和轻量指标；
- 不把 raw event 广播给当前可见页面；
- 对显式内部 subscriber 继续定向投递；
- UI 的轻量 running/completed/awaiting 提示主要通过 push；
- 用户切回时先 canonical replay，再进入新 visible binding。

### 8.4 主 Chat、Summary、Debug 同流

同一个上游 event：

- 对同 guest 只投递一次，由 WebClient 内部共享 projection；
- 对不同 guest 按各自 subscription 投递一次；
- 不因为增加 Summary/Debug consumer 创建第二个 attach；
- consumer 离开只清理自己的 cursor/listener。

## 9. Push Router

### 9.1 Push 与 Stream 边界

`frame="stream"` 用于 Run 的高数据量、顺序敏感 live event。`frame="push"` 用于连接级、低数据量通知，例如运行状态、awaiting、资源或其他 topic 提醒。

不能用 push 替代 Summary 所需的文件变化 live stream，也不能把所有 push 注入 conversation eventProcessor。

### 9.2 订阅模型

```ts
type PushSubscription = {
  subscriptionId: string;
  subscriber: LocalSubscriber;
  types: string[];
  filter?: {
    chatId?: string;
    runId?: string;
    resourceId?: string;
  };
};
```

要求：

- 多个 subscriber 可订阅同一 type；
- 一个 subscriber 可订阅多个 type；
- unsubscribe 幂等；
- Surface 销毁自动清理；
- 重连后恢复本地订阅视图，不要求 guest 重建第二条连接；
- 未识别 type 不能广播；
- filter 的字段和值必须按当前协议与 Surface owner 校验。

## 10. Surface 身份、Capability 与 Preload

### 10.1 Main 计算真实身份

Main 从以下信息组合确定 Surface：

- IPC sender/webContents/frame；
- BrowserSurfaceRegistry；
- service id 和 surface kind；
- partition；
- 实际 origin 和 route；
- AppShell 当前 workspace/owner chat；
- guest 是否 active/visible。

不信任页面传入的：

- surfaceId；
- capability；
- owner chat/workspace；
- arbitrary route/URL；

### 10.2 Capability 矩阵

| Surface | Run request | Run control | Visible raw stream | Push | OpenTarget |
| --- | --- | --- | --- | --- | --- |
| `agent-chat` | 自身上下文 | 自身 Run | primary | 是 | 是 |
| `agent-copilot` | 自身上下文 | 自身 Run | primary | 是 | 是 |
| `agent-summary` | 否 | 否 | 只读 consumer | 是 | 是 |
| `agent-debug` | 否 | 否 | 只读 consumer | 是 | 受限 |
| `agent-project` | 否 | 否 | 默认否 | 受限 | 是 |
| 普通 Web item | 否 | 否 | 否 | 否 | URL 自身导航 |
| Native item | 按 allowlist | 按 allowlist | 按 allowlist | 按 allowlist | 按 allowlist |

具体 capability 必须由 Main 的 allowlist 显式赋予，不能用“非禁即允”。

### 10.3 Bridge 形状

建议分成两个领域 bridge，避免 WorkPanel 能力和 Realtime 混成任意 RPC：

```ts
window.__AGENT_WEBCLIENT_REALTIME_BRIDGE__ = {
  hello(),
  request(input),
  subscribe(input),
  unsubscribe(subscriptionId),
  onMessage(listener),
};

window.__AGENT_WEBCLIENT_WORKPANEL_BRIDGE__ = {
  openItem(intent),
  activateItem(input),
  closeItem(input),
};
```

要求：

- 固定 IPC channel；
- 参数和返回值都经过 schema 校验；
- 不暴露 `ipcRenderer`、Token、任意 channel 或任意 Electron API；
- Main 直接向目标 guest 投递高频 batch，不经 Desktop renderer 二次转发；
- 每个 guest 只有一个 message listener owner；
- reload、pagehide、destroy、render-process-gone 时完整清理；
- `hello` 返回 contract version、capabilities、surface identity 的只读摘要和连接状态。

### 10.4 契约版本

Desktop 保存手写 canonical contract，WebClient 使用确定性脚本生成 mirror。建议包含：

- contract version；
- hello/capability；
- request/response/error；
- run subscribe/unsubscribe/control；
- stream batch 与 epoch；
- push subscription/filter；
- stable error codes；
- WorkPanel intent/item DTO。

契约不包含 Electron 实例、React state、函数或 Main 内部类。

Desktop build/test 必须包含 `generate --check`，防止 Desktop canonical 与打包的 WebClient mirror 漂移。

## 11. 统一反向 Request

### 11.1 Platform 选择 provider

Agent 只提交统一的 `desktop.*` action。Platform 使用当前 run 的内存 target，并按 runtime mode 选择 provider：Desktop 模式发送 `desktop.action.call` 给 Desktop Main Broker；Standalone 模式只把 `desktop.workpanel.*` 发给根 agent-webclient。`/agent*`、`/copilot*` 等 guest 不处理反向动作。

### 11.2 `desktop.workpanel.*`

- Desktop 模式由 Main 直接执行；
- Main 校验 action 名称、来源上下文、参数和 owner workspace；
- 转成内部 `WorkPanelCommand`；
- Renderer command service 更新唯一 WorkPanel state；
- 返回稳定的 item/workspace 结果或错误。

### 11.3 Fail closed

Platform 找不到当前 run target、连接已断开或 runtime 不支持该 action 时直接返回结构化错误。Desktop Broker 对未知 request type 返回 `unsupported_in_current_view`；任何一层都不得广播、猜测或选择其他连接。

## 12. WorkPanel 领域模型

### 12.1 判别联合 item

建议 canonical DTO：

```ts
type WorkPanelItemDescriptor =
  | {
      kind: "webclient";
      module: "summary" | "debug" | "project" | "agent" | "copilot";
      route: string;
      context: WorkPanelContext;
      stableKey: string;
    }
  | {
      kind: "native";
      surfaceKey: NativeWorkPanelSurfaceKey;
      context: WorkPanelContext;
      stableKey: string;
    }
  | {
      kind: "web";
      url: string;
      title?: string;
      stableKey: string;
    };

type WorkPanelItem = {
  itemId: string;
  descriptor: WorkPanelItemDescriptor;
  title: string;
  closable: boolean;
  pinned: boolean;
  createdAt: number;
};

type WorkPanelWorkspace = {
  workspaceId: string;
  ownerChatId: string;
  items: WorkPanelItem[];
  activeItemId: string | null;
};
```

`context` 只放身份与展示所需的小型可序列化字段，例如 chatId、runId、artifactId、file identity。禁止放 Token、完整事件数组、React state 或任意本地权限对象。

### 12.2 Item renderer

- `kind="webclient"`：使用 Agent WebClient 的 Service WebView host，按 allowlisted module route 加载。
- `kind="native"`：从 Native Surface allowlist 选择 React component，不能通过字符串动态 import 任意模块。
- `kind="web"`：复用现有 `ExternalWebviewPage` 的导航、权限和 CDP 安全能力，但一个 item 对应一个 Web Surface。

WorkPanel 自己拥有顶层 item/tab，不允许 WebClient `/agent` 或 `/copilot` 再嵌一层 Summary/Debug 右栏和重复 tab owner。

### 12.3 生命周期

- item 创建后保持 mounted；
- active 切换只改变可见性、焦点和快捷键归属；
- workspace 切换只隐藏，不销毁；
- hidden WebView 保持页面状态和 subscription，但停止不必要的焦点、快捷键和绘制；
- hidden Native Surface 保持组件 state，暂停可暂停的昂贵 render/effect；
- 显式 close 只销毁目标 item；
- pinned/non-closable 核心 item 在 workspace 生命周期内不能被普通 close；
- 应用退出按先停止投递、后销毁 guest、最后关闭 Broker 的顺序清理。

macOS 与 Windows 对 WebView 可见性、focus、background throttling、快捷键和窗口恢复行为不同，必须在靠近实现的位置写显式平台分支并分别验证。

### 12.4 默认组合

Agent/Copilot workspace 的建议默认组合：

- 主 Chat/Copilot 位于主要内容区；
- WorkPanel 默认提供 `/summary` companion item；
- `/debug` 作为独立可打开 item；
- 文件、Artifact、Planning、Project 和 Web 目标按点击创建或激活；
- 核心 companion 可设为 pinned/non-closable，详情 item 可关闭。

是否默认显示 Debug 可以由现有开发/调试配置决定，但 Debug 必须是正式独立 module/item，不再依附 `/agent` 或 `/copilot` 内部右栏。

### 12.5 Stable key 与去重

建议规则：

- Summary：`summary:{chatId}`；
- Debug：`debug:{chatId}:{runId-or-current}`；
- Project：`project:{projectId}`；
- File diff：`file-diff:{runId}:{normalizedProjectRelativePath}`；
- Artifact：`artifact:{artifactId}`；
- Planning：`planning:{chatId}:{nodeId}`；
- Web：规范化后的 http/https URL。

重复 `openItem`：

- stable key 已存在 -> 更新允许更新的 display context，并 activate；
- 不存在 -> 创建并 activate；
- 不能仅用 title 去重；
- 本地路径必须先归一化并证明属于允许的 project/workspace。

## 13. WorkPanel Command Service 与 Action 契约

### 13.1 新 Action

```ts
desktop.workpanel.getState({ workspaceId? })
desktop.workpanel.openTab({ descriptor })
desktop.workpanel.openWeb({ url })
desktop.workpanel.refreshWeb({ url })
desktop.workpanel.activateTab({ tabId })
desktop.workpanel.closeTab({ tabId })
desktop.workpanel.closeWorkpanel()
```

调用方不能任意指定其他 Chat 的 workspace。Main 从可信 action source 或 Surface owner 推导实际 workspace，再与参数交叉校验。

### 13.2 两个 ingress，一个状态机

以下入口必须归一化到同一个 `WorkPanelCommandService`：

- WebClient Summary/Project 的 OpenTargetIntent；
- Agent Platform 的 `desktop.workpanel.*`；
- Desktop 原生菜单/按钮；

不能让 preload bridge、Desktop Action Bridge 和 UI click 各自修改 workspace map。

### 13.3 Action 原子切换

Action 定义、Main 分发、renderer provider、内部菜单调用、自动测试和调用方必须在同一版本切到当前 `desktop.workpanel.*` 契约。未知 namespace、旧动作名和旧参数一律返回 `unknown_action` 或 `invalid_request`，不做兼容转换。

### 13.4 安全校验

- Web URL 只允许 `http:`、`https:`，以及明确保留的 `about:blank` 兼容场景；
- WebClient module 与 route 使用 allowlist；
- Native `surfaceKey` 使用编译期联合与运行时 allowlist；
- file/path 只能使用经 project/workspace 归属验证的身份，不接受任意 `file://`；
- 禁止 JavaScript URL、任意 preload、任意 Electron webPreferences；
- Token 不进入 route、query、item descriptor 或持久化 WorkPanel state；
- guest 不能构造 item 打开其他 chat/workspace 的受限内容。

## 14. Summary、Debug、Project 在 Desktop 中的装配

### 14.1 Summary

- 使用 WebClient `/summary` route；
- 由 Desktop 注入只读 owner context，不由 URL 携带敏感状态；
- 订阅当前 visible binding 的 live stream 和必要 push；
- 不具备 query、interrupt、steer、submit 能力；
- 文件变化/Artifact/Planning 点击发语义化 OpenTargetIntent；
- 切换 visible Run 时递增 epoch，并先恢复 snapshot/replay；
- Summary item 切换隐藏后不卸载。

### 14.2 Debug

- 使用 WebClient `/debug` route；
- 作为独立 WorkPanel item；
- 只读观察当前 visible binding 的原始/派生诊断和连接状态；
- 不参与 Platform 反向 Action 路由；
- 默认不接收 Token、Main 内部对象或其他 Run 的未授权数据；
- 是否默认打开由 Desktop 调试配置决定，不影响其独立模块地位。

### 14.3 Project

- 使用 WebClient `/project` route 或 Desktop 现有原生 Project Surface，按最终产品 owner 选择；
- 默认不订阅 Run raw stream；
- 只通过必要的 PushTransport、HTTP 数据和 OpenTarget bridge 工作；
- Project route 不恢复 WebClient 全站 Sidebar。

### 14.4 Agent/Copilot

- 继续使用当前长期挂载的 service webview 机制；
- route 内不再有 WebClient Summary/Debug 右栏；
- active/visible 由 Desktop 控制；
- Run request/control 走 Realtime bridge；
- 同时运行时保持两个 Run，但只有 active binding 的 raw live projection进入可见 UI。

## 15. 现有 Desktop Consumer 迁移

### 15.1 Assistant

建立 `AssistantRealtimeAdapter`，保持现有 Assistant 上层 API 尽量不变：

- query/attach/control 映射到 Broker；
- 完成文本等临时消费使用有生命周期的 internal subscriber；
- Assistant 的既有 event 解析保持在 Assistant 层；
- 不在 adapter 内重新管理 WS、心跳或重连。

迁移完成验收：进程内不再存在可建立第二条 Agent Platform 业务 WS 的 Assistant transport owner。

### 15.2 Kanban

只迁移底层 Run realtime transport，不改变 Issue 协议：

- 不调用已移除的 public issue endpoint；
- 保持 Server-authoritative read-only cache；
- 保持允许的 `issue.claim`、`issue.run.prepare`、`issue.chat.bind/unbind`、`run.event.append` 等边界；
- 不新增 `issue.claimAndRun`，不从 Desktop 调 Website 的 `issue.run.request`。

### 15.3 Pet 与其他 consumer

- 搜索所有 Agent Platform WS 创建点；
- 将 Pet/background monitor 等迁为 Broker internal subscriber；
- 删除各自 attach/reconnect/timer owner；
- HTTP-only consumer 不为追求形式统一而迁移；
- 在 CI 增加静态门禁，禁止受控目录新增 Agent Platform `new WebSocket(...)`。

## 16. 重连、恢复与终态

### 16.1 断线

- 未完成的普通 pending request 明确失败为稳定的 connection error；
- 已 accepted 的 Run identity 保留，不能重发 query；
- active stream 标记 suspended；
- visible binding 保留 identity 但暂停 live delivery；
- UI 显示可恢复状态，不把断线误判为 Run cancelled。

### 16.2 重连成功

顺序建议：

1. 完成鉴权与 protocol hello；
2. 恢复连接级 push 能力；
3. 对仍有 consumer 的 Run 获取 canonical 状态；
4. 从合法 lastSeq attach/sync；
5. 处理 `seq_expired` 或 gap；
6. 确认新 epoch 后恢复 visible delivery。

### 16.3 终态与幂等

- terminal event/error 每个 stream 只结算一次；
- 重复 done、迟到 batch、旧 connection generation frame 被丢弃并计数；
- detach/unsubscribe/close 幂等；
- Surface crash 只清理该 Surface 的本地资源；
- 最后一个 UI consumer 离开不自动 cancel Run；
- 应用退出可以停止本地 attach，但不能伪造 Platform Run 终态。

## 17. 性能与可观测性

### 17.1 必备指标

- Agent Platform physical connection count；
- connection generation、reconnect count、auth refresh failure；
- pending request count/latency；
- active upstream stream count；
- local subscriber count，按 Surface/internal 分类；
- push subscription count/type；
- visible binding epoch 与 consumer 数；
- replay buffer event/byte 水位和 eviction；
- IPC batch 大小、频率、queue latency；
- dropped stale epoch、unknown id、duplicate terminal、seq gap；
- Surface register/unregister 与泄漏检查；
- unknown WorkPanel Action 调用量。

日志不得包含 Token、完整 prompt、敏感文件内容或整段 event payload。

### 17.2 诊断面板

Desktop 内部诊断应能看到：

- 当前物理连接状态和 generation；
- active streams 的匿名/最小标识；
- visible binding；
- Surface capabilities 与订阅数；
- WorkPanel workspace/item 生命周期；
- 最近稳定错误码。

WebClient `/debug` 是业务/传输观察 Surface，不等于开放 Main 的全部内部诊断权限。

## 18. 分阶段执行计划

### D0：设计文档、基线与契约冻结

1. 按仓库要求阅读：
   - `README.md` 第 6 节；
   - `docs/README.md`；
   - `docs/架构与模块边界.md`；
   - `docs/前端嵌入与导航.md`；
   - `docs/鉴权SSO与TokenBridge.md`；
   - `docs/桌面协议与动作桥.md`；
   - `docs/智能助理集成.md`；
   - `qa/manual-regression.md`。
2. 枚举全部 Agent Platform WS 创建点、query/attach/control 调用点和 push consumer。
3. 记录 baseline：连接数、并发 Run、Summary 文件变化、WorkPanel 生命周期。
4. 冻结 Desktop/WebClient canonical contract 和 stable error codes。
5. 明确 `DESKTOP_APP` 是唯一 WebClient 运行模式配置。

完成条件：能画出当前每条 Agent Platform WS 的 owner 和调用方；配套 WebClient plan 与本文无契约冲突。

### D1：泛化 Agent Platform Realtime Client

1. 从 `AssistantWsTransport` 提取连接、鉴权、frame parser、heartbeat、reconnect primitives。
2. 建立每 endpoint/identity 单例 owner。
3. 增加 connection generation，拒绝旧连接迟到 frame。
4. 保持现有 Assistant 行为测试通过，但此阶段不新增第二条连接。
5. 增加协议错误、unknown frame 和 max frame 测试。

完成条件：新 client 能独立处理 response/error/stream/push/request，且不依赖 Assistant UI。

### D2：Realtime Broker Run/Request 核心

1. 建立 pending request、runs、streams、local subscriptions 索引。
2. 实现 query accepted 后 run identity 固定。
3. 实现同 Run attach singleflight 与多本地 subscriber。
4. 实现 terminal/detach/unsubscribe 幂等。
5. 建立有界 replay 和 seq/gap 检查。
6. 增加多 active stream 路由测试。

完成条件：一条 fake WS 上两个并发 Run 的 stream 互不串线。

### D3：Push Router 与 Visible Run Coordinator

1. 实现 typed Push subscription/filter/fanout。
2. 实现零或一个 visible binding。
3. 实现 epoch 切换和旧 batch 丢弃。
4. 支持 Agent/Copilot primary + Summary/Debug consumers。
5. 明确 background stream 和 internal subscriber 行为。
6. 增加切换、隐藏、恢复和多 consumer 测试。

完成条件：Agent/Copilot 可并发；主 Chat + Summary 同流；UI 只显示一个 live Run。

### D4：Canonical Contract 与生成门禁

1. 在 Desktop `src/shared/contracts/` 建立手写 canonical DTO。
2. 增加确定性生成脚本，把 mirror 生成到 Agent WebClient 约定位置。
3. 增加 `--check` 和 CI/build 门禁。
4. 定义 hello/version/capability 协商。
5. 定义 mismatch 的阻断错误和可诊断 UI。

完成条件：修改 canonical 后未更新 mirror 会导致检查失败。

### D5：Surface Registry、IPC 与 Preload

1. 扩展 Surface kind：agent-chat、agent-copilot、agent-summary、agent-debug、agent-project。
2. 从真实 sender/origin/partition/route 推导 capability。
3. 实现窄 Realtime Bridge 与 WorkPanel Bridge。
4. Main 直接向 guest 批量投递，不经 renderer 转发高频 event。
5. 实现 guest reload/crash/destroy 全量清理。
6. 加入伪造 surface/chat/run/capability 的拒绝测试。

完成条件：guest 无 Token、无任意 IPC、无自报扩权路径。

### D6：WorkPanel Canonical Model 与 Command Service

1. 把 URL-only workspace/tab contract 改成 discriminated item union。
2. 建立唯一 WorkPanelCommandService。
3. 落地 `desktop.workpanel.*`。
4. Main 绑定可信 owner workspace/chat/run。
5. 实现 stable key 去重与安全校验。
6. Action 定义、分发与状态只保留当前协议。

完成条件：所有 ingress 修改同一份 workspace state，新旧 open Web URL 行为一致。

### D7：异构 WorkPanel Renderer

1. 拆分 `WorkPanelHost`、`WorkPanelItemHost` 和三类 item renderer。
2. WebClient item 使用 Service WebView host。
3. Native item 使用 allowlisted React Surface。
4. Web item 复用 ExternalWebview 安全层。
5. 所有 item/workspace 保持 mounted，仅切 visible/focus。
6. 增加 pinned/non-closable 和 explicit close 生命周期。
7. 分别处理 macOS/Windows WebView hide/focus/background 行为。

完成条件：三种 item 同时存在、反复切换不 reload、不丢 state、不新增 AP WS。

### D8：WebClient Agent/Copilot Bridge 闭环

1. 与配套 WebClient 计划的 `DesktopRealtimeTransport` 对接。
2. `/agent`、`/copilot` 使用 Run/Push bridge，不再自连 WS。
3. 两个 guest 同时运行不同 Run。
4. Desktop trusted navigation 控制 visible binding。
5. bridge missing/version mismatch 阻断，不 fallback。

完成条件：Desktop 内 Agent/Copilot 并发时 Agent Platform 业务 WS 物理连接数仍为 1。

### D9：Summary 与 Debug 独立 WorkPanel Item

1. WorkPanel 可创建 `/summary` 和 `/debug` WebClient item。
2. Summary/Debug 只读订阅 visible binding。
3. 主 Chat + Summary/Debug 共享一个上游 attach。
4. Summary 文件变化、Artifact、Planning live 更新。
5. Debug 不参与 Platform 反向 Action 路由。
6. 切换 chat/run 使用 epoch + snapshot/replay。

完成条件：Summary 与主 Chat 同屏无重复 upstream attach，隐藏/显示不丢状态。

### D10：OpenTarget 与 `desktop.workpanel.*` 闭环

1. WebClient intent 经 preload 进入 WorkPanelCommandService。
2. Platform Desktop Action 进入同一 service。
3. 文件、Artifact、Planning、Project、Web 目标使用 stable key。
4. 重复点击 activate，不重复建 item。
5. 非法 path、URL、cross-workspace context 被拒绝。
6. 新调用全部使用 `desktop.workpanel.*`。

完成条件：Summary 点击能打开/激活正确的 WebClient、Native 或 Web item。

### D11：Assistant、Kanban、Pet 与其他消费者迁移

1. Assistant 上层 API 改接 Adapter/Broker。
2. Kanban 仅替换 Run transport，不改变 Issue 协议边界。
3. Pet/background consumer 使用 internal subscription。
4. 枚举并迁移剩余 Agent Platform WS owner。
5. 加静态扫描，禁止受控目录新增直连。

完成条件：生产路径不存在第二个 Agent Platform WS owner。

### D12：重连、性能与稳定性

1. 覆盖断网、Token refresh、Platform restart、guest crash、renderer reload。
2. 覆盖 `seq_expired`、replay_required、duplicate terminal、旧 generation frame。
3. 压测两个并发 Run + Summary + Debug + Push subscriber。
4. 调整 replay/batch 初值。
5. 检查 listener、timer、subscription、WebContents 泄漏。
6. 验证 macOS 和 Windows 差异。

完成条件：长时间运行连接数稳定，切换/重连无串流、重复提交或资源持续增长。

### D13：原子切换、观察与旧路径删除

1. Desktop 与匹配版本 Agent WebClient bundle 一起发布。
2. `DESKTOP_APP=true` 默认走 DesktopRealtimeTransport，无额外 rollout flag。
3. 观察 physical WS、错误率、replay 和 unknown action 指标。
4. 删除 guest 直连 Desktop 模式路径。
5. 删除旧 Assistant 物理 WS owner。
6. 确认发布产物中的 WorkPanel Action 与当前注册表一致。
7. 更新最终设计文档和手工回归清单。

完成条件：所有永久所有权已收口，无双栈、无静默 fallback、无旧 action 新调用。

## 19. 测试矩阵

### 19.1 连接与环境

- Desktop 启动 Agent WebClient 时 `DESKTOP_APP=true`。
- `/agent`、`/copilot`、`/summary`、`/debug`、`/project` 同时挂载，Agent Platform 业务 WS 为 1。
- guest 运行时找不到可建立 Agent Platform 业务 WS 的 Token/API。
- bridge missing/version mismatch 显示 blocking error，不 fallback。
- 登出/切身份/endpoint 变化不会短暂双连接。

### 19.2 Run 与可见流

- `/agent` 与 `/copilot` 各启动 Run，两个 Run 均继续运行。
- 只有 active visible binding 的 raw stream 投影到 UI。
- 主 Chat + Summary + Debug 同时观察同一 Run，上游 attach 为 1。
- 同一 event 对每个 consumer 最多一次，seq 顺序一致。
- 切 visible binding 后旧 epoch batch 被丢弃。
- 切 tab/chat/route 不 interrupt Run。
- accepted query 在重连和 Surface reload 后不重复提交。
- background internal subscriber 仍能收到其目标 Run event。

### 19.3 Push

- 多 subscriber 同 type 都能收到。
- filter 按 chat/run/resource 生效。
- unsubscribe 和 Surface destroy 后停止投递。
- 重连后订阅恢复。
- push 不进入错误的 conversation timeline。
- Summary 文件变化依赖 stream，不因仅收到 push 而丢失。

### 19.4 Surface 与安全

- guest 伪造 surfaceId、chatId、runId、capability 被拒绝。
- Summary/Debug 不能 start/interrupt/steer/submit。
- Platform 反向 request 不转发给 hidden/destroyed Surface。
- 当前 run target 缺失、断连或 runtime 不支持时返回稳定错误。
- 非法 module route、native surface key、URL scheme、path 被拒绝。

### 19.5 WorkPanel

- 同一 workspace 同时包含 WebClient、Native、Web item。
- item 切换、workspace 切换、外层 route 切换不卸载。
- hidden guest 保持状态但不抢焦点/快捷键。
- 显式关闭一个 item 只清理该 item。
- pinned/non-closable item 不能被普通 close。
- 重复 stable key open 只 activate。
- 不同 chat/workspace 不能串 item。
- `openTab`、`openWeb`、`refreshWeb`、`activateTab`、`closeTab` 和 `closeWorkpanel` 均只接受当前参数契约。

### 19.6 Summary/Debug/OpenTarget

- Summary 实时显示文件变化、Artifact、Planning、任务状态。
- Summary 点击文件/Artifact/Planning 打开或激活正确 item。
- Debug 可独立打开、隐藏、恢复，不依附 Agent/Copilot 右栏。
- `/agent`、`/copilot` 内不出现 WebClient Summary/Debug Sidebar。
- `/project` 作为独立 item 时不初始化无关 Run runtime。

### 19.7 恢复与资源

- 网络断开、Token 过期、Platform restart 可恢复。
- `seq_expired` 触发 canonical replay，不伪造事件。
- guest crash/reload、renderer reload、窗口关闭无 listener/subscription 泄漏。
- app quit 顺序正确，无未处理 promise 或迟到 IPC。
- replay buffer 和 IPC queue 始终有上限。
- macOS/Windows 均验证 hide/focus/shortcut/path/lifecycle。

## 20. 验证命令

每阶段优先运行最小相关测试，合并前至少运行：

```bash
npm run webapp-contract:check
npm run build:main:types
npm run typecheck:renderer
npm run test:unit
npm run build
```

最终候选版本运行：

```bash
npm test
```

并按 `qa/manual-regression.md` 执行跨 WebView、WorkPanel、重连、macOS 和 Windows 手工回归。

如果 canonical contract 增加独立生成脚本，应把其 `--check` 纳入现有 `webapp-contract:check` 或 `test`，不能依赖开发者手工记忆。

## 21. 设计文档同步

本改造跨 Main/preload/renderer、内置服务、WebView、共享契约和 Desktop Action，代码变更必须同步更新：

- `docs/架构与模块边界.md`：Realtime/WorkPanel owner 和禁止依赖；
- `docs/前端嵌入与导航.md`：独立 module route、Surface 生命周期和可见性；
- `docs/鉴权SSO与TokenBridge.md`：Token 只在 Main、guest bridge 权限；
- `docs/桌面协议与动作桥.md`：Realtime bridge、`desktop.workpanel.*` 和错误语义；
- `docs/智能助理集成.md`：Assistant 改为 Broker consumer；
- `qa/manual-regression.md`：并发 Run、单可见流、Summary/Debug、异构 WorkPanel。

实现级字段、精确 channel、默认 buffer 数值留在 source/contract/test，不把易变细节重复写进长期设计文档。

## 22. 提交拆分建议

建议保持每个提交可审查、可测试：

1. `docs: freeze desktop realtime and workpanel architecture`
2. `refactor: extract agent platform realtime client`
3. `feat: add realtime broker run and push routing`
4. `feat: add visible run coordinator`
5. `feat: add webclient realtime contract and preload bridge`
6. `refactor: introduce heterogeneous workpanel model`
7. `feat: add desktop workpanel actions and command service`
8. `feat: host summary and debug workpanel modules`
9. `feat: route webclient open targets to workpanel`
10. `refactor: migrate assistant to realtime broker`
11. `refactor: migrate kanban pet and background consumers`
12. `test: cover reconnect concurrency and lifecycle`
13. `chore: remove legacy realtime and workpanel paths`

不要在同一提交里同时做大规模文件移动、协议变更和 UI 行为变更，否则回归定位与回滚会非常困难。

## 23. 发布与回滚

### 23.1 发布单位

由于 Desktop 已固定向内置 WebClient 注入 `DESKTOP_APP=true`，Desktop bridge 和对应 WebClient bundle 必须作为兼容发布单位：

1. Desktop 先具备新 bridge/contract；
2. 打包匹配 contract version 的 WebClient；
3. hello/version/capability 全部成功后启用业务页面；
4. 不使用额外 feature flag 分流；
5. 不允许部分操作新 bridge、部分操作旧直连。

开发阶段可以保留尚未删除的旧代码用于整体回滚，但发布运行时只能有一个 owner。

### 23.2 回滚规则

- 在 query 尚未 accepted 前，可以整体回滚到上一套兼容 Desktop + WebClient bundle；
- query accepted 后不能把同一操作回落为重新 query；
- contract mismatch 直接阻断并提示版本问题；
- 不通过动态开关在同一进程中切换 WS owner；
- 数据恢复以 Agent Platform canonical Run/history 为准。

## 24. 最终 Definition of Done

- 同一 Desktop identity/endpoint 只有一条 Agent Platform 业务 WS。
- Main 是物理连接、鉴权、重连和 realtime routing 的唯一 owner。
- Realtime Broker 内部明确分离 Run、Push、Inbound Request 和 Connection 能力。
- `/agent` 与 `/copilot` 可以并发 Run，不互相 cancel 或串流。
- UI 同一时刻最多一个 visible Run binding。
- 主 Chat、Summary、Debug 可作为同一 visible binding 的多 consumer，上游 attach 仍为 1。
- Summary 能实时处理文件变化等 stream event，而不是只依赖 push。
- `DESKTOP_APP` 是唯一 WebClient Desktop 模式配置，无新增临时 flag。
- Desktop guest 不持有 Token、不直连 Agent Platform、不静默 fallback。
- `/agent`、`/copilot` 不再包含 WebClient 内部 Summary/Debug 右栏。
- `/summary`、`/debug` 是可由 WorkPanel 独立使用的正式 module Surface。
- WorkPanel 支持 WebClient、Native、Web 三类 item，并保持 mounted。
- `desktop.workpanel.*` 是新的唯一正式 Action namespace。
- WebClient OpenTargetIntent 与 Platform Desktop Action 进入同一 WorkPanelCommandService。
- 重复目标按 stable key activate，不重复创建。
- WorkPanel Action 只包含当前注册表声明的入口。
- Assistant、Kanban、Pet 等不再维护独立 Agent Platform WS owner。
- 重连不重复 accepted query，seq gap 使用 canonical replay。
- Surface 销毁、guest crash、renderer reload、app quit 无 listener/subscription/timer 泄漏。
- macOS 与 Windows 的 WebView 生命周期差异均有显式实现和验证。
- 设计文档、契约生成检查、自动测试和手工回归同步完成。
