# WebClient 双环境架构改造·三项目要点

## 1. 结论

本次改造的主体是 `zenmind-desktop` 和 `agent-webclient`。

`agent-platform` 默认不需要理解 Desktop Surface，也不需要负责 Surface 的注册、销毁和分发。Desktop 可以利用 Agent Platform 现有的“一条 WebSocket 承载多个 request/stream”能力，在 Main 进程内完成 Surface 级路由。

`/agent` 和 `/copilot` 可以并发运行，但当前产品同一时刻只有一个可见 live stream。Stream/push 的复用与分发由 Desktop 完成；反向 Desktop Action 使用携带可信 Run 来源的统一 envelope，并由 Platform 根据 runtime mode 与当前 run target 选择 Desktop 或 Standalone provider。

## 2. 四条不可变原则

1. **Desktop 单物理 WS**

   同一 Desktop 登录运行时只保留一条到 Agent Platform 的主 WebSocket。Surface 是逻辑消费者，不是 Socket owner。

2. **WebClient 模块可独立使用**

   `/agent`、`/copilot`、`/summary`、`/project` 是可直达、可独立宿主的入口，共享领域能力，不共享整棵页面状态。

3. **WebClient 完整网站模式必须保留**

   `http://localhost:11948/` 仍是完整可用的 Standalone 网站。模块化是增加组装方式，不是拆掉原网站。

4. **WorkPanel 归 Desktop 组合**

   WorkPanel 是原生 Surface、WebClient WebView 和普通 Web Surface 的组合容器。Tab 或布局切换只改可见性，不卸载、不关闭、不重建连接。

## 3. 目标结构

```text
Standalone

  localhost:11948 完整网站 / 独立模块路由
        -> Standalone Realtime Transport
        -> WebClient 现有 WsClient
        -> Agent Platform /ws

Desktop

  /agent guest      --\
  /copilot guest    ----\
  /summary guest    ------> preload / IPC
  /project guest    ----/          |
  native panels     --/            v
                             Desktop Realtime Broker
                                      |
                                      v
                          单物理 WS -> Agent Platform /ws
```

这条单物理 WS 可以承载多个 active stream，但 Desktop 同一时刻只建立一个 `VisibleStreamBinding`。主 Chat 与 Summary 同时显示时共享这个 binding；后台 Run 的 raw stream 不投影到当前 UI，运行状态主要通过 `frame=push`、HTTP snapshot 和切换后的 replay 呈现。

普通 CRUD、历史 replay、资源和上传继续走 HTTP。Desktop 原生能力继续走受限 Bridge。Run、订阅、控制、push 和反向 request 由实时传输层承载。

状态所有权：

- Agent Platform 拥有 Run 语义、持久状态和 canonical seq。
- Desktop 拥有物理连接、Surface 登记、订阅共享和 IPC 定向分发。
- 每个 WebClient guest 只拥有自己的 UI 投影。

## 4. `zenmind-desktop` 改造要点

### 4.1 Main 维护唯一实时连接

- 按 Agent Platform endpoint 和当前身份会话维护单物理 WebSocket。
- 统一处理 Token 刷新、心跳、断线重连、协议错误和性能指标。
- WebView 和 Desktop renderer 不得再各自建立业务 WebSocket。

### 4.2 Desktop Realtime Broker

Broker 维护以下关系：

```text
IPC sender / surfaceId
    <-> local requestId
    <-> upstream requestId / streamId
    <-> runId / subscription
```

- Surface 发起 query、attach 或 control 时，Broker 生成全局唯一的上游 requestId。
- 上游 response、stream event、done 和 error 只发回对应 guest。
- 同一 Run 被主 Chat 与 Summary 观察时，Desktop 只建立一个上游 attach，再在本地扇出。
- Surface detach 只移除本地订阅；最后一个订阅离开也不默认 interrupt Run。
- Surface 销毁后必须清理其 pending request、listener 和 subscription。
- `/agent` 与 `/copilot` 可同时保有 active stream，但只有当前 `VisibleStreamBinding` 的 raw event 投递给可见 Chat/Summary；其他 stream 由 Main drain 并记录 lastSeq/终态。
- `frame=push` 按 type/filter 分发给多个显式订阅者，不注入所有 conversation timeline。

### 4.3 Preload 与安全边界

- preload 只暴露受限的 register、request、subscribe 和 detach 能力。
- Main 从真实 IPC sender、BrowserSurfaceRegistry、partition 和 origin 计算 Surface 权限。
- 不信任页面自报的 `surfaceId`、capability 或目标 URL。
- `/summary` 是只读 Run consumer，不具备 start、interrupt、submit 和 steer 权限，但必须接收当前可见 stream 中的文件变化、Artifacts、Planning 和任务状态。

### 4.4 WorkPanel 组合模型

WorkPanel item 可以是：

- WebClient module WebView，例如 `/summary` 或 `/project`。
- Desktop 原生 React Surface。
- Website/WebApp/普通网页 Surface。

创建后保持 mounted：

- Tab 切换只更改 active/visible。
- Chat 或外层路由切换不默认销毁 WorkPanel item。
- 只有用户显式关闭、workspace 销毁或应用退出才释放 guest、subscription 和 partition。
- 原生 Panel 不为了统一容器而被包成 WebView。

## 5. `agent-webclient` 改造要点

### 5.1 四个独立模块入口

- `/agent` 或 `/agent/:agentKey`：完整对话和 Run 交互。
- `/copilot` 或 `/copilot/:agentKey`：Copilot 对话与页面上下文。
- `/summary`：当前可见对话/Run 的实时只读摘要展示。
- `/project`：现有 Project Workspace 独立页。

路由参数只传递 agent、chat、run、tab 等身份和展示上下文，不传 Token、AgentEvent 或完整 AppState。

### 5.2 最小化模块装配

- 共享 i18n、theme、auth、runtime 和 transport 等 Core Providers。
- 每个模块只装配自己需要的 conversation、summary 或 project 状态。
- 共享纯 eventProcessor、reducer 和领域展示组件，不通过 BroadcastChannel 同步完整 AppState。
- `/summary` 不初始化 Composer、Voice、BTW、全量 Action Runtime 等无关能力，但复用当前可见 Chat 的 live event projection；`/project` 不初始化 conversation runtime。

### 5.3 实时传输抽象

WebClient 只依赖统一 Realtime Transport，不在业务模块判断 Desktop/Standalone：

- Standalone adapter 包装现有 `wsClient`。
- Desktop adapter 只调用 preload bridge。
- Desktop guest 内禁止以 `new WebSocket` 作为业务实时通道或 bridge 失败后的静默 fallback。
- Run stream、push notification 和反向 request 可以拆成不同消费者，但必须共用同一 transport。
- Chat 与 Summary 同 guest 时只运行一次 event processor；不同 guest 时订阅同一个 Desktop visible binding，不创建第二条上游 stream。

### 5.4 Summary 打开 WorkPanel 目标

- Summary 中的文件变化、Artifacts、Planning 等条目发出语义化 `OpenTargetIntent`。
- Standalone adapter 继续使用 WebClient 自己的 inline diff、RightSidebar preview 或 Project route。
- Desktop adapter 将 intent 交给 WorkPanel，按 stable target key 新建或激活 WebClient、原生或 Web item。
- WebClient 不直接维护 Desktop Tab，不发送任意脚本、DOM 指令或未校验的 `file://` URL。

### 5.5 保留 Standalone 网站

- 根路由仍组装现有完整网站 Shell。
- 现有导航、聊天、管理页、Project、Voice、BTW、HTTP 代理和 WebSocket 模式继续可用。
- 四个模块入口与完整网站使用同一构建产物，不拆成四个 npm 包或四套部署。
- Standalone 不依赖 Desktop preload 才能启动。

## 6. `agent-platform` 改造要点

### 6.1 默认方案：不做 Surface 改造

Agent Platform 继续作为 WebClient Standalone 和 Desktop 共用的独立后端：

- 保留现有 `/ws` request/response/stream/push 协议。
- 保留一条连接内多个 active stream 的能力。
- 不定义 Desktop Surface、WebView、WorkPanel 或 IPC 语义。
- 不将 Desktop bridge contract 放入 Agent Platform。
- WebClient Standalone 继续直接连接 Agent Platform。

在此方案下，Desktop Main 对 Agent Platform 表现为一个普通 WebSocket client，Surface 复用与分发全部发生在 Desktop 内部。

### 6.2 反向 Action 的边界

Agent 只提交统一的 `desktop.*` action。Platform 使用当前 run 的内存 target，并按 runtime mode 路由：Desktop 模式发送 `desktop.action.call` 给 Desktop Main Broker；Standalone 模式只把 `desktop.workpanel.*` 发送给根 agent-webclient。`/agent*`、`/copilot*` 等子路由不是动作 provider。目标缺失或断连时直接失败，不猜测、不广播，也不选择其他连接。

## 7. 最小实施顺序

1. **Desktop 单 WS 竖切**

   先让一个 `/agent` Surface 通过 Desktop Main 完成 query、attach、control、push 和清理，Agent Platform 不改。

2. **WebClient Realtime Transport**

   建立 Standalone/Desktop 两个 adapter，将业务模块中的环境分支收敛到 Composition Root。

3. **WebClient 模块入口**

   完成 `/agent`、`/copilot`、`/summary`、`/project` 的独立装配，同时保持根网站全功能。

4. **Desktop WorkPanel 组合**

   同时挂载 WebClient WebView、原生 Surface 和普通 Web Surface，验证隐藏不卸载。

5. **验证统一反向 Action 路由**

   验证 Platform 按 runtime mode 与当前 run target 选择 Desktop 或 Standalone provider；目标缺失、断连或 runtime 不支持时 fail closed。

6. **迁移与旧路径下线**

   收敛 Copilot、Summary 和 Desktop 内其他重复的 Platform 实时连接，再删除每 Surface 自建 WS 路径。

## 8. 验收条件

### Desktop

- 同时挂载 `/agent`、`/copilot`、`/summary`、`/project` 时，到 Agent Platform 的物理主 WS 为 1。
- 同一 Run 被多 Surface 观察时，上游 attach 为 1，每个 Surface 的 seq 最多投影一次。
- `/agent`、`/copilot` Run 可并发，但任一时刻只有一个 raw live stream 对主 Chat/Summary 可见。
- 当前 Summary 持续处理 `frame=stream` 产生的文件变化等数据；点击条目可在 WorkPanel 新建或激活 Tab。
- WorkPanel 切换不触发 guest 卸载、WebSocket 重连或意外 detach。
- 关闭一个 Surface 只清理它自己，不影响其他 Surface 或 Run。
- Desktop guest 中没有业务 `new WebSocket` 逃生路径。

### WebClient Standalone

- `http://localhost:11948/` 的导航、聊天、管理、Project、Voice 和 BTW 继续可用。
- 四个模块路由可单独直达。
- Standalone 可自主处理 HTTP、WebSocket、Token 和断线重连，不依赖 Desktop。

### 资源与清理

- Surface 销毁后 pending、subscription、listener 和 timer 回到基线。
- 10 分钟多 Surface 运行时，连接、RunRecord 和内存不持续增长。
- 没有通过 BroadcastChannel 复制完整 AppState。

## 9. 本轮不做

- 不把 WebClient 拆成四个 npm 包或四套构建、部署体系。
- 不将普通 Data API、文件和资源强行迁入 WebSocket/IPC。
- 不将 Desktop Surface 模型泄漏给 Agent Platform。
- 不保留 Desktop bridge 失败后每 Surface 自建 WS 的静默 fallback。
- 不因模块化顺手重写全局 reducer、升级 React/Electron 或做无性能数据支持的全仓优化。
