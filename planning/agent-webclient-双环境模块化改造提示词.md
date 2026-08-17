# Agent WebClient 双环境模块化改造提示词

> 以下正文可直接交给编码 Agent。目标仓库：`/Users/linlay/Project/zenmind/agent-webclient`。

## 任务

请改造 `agent-webclient`，使它同时支持：

1. `http://localhost:11948/` 完整网站模式，现有能力不得退化；
2. `/agent`、`/copilot`、`/summary`、`/project` 可独立装配、独立直达；
3. 在 ZenMind Desktop 中作为模块化 WebView 使用时，不自行创建每 Surface 一条业务 WebSocket，而是使用 Desktop 提供的实时 Bridge；
4. 主 Chat 与 Summary 同时显示时，共享同一条“当前可见 Run”的事件投影；
5. Summary 中的文件变化、产物、Planning 等条目可点击，并通过宿主适配器请求 Desktop WorkPanel 打开或激活一个新 Tab。

先阅读仓库内 `AGENTS.md`、`README.md`，再阅读并核对以下现有实现，不要脱离现状另起一套系统：

- `src/app/App.tsx`
- `src/app/layout/sidebar/right/OverviewTab.tsx`
- `src/app/layout/sidebar/right/RightSidebar.tsx`
- `src/app/state/`
- `src/features/conversation/hooks/useConversationWsRuntime.ts`
- `src/features/conversation/lib/liveEventDispatch.ts`
- `src/features/transport/lib/wsClient.ts`
- `src/features/transport/lib/wsClientSingleton.ts`
- `src/shared/data/desktop/desktopHostBridge.ts`
- `src/shared/data/desktop/desktopQueryContext.ts`

## 已确认的协议事实

Agent Platform WebSocket 的帧分工如下，不要混淆：

- `frame="stream"`：Run/Terminal 等连续、高数据量 live stream；通过原始请求 `id` 关联 active stream。
- `frame="push"`：连接级通知，例如 chat/run 状态、awaiting、resource、heartbeat、鉴权提示；通常是低数据量监听。
- `frame="response"`、`frame="error"`：按请求 `id` 返回普通请求结果。
- `frame="request"`：Platform 发给客户端的反向请求，例如 WebClient/Desktop Action。

`/agent` 与 `/copilot` 可以同时运行，但产品界面同一时刻只有一个“当前可见 live stream”。并发运行不等于多个 live stream 同时显示。

主 Chat 与 Summary 通常同时出现。Summary 不是只读静态快照，它必须实时消费当前可见 stream 形成的文件变化、Artifacts、Planning 和任务状态；但 Summary 不拥有 Composer，也不能 start、submit、steer、interrupt Run。

## 不可变原则

### 1. 业务模块不直接依赖 WebSocket 实现

定义统一的 `RealtimeTransport` 接口，至少覆盖：

- 普通 request/response；
- query/attach 等 stream 的创建、事件、结束、错误和 detach；
- `push` 按类型订阅；
- Platform 反向 request 的 handler 注册与 response/error 回传；
- 连接状态订阅。

提供两个 adapter：

- `StandaloneRealtimeTransport`：封装现有 `WsClient`；
- `DesktopRealtimeTransport`：只通过 Desktop preload/IPC Bridge 通信。

业务 hook、event processor、Summary、Agent、Copilot 不得判断当前是 Desktop 还是 Standalone。环境选择只允许发生在 Composition Root。

Desktop 模式中不得在 Bridge 不可用时静默退回 `new WebSocket`；应显示可诊断的 transport unavailable 状态。Standalone 模式继续直接连接 Agent Platform。

### 2. 一个可见 stream，一次事件投影

建立明确的 `VisibleConversationRuntime` 或等价边界，身份至少包含：

```ts
type VisibleRunIdentity = {
  chatId: string;
  runId: string;
  streamRequestId: string;
  epoch: number;
};
```

要求：

- 当前主 Chat 是 live stream 的唯一 UI owner；
- Summary 是同一个可见 runtime 的投影消费者，不得为了 Summary 再发起一条上游 query/attach；
- Chat 与 Summary 在同一 React guest 中时，只运行一次 event processor，两者通过 selector 读取同一 conversation projection；
- `/summary` 被 Desktop 作为独立 guest 装配时，通过 Desktop transport 订阅同一 visible binding，不能自行创建物理 WS；
- 切换可见 Chat/Run 时，旧 `epoch` 的迟到事件必须丢弃，不能污染新会话；
- 后台并发 Run 不向当前 Chat/Summary 投影 raw stream；它们只通过 `push` 或历史快照更新列表、角标和状态。

不要用 `BroadcastChannel` 复制完整 `AppState`，也不要让 Chat 和 Summary 各跑一遍相同 reducer。

### 3. 正确区分 stream 与 push

现有 `fileChanges` 来自 live event processor，例如 `UPSERT_FILE_CHANGE`，这条链路必须保留：

```text
frame=stream
  -> AgentEvent
  -> event processor
  -> UPSERT_FILE_CHANGE / UPSERT_ARTIFACT / SET_PLAN ...
  -> Chat + Summary selectors
```

`frame=push` 单独进入 Push Runtime：

- 支持多个按 `type` 订阅的消费者；
- 用于 chat/run 状态、awaiting、resource 和角标刷新；
- 不要把所有 push 注入 conversation timeline；
- 不要把文件变化的 live stream 错改成只依赖 push。

### 4. 模块入口与 Provider 裁剪

保留根网站现有完整 Shell，同时增加或整理以下独立入口：

- `/agent`、`/agent/:agentKey`：对话、Composer、Run 控制，并可装配 Summary；
- `/copilot`、`/copilot/:agentKey`：Copilot 对话与页面上下文，并可装配 Summary；
- `/summary`：当前可见 Chat/Run 的实时 Summary，支持独立宿主，但不装配 Composer/Voice/Run 控制；
- `/project`：Project Workspace 独立入口。

路由参数只传递 agent/chat/run/tab 等身份和展示上下文。禁止在 URL 中放 Token、AgentEvent 或序列化 AppState。

抽出最小 Core Providers：theme、i18n、auth、runtime、transport。模块只装配自己需要的领域 Provider。不要为了这次任务一次性重写整个全局 reducer；先建立清晰边界，再渐进迁移。

### 5. Summary 必须是实时视图

优先复用并拆分现有 `OverviewTab`，而不是重新造一份 Summary 数据模型。至少保留：

- 文件变化与增删行统计；
- 文件 diff 的延迟加载；
- Planning/任务状态；
- Artifacts；
- Run/Chat 切换后的清理和历史恢复；
- live event 到达时的增量刷新。

Summary 只读取当前 visible conversation projection。它不能注册 Platform 反向 Action handler，也不能成为 Action owner。

### 6. Summary 点击统一发出语义化 Open Target Intent

将 Summary 条目的“打开详情”从具体 UI 容器中解耦。定义版本化、结构化、可校验的 intent，例如：

```ts
type OpenTargetIntent =
  | { version: 1; kind: "file-diff"; chatId: string; runId: string; filePath: string; title?: string }
  | { version: 1; kind: "artifact"; chatId: string; runId?: string; artifactId: string; title?: string }
  | { version: 1; kind: "planning"; chatId: string; nodeId: string; title?: string }
  | { version: 1; kind: "project"; chatId?: string; path?: string; title?: string }
  | { version: 1; kind: "web"; url: string; title?: string };
```

最终字段可根据现有 contract 调整，但必须保持语义化：WebClient 不得发送任意脚本、DOM 指令或未经校验的 `file://` URL。

提供两个 `OpenTargetAdapter`：

- Standalone：沿用 WebClient 自身的 inline diff、RightSidebar preview、Project route 或受控网页打开能力；
- Desktop：通过现有 host message/preload 体系发送带 requestId 的 intent，等待 Desktop 返回已打开/已激活的 WorkPanel item 结果。

同一个稳定目标重复点击时，宿主可激活已有 Tab，而不是无限复制。WebClient 不得自己维护 Desktop WorkPanel 的 Tab 状态。

### 7. Platform 反向 Action 边界

`/agent` 或 `/copilot` 中只有当前可见、可交互的 Chat runtime 可以注册反向 Action handler。`/summary`、`/project` 和隐藏的后台会话不得抢占 handler。

Desktop transport 可能因为多个 active Run 导致 Action 来源无法判定而返回 `ambiguous_action_target`。WebClient 应将其作为明确的能力限制展示/记录，不能绕过 Bridge 自建 WS 重试，也不能把请求广播给隐藏模块。

这条链路与 “Summary 点击打开 WorkPanel” 是两个方向不同的协议，不能复用成模糊的任意消息：

- Platform 反向 Action：Platform -> Desktop/WebClient；
- Summary Open Target：WebClient -> Desktop WorkPanel。

## 兼容与迁移要求

- 保留 `http://localhost:11948/` 的导航、聊天、管理页、Project、Voice、BTW、HTTP 代理和直接 WebSocket 能力；
- 使用同一构建产物，不拆成四个 npm 包或四套部署；
- Standalone 不依赖 Electron preload；
- Desktop 模式不向 guest 暴露 Agent Platform Token；
- 为旧调用提供短期兼容 adapter，并添加弃用标记；完成迁移后删除每 Surface 自建业务 WS 的路径。

## 测试与验收

至少补齐以下自动化测试：

1. `RealtimeTransport` contract tests，Standalone/Desktop 两个 adapter 使用同一组行为用例；
2. Chat 与 Summary 同时挂载时，一条 stream event 只执行一次 projection；
3. 文件变化 stream event 到达后，Summary 立即更新；
4. 后台 `/copilot` Run 的 stream 不污染当前 `/agent` Summary，反之亦然；
5. `push` 可被多个订阅者接收，unsubscribe 后不再接收；
6. visible binding 切换后，旧 epoch 的迟到 stream 被丢弃；
7. Summary 点击在 Standalone 使用本地 adapter，在 Desktop 发送结构化 intent；
8. `/summary` 不具备 start/interrupt/submit/steer 和反向 Action handler；
9. Desktop 返回 `ambiguous_action_target` 时不重试到其他 Surface、不自建 WS；
10. 根网站及四个模块路由可直达、刷新、返回；
11. Desktop adapter 不出现业务 `new WebSocket` fallback。

运行仓库现有 lint、typecheck、unit test、build，并做浏览器回归：

- `http://localhost:11948/` 完整网站；
- `/agent` 与 Summary 同屏；
- `/copilot`；
- `/summary` 独立入口；
- `/project`；
- 文件变化持续到达与点击打开详情。

## 交付要求

- 先列出将修改的模块边界和兼容策略，再实施代码；
- 更新仓库相关架构文档和测试；
- 最终报告按“改了什么、为什么、协议边界、测试结果、遗留风险”组织；
- 不修改 Agent Platform 的 WS 协议，不把 Desktop Surface 语义引入 Agent Platform。
