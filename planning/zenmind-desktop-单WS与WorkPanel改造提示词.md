# ZenMind Desktop 单 WS 与 WorkPanel 改造提示词

> 以下正文可直接交给编码 Agent。目标仓库：`/Users/linlay/Project/zenmind/zenmind-desktop`。

## 任务

请改造 ZenMind Desktop，使所有 Agent WebClient 模块通过 Main 进程复用一条 Agent Platform 业务 WebSocket，并建立可校验、可清理的 Surface 路由；同时把现有 Chat WorkPanel 从“普通网页 Tab 容器”扩展为 WebClient WebView、原生 Surface 和普通 Web Surface 的组合容器。

先严格执行仓库 `AGENTS.md` 的 Design Docs First 要求：

1. 阅读 `README.md` 第 6 节；
2. 阅读 `docs/README.md`；
3. 阅读 `docs/架构与模块边界.md`；
4. 阅读 `docs/前端嵌入与导航.md`；
5. 阅读 `docs/鉴权SSO与TokenBridge.md`；
6. 阅读 `docs/桌面协议与动作桥.md`；
7. 阅读 `docs/智能助理集成.md`；
8. 对照 `qa/manual-regression.md`。

重点核对现有实现：

- `src/main/assistant/core/assistant-ws-transport.ts`
- `src/main/services/agent-webclient-host.ts`
- `src/renderer/app-shell/embedded-surfaces/EmbeddedSurfaceHosts.tsx`
- `src/renderer/chat-work-panel/ChatWorkPanelHost.tsx`
- `src/renderer/chat-work-panel/ChatWorkPanelSurface.tsx`
- `src/shared/chat-work-panel.ts`
- `src/main/desktop-action-bridge.ts`
- `src/renderer/services/desktopActionRegistry.ts`
- `src/shared/desktop-actions.ts`
- `src/shared/contracts/desktop-api.ts`

## 架构结论

本次默认不改 Agent Platform。

已确认其现有协议具备以下能力：

- `frame="stream"` 带原始请求 `id`，一条连接可以维护多个 active stream；
- `frame="push"` 是连接级、低数据量通知；
- `response/error` 可按 `id` 路由；
- 因此逻辑 Surface 复用、可见流选择和本地扇出可由 Desktop Bridge 完成。

`/agent` 和 `/copilot` 可以并发运行，但 Desktop 同一时刻只有一个“可见 live stream”。主 Chat 和 Summary 同时出现时，它们是同一个可见流的两个消费者，不是两次上游 attach。

Platform 发起的反向 Action 不能向所有 Surface 广播。当前 `webclient.*` 反向 request 没有携带来源 `runId/chatId`，因此只有当 Broker 能证明目标唯一时，才允许交给当前可见、可交互的 Action owner；并发 Run 导致来源不唯一时必须 fail closed。若未来要求隐藏后台 Run 也能精确定向执行反向 Action，再单独评估最小协议扩展，本次不预先改 Platform。

## 不可变原则

### 1. Main 进程拥有唯一物理连接

按 `{Agent Platform endpoint, 当前身份会话}` 维护一条业务 WebSocket：

- Renderer、WebView、Summary、Project 不得持有 Agent Platform Token；
- WebClient guest 不得自行直连 Agent Platform；
- Main 统一处理建连、鉴权刷新、心跳、重连、协议校验、限流和指标；
- 不要再新增第二套与 `AssistantWsTransport` 并行的永久连接。应将现有 transport 泛化为共享 Agent Platform Realtime Broker，或让旧 Assistant API 迁移为 Broker 的一个客户端；
- Desktop 内其他无关协议的 WebSocket 不在本任务范围内。

### 2. Broker 按 frame 类型分治

建议维护以下显式索引，具体命名可调整：

```ts
type RealtimeBrokerState = {
  pendingRequests: Map<UpstreamRequestId, PendingRequest>;
  activeStreams: Map<UpstreamRequestId, UpstreamStream>;
  surfaceSubscriptions: Map<SurfaceId, SurfaceSubscription>;
  pushSubscriptions: Map<PushType, Set<SurfaceId>>;
  visibleBinding: VisibleStreamBinding | null;
};

type VisibleStreamBinding = {
  epoch: number;
  chatId: string;
  runId: string;
  upstreamRequestId: string;
  actionOwnerSurfaceId: string;
  consumerSurfaceIds: Set<string>; // 通常为主 Chat + Summary
};
```

路由规则：

- `response/error`：严格按上游 requestId 回给发起者；
- `stream`：先按 requestId 找到 active stream，再根据 visible binding 投递；
- `push`：按 type/filter 分发给显式订阅者；
- Platform `request`：先做来源可判定性与能力检查；只有目标唯一时才交给当前 visible binding 的 action owner，并将其 response/error 原样配对回传。

任何未知 id、重复 terminal、非法 seq、非法 frame 都必须可观测并 fail closed，不能广播猜测。

### 3. 并发 Run 与单可见流必须分开

Broker 允许一条 WS 上存在多个 active stream，这用于 `/agent`、`/copilot` 并发运行；但 raw live stream 的 UI 投递满足：

- 任一时刻恰好零个或一个 `VisibleStreamBinding`；
- 当前主 Chat 与 Summary 可同时订阅这个 binding；
- 同一 upstream event 对每个 consumer 最多投递一次；
- 非可见 stream 仍由 Main 正常 drain，记录 `lastSeq`、终态和必要的轻量运行信息，但不广播 raw event 给所有隐藏 guest；
- 后台页面通过 `push`、HTTP snapshot 或轻量状态获得运行中/已完成提示；
- 用户切换到后台 Run 时，先加载 canonical history/replay，再从正确 `lastSeq` attach 或重绑定；
- binding 切换递增 `epoch`，旧 epoch 的 IPC event 即使迟到也必须被 guest 丢弃；
- 隐藏、切 Tab 不等于 interrupt；只有明确的 interrupt/cancel 操作才改变 Platform Run。

不要把“只有一个可见 stream”实现成“只允许一个 Run 运行”。

### 4. Surface 注册、能力与清理

通过 preload 暴露最小能力：

- register/unregister Surface；
- request；
- open/attach/detach stream；
- subscribe/unsubscribe push；
- bind/unbind visible stream consumer；
- register/unregister action owner；
- 回应 Platform 反向 request。

Main 必须从真实 `webContents`/frame、BrowserSurfaceRegistry、partition、origin 和 Desktop 当前路由计算身份与能力，不信任页面自报的 `surfaceId`、chatId、capabilities 或 target URL。

至少定义三类能力：

- Agent/Copilot：可发起或控制自身 Run；
- Summary：只读 stream/push consumer，可发 Open Target intent；
- Project/普通 Surface：按白名单访问数据或打开目标，不具备 Run 控制。

Surface 销毁时必须释放 pending request、push subscription、stream consumer、action handler、timer 和 IPC listener。最后一个 UI consumer 离开不默认 interrupt 后台 Run。

### 5. 反向 Action 不需要 Platform Surface 改造

当前 Platform 会把 Run 的 WebClient target 绑定到物理连接，但 `webclient.*` 反向 frame 本身不携带来源 `runId/chatId`。在 Desktop 单连接模式中，Broker 采用如下规则：

- 只有当前可见的 Agent/Copilot Surface 可以成为 action owner；
- Summary、Project、隐藏 Surface 永远不是 owner；
- 同一时刻最多一个 owner，切换必须原子解绑旧 owner、绑定新 owner；
- 只有 Broker 能证明当前物理连接上恰好一个可能发出该类 Action 的 active Run，且它就是 visible binding 时，才能把 request 交给 owner；
- 存在多个并发 action-capable Run 或来源无法证明时，返回 `ambiguous_action_target`，不能仅凭“当前可见”猜测来源；
- 没有 owner、owner 已销毁或能力不匹配时，返回结构化错误，例如 `unsupported_in_current_view` 或 `target_unavailable`；
- 绝不把反向 request 广播给所有 guest，也不选“最后响应的 Surface”。

这是本期在不改 Platform 下的明确产品约束：并发运行和 stream 展示仍可用，但目标不唯一时 WebClient 反向 Action 会被拒绝。请在代码、设计文档和测试中写清楚。如果未来要求并发 Run 也能精确定向反向 Action，需让 Platform 在反向 request 中回传最小的 opaque run correlation；它无需理解 Desktop Surface，但必须提供可验证的关联信息。

### 6. Summary 与主 Chat 共用 visible binding

支持两种装配，但两者上游 stream 都只能有一份：

1. Chat 和 Summary 在同一个 WebClient guest：Broker 只向该 guest 投递一次，由 WebClient 内共享 projection；
2. Chat 与 Summary 是两个 guest：二者作为同一个 visible binding 的两个显式 consumer，本地扇出同一上游 event，不创建第二个 query/attach。

Summary 所需的文件变化、Artifacts、Planning、任务状态来自 `frame="stream"`；chat/run 状态、资源提醒、awaiting 等可来自 `frame="push"`。不能因为 Summary 是辅助面板就只给它 push。

### 7. WorkPanel 扩展为异构 item 容器

当前 `ChatWorkPanel` 基本是 URL WebView Tab。将其 item contract 改成判别联合，至少支持：

```ts
type WorkPanelItem =
  | { kind: "webclient"; module: "summary" | "project" | "agent" | "copilot"; route: string; context: object }
  | { kind: "native"; surfaceKey: string; context: object }
  | { kind: "web"; url: string; title?: string };
```

要求：

- WorkPanel 负责 Tab 顺序、active item、关闭和恢复；
- WebClient item 使用受控 Service WebView/模块路由；
- Native item 直接渲染 React Surface，不套 WebView；
- Web item 复用现有 `ExternalWebviewPage` 安全能力；
- Tab 切换、Chat 切换、外层路由切换只改 visible/active，不卸载、不关闭、不重建连接；
- 用户明确关闭 Tab、销毁 workspace 或应用退出时才释放资源；
- 被隐藏的 WebView 和 Native Surface 必须保持状态，但停止不必要的绘制、焦点和快捷键处理；
- 不同 chat/workspace 的 item 必须隔离，不得仅凭页面传入的 chatId 跨 workspace 打开。

WorkPanel Action 采用断代升级，只提供结构化的 `openTab`/`activateTab` contract，以及按 URL 调用的 `openWeb`/`refreshWeb`；所有调用方原子切换到当前注册表。

### 8. Summary 点击打开 WorkPanel Tab

新增受控的 WebClient -> Desktop Open Target Bridge。输入是语义化 descriptor，不是任意命令，例如：

- file diff：chatId/runId/filePath；
- artifact：artifactId 及所属 chat/run；
- planning：nodeId；
- project：受控项目路径或项目身份；
- web：通过协议白名单校验的 URL。

处理流程：

```text
Summary click
  -> WebClient OpenTargetIntent
  -> preload/IPC 校验来源
  -> Desktop 解析为 WorkPanelItem
  -> 按 stable target key 查重
  -> 已存在则 activate，不存在则新增并 activate
  -> 返回 itemId/tabId
```

Main/Renderer 必须校验：调用 Surface、owner chat、路径归属、URL scheme、item kind 和权限。禁止执行任意脚本，禁止信任 WebClient 自报的本地路径权限，禁止把 Token 放入 item route 或 URL。

### 9. 重连与恢复

- 连接断开后 pending request 明确失败；
- active Run 不能因为 Renderer 消失而被误判为 cancel；
- 重连成功后先恢复 push subscription，再根据 canonical history/lastSeq 恢复需要的 stream；
- `seq_expired` 时回退到 HTTP/canonical replay，再 attach；
- visible binding 恢复前不允许旧事件进入新 Surface；
- WorkPanel item 恢复时先恢复 descriptor，再恢复可见性与订阅，不持久化 Token、原始事件流或不可序列化对象。

## 测试与验收

至少补齐：

1. 同时挂载 `/agent`、`/copilot`、`/summary`、`/project`，Agent Platform 主业务 WS 为 1；
2. `/agent` 与 `/copilot` Run 并发，二者均继续运行，但仅当前选择的 Run raw stream 可见；
3. 主 Chat 与 Summary 同屏时，上游 attach 为 1，事件顺序与 seq 一致；
4. 切换 visible binding 后，旧 epoch 事件不进入新页面；
5. 多个 push subscriber 可按 type 收到通知，unsubscribe 后停止；
6. Platform 反向 request 仅在来源唯一时到当前 action owner；多 active Run、无 owner、隐藏 owner、已销毁 owner均返回结构化错误；
7. Summary 文件变化持续更新，点击后 WorkPanel 新增或激活对应 Tab；
8. 重复点击同一稳定目标不重复创建 Tab；
9. WorkPanel 同时包含 WebClient、Native、Web item，切换不卸载；
10. 关闭一个 item 只清理其自身，后台 Run 和其他 Surface 不受影响；
11. 重连、Token 刷新、`seq_expired`、Surface 崩溃和应用退出均无 listener/subscription 泄漏；
12. WorkPanel Action 定义、分发和调用方只包含当前 `desktop.workpanel.*` 契约。

执行仓库现有 lint、typecheck、unit/integration test、build，并按 `qa/manual-regression.md` 补充这次跨 WebView/WorkPanel 的手工回归项。对 macOS 和 Windows 的 WebView 隐藏、焦点、快捷键、路径和生命周期差异写显式平台分支并分别验证。

## 文档与交付

本改造跨 Main/preload/renderer、WebView、共享 contract 和 Action Bridge，必须在同一变更更新：

- `docs/架构与模块边界.md`
- `docs/前端嵌入与导航.md`
- `docs/鉴权SSO与TokenBridge.md`
- `docs/桌面协议与动作桥.md`
- `docs/智能助理集成.md`
- `qa/manual-regression.md`

最终报告按“架构变化、协议路由、权限边界、WorkPanel 生命周期、测试结果、迁移与遗留风险”组织。

本次不修改 Agent Platform，不把 Desktop Surface 模型泄漏给后端，不把普通 HTTP Data API 强行迁入 WS，也不顺手重写无关模块。
