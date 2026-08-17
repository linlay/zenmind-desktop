# Agent WebClient 双环境架构改造完整计划

> 目标仓库：`/Users/linlay/Project/zenmind/agent-webclient`  
> 参考方案：`/Users/linlay/Downloads/webclient-双环境架构改造规划-V5/agent-webclient`  
> 本文是当前 WebClient 改造的权威计划；V5 中与本文冲突的内容以本文为准。

## 1. 已冻结的产品与架构决定

### 1.1 唯一环境开关

直接使用现有运行配置 `DESKTOP_APP`，不增加 `DESKTOP_RUN_BRIDGE_ENABLED` 或其他平行开关。

选择规则固定为：

```text
DESKTOP_APP != true
  -> StandaloneRealtimeTransport
  -> 复用 WebClient 现有 wsClientSingleton

DESKTOP_APP == true + trusted Desktop bridge exists
  -> DesktopRealtimeTransport
  -> WebClient guest 不直连 Agent Platform

DESKTOP_APP == true + trusted Desktop bridge missing/incompatible
  -> blocking error
  -> 不静默回退 Standalone
```

`DESKTOP_APP=true` 是 Desktop 启动配置。此运行实例不要求被普通浏览器当作完整网站访问。

Standalone 网站部署必须显式使用 `DESKTOP_APP=false` 或空值，并继续支持 `http://localhost:11948/` 的完整网站能力。

### 1.2 统一所有权、分离能力

使用 `RealtimeTransport` 作为业务层唯一顶层门面，由一个 Provider 统一拥有实例、生命周期、状态和清理；内部保留独立能力：

- `RunTransport`：request/response、query/attach stream、Run controls。
- `PushTransport`：连接级 `frame="push"` 订阅与连接状态。
- `InboundRequestTransport`：仅为仍需接收 Platform 反向 request 的 Standalone 网站能力保留；Desktop WorkPanel Action 不由 WebClient 执行。

三个能力在 Standalone 共用现有 `wsClientSingleton`，在 Desktop 共用 Main 进程的单物理 WS。

### 1.3 子路由完全移除右侧栏

改造后以下独立子路由不再装配 WebClient `RightSidebar`：

- `/agent`、`/agent/:agentKey`
- `/copilot`、`/copilot/:agentKey`
- `/summary`
- `/debug`
- `/project`

其中 `/agent`、`/copilot` 也不再提供内部 Summary/Debug Drawer、Overview Panel 或 Web Preview SidePanel。

完整网站根路由 `/` 继续保留现有 `AppShell`、LeftSidebar、RightSidebar 和网站导航能力。

### 1.4 Summary 与 Debug 独立

- `/summary`：当前 Chat/Run 的实时只读摘要模块。
- `/debug`：当前 Chat/Run 的实时只读事件调试模块。
- 二者可以被 Desktop WorkPanel 作为独立 WebClient WebView item 使用。
- 二者不装配 Composer、Voice、BTW、Worker 管理、Run controls 或 Platform Action owner。

### 1.5 WorkPanel Action 命名

当前统一使用 `desktop.workpanel.*`，不再把 Desktop WorkPanel 描述成 WebClient Sidebar：

- `desktop.workpanel.openItem`
- `desktop.workpanel.activateItem`
- `desktop.workpanel.closeItem`
- 如确有需要，再增加受限的 `desktop.workpanel.getState`

`webclient.sidebar.openUrl` 不在 WebClient 内隐式转译。调用方应直接改用 `desktop.workpanel.*`。

Platform 后续负责判断目标是 Standalone WebClient 还是 Desktop；本次 WebClient 不实现 Platform 的跨宿主路由决策。

## 2. 本次目标

1. 所有业务实时调用只依赖 `RealtimeTransport` 顶层门面或其窄能力接口。
2. Standalone 网站保持现有 HTTP、WS、聊天、管理、Voice、BTW、Project 和侧边栏能力。
3. `DESKTOP_APP=true` 时 WebClient guest 不再创建 Agent Platform 业务 WS。
4. `frame="stream"` 与 `frame="push"` 分别进入 Run/Push 能力，不再混在一个超大 Hook 中。
5. `/agent`、`/copilot` 并发运行，但每个 guest 只投影 Desktop Broker 分配给它的当前可见 Run。
6. 主 Chat、Summary、Debug 观察同一 Run 时，Desktop 上游 attach 为 1，本地按消费者扇出。
7. Summary/Debug 点击目标通过宿主无关 Intent 打开 Standalone 页面或 Desktop WorkPanel item。
8. 所有 listener、pending request、observer、timer 和 execution 都有确定 cleanup。

## 3. 本次不做

- 不修改 Agent Platform WS frame 基础格式。
- 不让 Agent Platform 理解 WebView、Surface 或 WorkPanel。
- 不拆成多个 npm 包或多套构建产物。
- 不重写 App reducer、timeline model 或 eventProcessor。
- 不迁移普通 HTTP Data API、资源下载、上传和文件历史接口。
- 不把 Voice ASR/TTS WebSocket 合并到 Agent Platform RealtimeTransport。
- 不引入新的全局状态库、BroadcastChannel 全状态同步或第二个 WS singleton。
- 不要求 `DESKTOP_APP=true` 的服务实例同时支持普通浏览器完整网站模式。

## 4. 协议事实与数据流

### 4.1 Agent Platform frame 分工

- `frame="stream"`：高数据量 live stream，按原始请求 `id` 定位 active stream。
- `frame="push"`：连接级低频通知，按 `type` 订阅。
- `frame="response"`、`frame="error"`：按请求 `id` 配对。
- `frame="request"`：Platform 发给客户端的反向请求。

### 4.2 Standalone 数据流

```text
WebClient feature
  -> RealtimeTransport
      -> RunTransport / PushTransport
          -> wsClientSingleton
              -> Agent Platform /ws
```

Standalone adapter 是现有实现的领域包装，不新增物理连接。

### 4.3 Desktop 数据流

```text
/agent guest ------\
/copilot guest -----\
/summary guest ------> DesktopRealtimeTransport
/debug guest --------/          |
                                 v
                         trusted preload bridge
                                 |
                                 v
                         Desktop Main Broker
                                 |
                                 v
                       单物理 WS -> Agent Platform
```

WebClient 只看 request、accepted、events、done、push 和稳定错误；不接触 ipcRenderer、Agent Platform Token、真实 webContentsId 或其他 Surface 的身份。

## 5. 目标模块结构

建议目录：

```text
src/features/realtime/
├── contracts/
│   ├── realtimeTransport.ts
│   ├── runTransport.ts
│   ├── pushTransport.ts
│   ├── inboundRequestTransport.ts
│   └── realtimeTransportErrors.ts
├── components/
│   └── RealtimeTransportProvider.tsx
├── hooks/
│   ├── useRealtimeTransport.ts
│   ├── useRunTransport.ts
│   ├── usePushTransport.ts
│   └── useRunSubscriptionRuntime.ts
└── lib/
    ├── standaloneRealtimeTransport.ts
    ├── standaloneRunTransport.ts
    ├── standalonePushTransport.ts
    ├── desktopRealtimeTransport.ts
    ├── desktopRunTransport.ts
    ├── desktopPushTransport.ts
    └── desktopRealtimeBridgeClient.ts

src/features/surfaces/
├── contracts/
│   └── openTargetIntent.ts
├── components/
│   ├── ReadonlyConversationSurfaceShell.tsx
│   ├── SummarySurface.tsx
│   └── DebugSurface.tsx
├── hooks/
│   ├── useReadonlyRunSurfaceRuntime.ts
│   └── useOpenTarget.ts
└── lib/
    ├── standaloneOpenTargetAdapter.ts
    └── desktopWorkPanelAdapter.ts

src/shared/contracts/generated/
└── agentWebclientRealtime.ts
```

可沿用当前 `features/transport` 目录，重点是依赖方向与职责，不强制为了目录名做大规模机械移动。

## 6. RealtimeTransport 契约

### 6.1 顶层门面

```ts
type RealtimeTransportKind = "standalone" | "desktop";

interface RealtimeTransport {
  readonly kind: RealtimeTransportKind;
  readonly runs: RunTransport;
  readonly push: PushTransport;
  readonly inbound?: InboundRequestTransport;
  getStatus(): RealtimeConnectionStatus;
  subscribeStatus(listener: StatusListener): () => void;
  dispose(): Promise<void> | void;
}
```

要求：

- Provider 是生产环境唯一选择点。
- transport 实例在一个 guest 生命周期内稳定。
- 能力按首次使用懒初始化；访问 `/project` 不应仅因 Provider 存在就建立 Run stream。
- `dispose` 只释放本地观察和连接，不隐式 interrupt Run。
- 一个 operation accepted 后，不得切换 adapter 重发。

### 6.2 RunTransport

至少包含：

- `startQuery`
- `startBtw`
- `subscribe`
- `interrupt`
- `submitAwaiting`
- `submitTool`
- `steer`
- `updateAccessLevel`

`startQuery/startBtw/subscribe` 同步返回 `RunExecution`：

```ts
interface RunExecution {
  accepted: Promise<RunAccepted>;
  completion: Promise<RunCompletion>;
  detach(): Promise<void>;
}
```

约束：

- `detach` 幂等，只解除观察，不等于 interrupt。
- accepted 前事件由 transport 有界缓冲并保持顺序。
- accepted 与业务 terminal 分离。
- Awaiting 与 Tool 使用不同 DTO，不能靠大量可选字段组成大联合。
- 每个 Run event 在单 guest 内按 `runId + seq` 最多进入 eventProcessor 一次。
- query、attach、control 的 requestId 必须全局唯一且有稳定结束路径。

### 6.3 PushTransport

```ts
interface PushTransport {
  subscribe(
    filter: { types: string[]; chatId?: string; agentKey?: string },
    listener: (frame: PushFrame) => void,
  ): () => void;
}
```

约束：

- 多个消费者可以订阅同一 push type。
- unsubscribe 后立即停止本地投递。
- `heartbeat`、`connected`、`auth.expiring` 等连接级帧由 transport lifecycle 处理，不注入 conversation timeline。
- chat created/updated/deleted、read/unread、run.started/run.finished、awaiting、resource 等按显式订阅分发。
- 不把 live 文件变化从 stream 改造成 push。
- Desktop adapter 只向 Main 注册 push filter，不创建 WebSocket。

### 6.4 InboundRequestTransport

仅用于完整 Standalone 网站仍需接收的 WebClient 反向请求：

- handler 按 request type 唯一注册。
- response/error 与原 requestId 配对。
- 子路由 `/agent`、`/copilot`、`/summary`、`/debug` 不注册 Sidebar Action handler。
- `DESKTOP_APP=true` 时不注册 `webclient.sidebar.*`。
- WebClient 不处理 `desktop.workpanel.*` 的 Platform 目标选择。

## 7. 路由与 Shell 装配

### 7.1 路由矩阵

| 路由 | Website (`DESKTOP_APP=false`) | Desktop (`DESKTOP_APP=true`) |
|---|---|---|
| `/` | 完整 `AppShell`，保留左右侧栏 | 不作为 Desktop 模块入口 |
| `/agent`、`/agent/:agentKey` | 独立 Agent，无右侧栏 | 独立 Agent，无右侧栏 |
| `/copilot`、`/copilot/:agentKey` | 独立 Copilot，无右侧栏 | 独立 Copilot，无右侧栏 |
| `/summary` | Standalone 实时只读模块 | WorkPanel 实时只读模块 |
| `/debug` | Standalone 实时只读模块 | WorkPanel 实时只读模块 |
| `/project` | 独立 Project | WorkPanel Project 模块 |

### 7.2 Provider 装配

```text
I18nProvider
  -> AppProvider
     -> RealtimeTransportProvider
        -> ThemedShell
           -> AuthBoundary
              -> Router
```

`RealtimeTransportProvider` 负责唯一实例与环境选择，但内部连接保持懒初始化。

`BtwProvider` 只装配在完整网站、Agent、Copilot 等交互路由，不包住 `/summary`、`/debug`、`/project`。

### 7.3 `/agent` 改造

- 从 `AgentChatShell` 删除 `RightSidebar` import、布局列和 render。
- 保留 ConversationStage、Composer、必要 TopBar、BottomDock、TerminalDock 和交互 Overlay。
- 移除或改造 TopNav 中操作 `rightSidebarOpen` 的 Debug、Overview 按钮。
- `/debug` Slash Command、全局搜索 Debug 操作改走 `OpenTargetIntent`。
- 文件、Artifact、Planning 等需要详情时，调用宿主无关 OpenTarget adapter。
- 不删除根网站 `AppShell` 所需的 RightSidebar reducer/state/action。

### 7.4 `/copilot` 改造

- 删除 Copilot 内部 Debug Drawer。
- 删除 `CopilotSidePanel`、Overview、BTW、Preview、Source、Planning 和 Web Preview SidePanel 装配。
- 保留 Copilot 主对话、页面上下文、Composer 和必要设置入口。
- 详情、Summary、Debug、网页预览改走 OpenTarget adapter。
- 不让 Copilot 创建第二个 push/runtime owner。

### 7.5 完整网站 `/`

- 保留 `AppShell`、LeftSidebar、RightSidebar、TopNav、BottomDock、TerminalDock。
- 保留网站内 Overview、Debug、BTW、Preview、Planning、Source 和 Web Preview。
- 网站内部打开目标可继续使用 Standalone adapter 打开 RightSidebar 或站内页面。
- 模块拆分不得降低根网站的管理页、Voice、BTW、Project 和历史恢复能力。

## 8. Summary 独立模块

### 8.1 数据来源

继续复用现有 live event projection：

```text
frame=stream
  -> AgentEvent
  -> eventProcessor/liveEventDispatch
  -> fileChanges/artifacts/plan/tasks/timeline
  -> Summary selectors
```

不能另造 Summary 专用事件协议，也不能只依赖 push。

### 8.2 组件拆分

从现有 `OverviewTab` 抽出宿主无关的 `SummaryContent`：

- 不读取 `rightSidebarOpen` 判断自身可见性。
- 不直接 dispatch `OPEN_RIGHT_SIDEBAR`。
- 文件 diff、Artifact、Planning 点击统一调用 `useOpenTarget()`。
- 保留文件变化动画、增删统计、历史 diff 加载、Planning、Task 和 Artifact。
- Root RightSidebar 继续用同一个 `SummaryContent`，避免两份实现。

### 8.3 只读运行时

`useReadonlyRunSurfaceRuntime` 固定执行：

```text
context generation++
  -> detach previous
  -> abort previous replay
  -> HTTP load/replay
  -> derive chatId/runId/owner/lastSeq
  -> stale check
  -> runs.subscribe(role=summary)
  -> project live events
```

- 参数变化先清理旧流程。
- gap 最多恢复一次。
- destroy 只 detach。
- 不 start、interrupt、submit、steer 或 update access。

## 9. Debug 独立模块

### 9.1 组件拆分

从现有 `DebugTab` 抽出 `DebugPanelContent`：

- 输入为当前只读 projection 的 `debugEvents` 与 chat/agent 映射。
- 保留现有事件分类、过滤、颜色、计数和时间展示。
- Event Detail 使用 Debug Surface 自己的详情层，不依赖完整 `ShellOverlays`。
- `chat.start` 中打开 Agent/Copilot 的操作改走 `OpenTargetIntent`，不直接 `window.open`。
- Root RightSidebar 继续复用 `DebugPanelContent`。

### 9.2 路由与能力

- 路由：`/debug?chatId=...&runId=...`，可附带安全的展示参数。
- 继续受现有 `DEBUG_PANEL_ENABLED` 控制。
- 使用 `useReadonlyRunSurfaceRuntime(role=debug)`。
- 不装配 Composer、Voice、BTW、Worker、Action runtime。
- 不注册 Platform Action owner。
- Debug event 保留有界上限，避免长 Run 无限增长。

## 10. 可见 Run 与多消费者

WebClient 接受以下产品语义：

- `/agent` 与 `/copilot` 可以并发运行。
- Desktop 同一时刻只有一个 visible Run binding。
- 主 Chat、Summary、Debug 可以是这个 binding 的多个本地消费者。
- 多消费者不等于多条上游 stream。
- WebClient guest 只处理 Broker 发给自己的 binding；不猜测其他 Surface 状态。

Desktop bridge event envelope 至少携带：

```ts
type VisibleRunEnvelope = {
  bindingEpoch: number;
  chatId: string;
  runId: string;
  subscriptionId: string;
  events: AgentEvent[];
};
```

WebClient 必须：

- 在投影前校验 epoch、chatId、runId 和 seq。
- 丢弃旧 binding 的迟到事件。
- 一批 events 只顺序循环一次，不重复 stringify/parse。
- hidden/unmount 只 detach 本地消费者，不 interrupt Run。

Desktop “同 Run 上游 attach 为 1”由 Desktop Broker 保证；WebClient contract tests 和跨仓 E2E 必须验证这一语义。

## 11. OpenTarget 与 `desktop.workpanel.*`

### 11.1 领域 Intent

```ts
type OpenTargetIntent =
  | { version: 1; kind: "summary"; chatId: string; runId?: string; title?: string }
  | { version: 1; kind: "debug"; chatId: string; runId?: string; title?: string }
  | { version: 1; kind: "file-diff"; chatId: string; runId: string; filePath: string; title?: string }
  | { version: 1; kind: "artifact"; chatId: string; runId?: string; artifactId: string; title?: string }
  | { version: 1; kind: "planning"; chatId: string; nodeId: string; title?: string }
  | { version: 1; kind: "agent"; agentKey: string; chatId?: string; title?: string }
  | { version: 1; kind: "copilot"; agentKey: string; chatId?: string; title?: string }
  | { version: 1; kind: "project"; chatId?: string; path?: string; title?: string }
  | { version: 1; kind: "web"; url: string; title?: string };
```

最终 wire 字段以 Desktop canonical generated contract 为准。

### 11.2 Standalone adapter

按当前宿主能力执行：

- 根网站优先打开现有 RightSidebar/Preview。
- 独立 `/agent`、`/copilot` 没有右侧栏，可导航到独立模块或打开受控新页面。
- Web URL 仅允许 http/https。
- 不把 Token 或完整 AppState 放入 URL。

### 11.3 Desktop adapter

通过 trusted bridge 调用：

```text
desktop.workpanel.openItem(intent)
  -> Desktop 校验来源和权限
  -> stable target key 查重
  -> 已存在则 activate
  -> 不存在则 create + activate
  -> 返回 itemId/tabId
```

WebClient 不维护 Desktop Tab 列表，不发送任意脚本、DOM 指令或未校验 `file://` URL。

## 12. Push 与 Notification 改造

从 `useConversationWsRuntime` 拆出：

### 12.1 `useChatNotificationRuntime`

只处理：

- chat created/updated/deleted；
- read/unread；
- run.started/run.finished 摘要；
- awaiting/resource 等低频刷新；
- reconnect 后列表/摘要刷新。

它只能依赖 `usePushTransport()`，不能 import `wsClientSingleton`。

### 12.2 其他 Push consumer

扫描并迁移所有直接 `subscribeWsPush` 的生产代码，包括管理页。按能力决定：

- 需要 Desktop 支持的页面必须使用 PushTransport。
- 仅完整网站使用的页面也应通过 Standalone PushTransport，避免重新出现第二条依赖路径。
- boundary check 禁止业务代码直接 import `subscribeWsPush/initWsClient/getWsClient`。

### 12.3 Run Subscription

`useRunSubscriptionRuntime` 只负责：

- HTTP replay 后 live subscribe；
- owner/runId/lastSeq；
- chat switch detach；
- generation/epoch/seq guard；
- 一次 gap recovery。

Notification 与 Subscription 不得同时消费同一 Run raw event。

## 13. 反向 Action 边界

### 13.1 Standalone 网站

完整网站 `/` 可以在过渡期保留必要 `webclient.sidebar.*` handler，但必须通过 `InboundRequestTransport` 注册，不能为此额外初始化 WsClient。

### 13.2 独立子路由

`/agent`、`/copilot`、`/summary`、`/debug` 无 WebClient RightSidebar：

- 不注册 `webclient.sidebar.getState/setState/openUrl/refreshUrl`。
- 收到旧 action 时返回 `unsupported_in_current_view`。
- 页面主动打开目标使用 OpenTarget adapter，不模拟 Sidebar state。

### 13.3 Desktop

- `desktop.workpanel.*` 由 Desktop 执行。
- WebClient 仅从 UI 侧发出受控 WorkPanel Intent。
- WebClient 不接收并执行 Desktop WorkPanel reverse action。
- Platform 如何选择 WebClient 或 Desktop target 属于后续 Platform 改造。

## 14. 分阶段执行计划

### W0：基线、契约与部署模式

修改：

- `runtimeConfig.ts`
- `routing.ts`
- `webpack.config.js`
- manifest/runtime config 相关文件
- generated contract 接收脚本或文件

工作：

1. 记录 test、boundaries、i18n、build 基线。
2. 将 `DESKTOP_APP` 固定为唯一选择依据。
3. 不新增 `DESKTOP_RUN_BRIDGE_ENABLED`。
4. 明确 Desktop/Standalone 启动配置，Standalone 示例显式 false。
5. 接收 Desktop canonical realtime/workpanel generated contract。
6. 先建立 contract，不改生产行为。

完成标准：模式测试覆盖 false、true+bridge、true+missing、true+incompatible。

### W1：RealtimeTransport 门面与 Standalone 能力

1. 建立 `RealtimeTransportProvider` 和 hooks。
2. 实现 StandaloneRunTransport，包装现有 query/attach/control primitive。
3. 实现 StandalonePushTransport，包装现有 onPush/subscribeWsPush。
4. 保留一个 `wsClientSingleton`。
5. transport 懒连接，Provider mount 不自动创建无用 stream。

完成标准：尚未迁业务调用点时，现有行为不变；不新增物理 WS。

### W2：主 Query 垂直迁移

迁移 `useMessageActions`：

```text
generation++
  -> set UI pending
  -> runs.startQuery
  -> await accepted
  -> bind canonical chat/run/owner
  -> await completion
```

完成标准：新旧 chat、后台 chat、promotion、快切、terminal/error 等价；一次发送一个 execution。

### W3：Push/Notification 迁移

1. 抽出 `useChatNotificationRuntime`。
2. 全部 push 消费改用 PushTransport。
3. 迁移管理页直接 `subscribeWsPush`。
4. 补多订阅者、过滤、unsubscribe、重连测试。

完成标准：业务生产代码无直接 push singleton import。

### W4：Run Subscription 与恢复

1. 抽出 `useRunSubscriptionRuntime`。
2. 固定 replay -> lastSeq -> subscribe 流程。
3. gap 最多恢复一次。
4. A -> B -> A 快切无旧覆盖。
5. notification/subscription 不双消费。

完成标准：旧 Hook 不再直接 attach/detach。

### W5：Standalone BTW 修复

1. 删除 start/attach 报错 stub。
2. BTW 使用 runs.startBtw/subscribe/interrupt。
3. persistence 只保存可恢复身份与 lastSeq。
4. discard 固定 generation++ -> detach -> clear。

完成标准：Standalone BTW 可 start、restore、interrupt、discard、terminal。

### W6：Desktop Realtime Bridge Client

Bridge client 维护：

- `pendingByRequestId`
- `observerBySubscriptionId`
- `pushSubscribersByType`
- 单个 Main message listener

规则：

- request 发送前注册 pending。
- accepted 前 stream 进入有界 early buffer。
- accepted 后注册 observer、flush、resolve。
- done/error 先删除 observer再 settle。
- unknown/late id 只诊断，不广播猜测。
- dispose/pagehide 后 Map、timer、listener 归零。

完成标准：Bridge client 不解析 UI 业务，不暴露 ipcRenderer/channel。

### W7：Desktop RealtimeTransport

1. 实现 DesktopRunTransport mapper。
2. 实现 DesktopPushTransport filter/subscription。
3. hello/capability/version 每实例缓存一次。
4. Surface 注册竞态允许有限短退避；其他错误立即失败。
5. `DESKTOP_APP=true` 且 hello 失败不回落。
6. events batch 单次顺序遍历。

完成标准：Run 与 Push 均可通过假 Broker 独立闭环。

### W8：Controls、Voice 与 BTW 收口

依次迁移：

1. interrupt/steer；
2. awaiting；
3. frontend tool；
4. access level；
5. Voice query；
6. BTW Desktop 闭环。

Voice ASR/TTS、采集、播放和静音仍留在 Voice runtime。

完成标准：业务 feature 不再直接 import Run Data API/query executor。

### W9：`/agent`、`/copilot` 右侧栏拆除

1. AgentChatShell 删除 RightSidebar 布局与 render。
2. CopilotShell 删除 Debug Drawer 与 SidePanel。
3. TopNav、Slash Command、Global Search 改为 OpenTarget。
4. Root AppShell 的 RightSidebar 保持不变。
5. 增加路由级 UI 回归测试。

完成标准：两个子路由在 Standalone/Desktop 都不存在 WebClient 右侧栏 DOM 和内部 Panel listener。

### W10：Summary、Debug 与 WorkPanel Intent

1. 抽 `SummaryContent` 与 `DebugPanelContent`。
2. 新增 `/summary`、`/debug`。
3. 实现 ReadonlyConversationSurfaceShell。
4. 实现 Standalone/Desktop OpenTarget adapters。
5. Desktop adapter 使用 `desktop.workpanel.*`。
6. 验证 Summary 文件变化和 Debug events 持续实时更新。

完成标准：两个模块可独立直达、刷新、快速切 context、销毁 detach，可由 Desktop WorkPanel 使用。

### W11：边界门禁与 Desktop 默认启用

静态边界只允许：

- Standalone realtime adapter/executor 直接依赖 wsClient 和 Run endpoint。
- Desktop bridge/transport 依赖 generated wire contract。
- 其他 feature 只依赖 RealtimeTransport/RunTransport/PushTransport/OpenTarget。

禁止生产业务直接出现：

- `initWsClient`
- `getWsClient`
- `subscribeWsPush`
- `/api/attach` 字符串
- 直接 Run controls import

完成标准：跨仓 E2E 证明 Desktop 多模块时 Agent Platform 主业务 WS 为 1。

### W12：性能、稳定观察与旧路径下线

1. 100-event fixture 验证单 seq 单 guest 投影一次。
2. 50 次 route/chat/WorkPanel 切换后 listener 回基线。
3. 10 分钟长流后 pending/observer/timer 不增长。
4. 主 Chat + Summary + Debug 同 Run 时上游 attach 为 1。
5. 删除旧 attach/control/query 兼容入口。
6. 保留 StandaloneRealtimeTransport 和 `DESKTOP_APP` 长期模式开关。

## 15. 测试矩阵

### 15.1 环境与选择

- `DESKTOP_APP=false` -> Standalone。
- `DESKTOP_APP=true` + bridge ready -> Desktop。
- `DESKTOP_APP=true` + bridge missing/version mismatch -> blocking error。
- Desktop accepted 后任何错误均不回退 Standalone 重发。

### 15.2 Run

- query、BTW、subscribe accepted 前 0/1/多 event。
- response/event/done/error 乱序。
- detach 幂等，AbortSignal 只 detach。
- replay/live seq 去重。
- gap 一次恢复、二次明确失败。
- A -> B -> A 快切。

### 15.3 Push

- 多 type、多 listener、相同 type 多消费者。
- unsubscribe、dispose、reconnect。
- push 不进入 timeline raw event。
- heartbeat/auth 生命周期不进入业务订阅。

### 15.4 路由与 UI

- `/` 完整网站保留左右侧栏。
- `/agent`、`/agent/:agentKey` 无 RightSidebar。
- `/copilot`、`/copilot/:agentKey` 无 Drawer/SidePanel。
- `/summary`、`/debug`、`/project` 独立直达和刷新。
- Debug/Overview TopNav 与命令在子路由不再操作右侧栏。

### 15.5 Summary 与 Debug

- 文件变化 stream 到达后 Summary 实时更新。
- Debug 按事件类型正确分类、计数、过滤。
- context 快切丢弃旧 epoch 事件。
- close/destroy 只 detach，不影响主 Chat/Run。
- Desktop WorkPanel 重复打开稳定目标时激活已有 item。

### 15.6 资源与性能

- StrictMode listener 不翻倍。
- pagehide/dispose 后 pending/observer/push listener/timer 清零。
- 单 batch 不重复 clone/stringify/parse。
- 不通过 Context 全量重写或全仓 memo 掩盖双 observer。

## 16. 每阶段验证命令

先运行定向测试，再执行：

```bash
npm test -- --runInBand
npm run check:boundaries
npm run check:i18n
npm run build
```

仓库当前没有正式 lint script，本任务不顺手引入全仓 ESLint 治理。

## 17. 提交拆分建议

1. `realtime-contract-desktop-app-selection`
2. `standalone-realtime-transport`
3. `query-use-run-transport`
4. `push-notification-transport`
5. `run-subscription-recovery`
6. `restore-standalone-btw`
7. `desktop-realtime-bridge-client`
8. `desktop-realtime-transport`
9. `controls-voice-btw-closure`
10. `remove-agent-copilot-right-panels`
11. `summary-debug-surfaces-workpanel-intents`
12. `realtime-boundary-enforcement`
13. `realtime-legacy-cleanup`

owner 迁移类提交必须整步完成，禁止在同一生产路径同时保留新旧 listener、observer 或 control 调用。

## 18. 最终 Definition of Done

- `DESKTOP_APP` 是唯一环境模式开关。
- 一个 guest 只有一个 RealtimeTransport owner。
- RealtimeTransport 内部 Run/Push 能力独立。
- Standalone 继续复用一个 wsClientSingleton。
- Desktop guest 到 Agent Platform 的直接业务 WS 为 0。
- Desktop 多 WebClient Surface 共用 Main 单物理 WS。
- `/agent`、`/copilot` 无 WebClient RightSidebar/内部 Panel。
- `/summary`、`/debug` 可独立使用并可被 Desktop WorkPanel 承载。
- Root `/` 完整网站功能不退化。
- Summary/Debug/Main Chat 同 Run 时 Desktop 上游 attach 为 1。
- `desktop.workpanel.*` 是当前 WorkPanel Action 命名。
- 业务 feature 不直接依赖 wsClient、push singleton、Run endpoint 或 Desktop wire DTO。
- 每个 listener、execution、pending、observer、timer 都有确定 cleanup。
- test、boundaries、i18n、build 和跨仓 E2E 全部通过。

