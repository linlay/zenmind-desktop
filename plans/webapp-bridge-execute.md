# WebApp Bridge 接入 Platform `/api/execute` 改造计划

> 状态：计划，未实现。依据 zenmind-desktop `980b7d6f`（v0.5.27）与 agent-platform `28c9c1b0`（v0.5.27）的代码和文档整理。不确定之处标「待确认」。

## 1. 背景与目标

agent-platform 新增 `POST /api/execute`：把带 `result_submit` 的 Native Agent 当作工作流节点调用，调用方给出任务说明、任务数据和输出 JSON Schema，同步等待一次通过校验的结构化结果（agent-platform `docs/智能体执行接口.md`、`internal/server/server_routes.go:336`）。

Desktop 的 WebApp Bridge 目前只有 `assistant.chat`，底层统一走 `/api/query`；仓库内搜索 `api/execute` 零命中。

目标：在 WebApp Bridge 中新增与 `assistant.chat` 并列的 `assistant.execute`，让 WebApp 页面与受管 Node 后端都能以结构化方式调用 Agent，且 WebApp 仍不接触 Platform token。

## 2. 现状

### 2.1 query 链路（`assistant.chat`）

- SDK：`contracts/webapp/bridge.mjs:362-380`（`assistant.chat / subscribe / stop`）；README `contracts/webapp/README.md:46-47,68-69`。
- 公开名到内部 action 的映射：`src/shared/webapp-bridge.ts:71,96`（`assistant.chat` → `desktop.assistant.chat`，并配 `assistant.events`、`assistant.stop`）；白名单映射规则 `src/shared/webapp-bridge.ts:121-134`。
- 主进程处理：`src/main/modules/desktop-actions/action-dispatch.ts:82-186`
  - `background: true` → `startWebappAssistant`（L153-155，`src/main/modules/desktop-actions/webapp-assistant.ts:16-74`）→ `assistantBridge.startRun`。
  - 否则 → `assistantBridge.completeText`（L157-186），同步返回 `{text, agentKey, runId, chatId}`。
- 两条路都进入 `src/main/modules/agent-platform/run-controller.ts` 的 `runQuery`（L433-494），经 `realtimeBroker.query` 以 WS 发 `/api/query`；后台 Run 的 `forwardRequest` 固定 `type: "/api/query"`（L186-192）。
- Platform token 由主进程取得：`src/main/modules/agent-platform/platform-client.ts:52-59`（`issueAccessToken`），WebApp 不经手。

### 2.2 两种 WebApp 调用入口与 token

| 入口 | 传输 | 服务端路径 | token scope | 代码 |
|---|---|---|---|---|
| 页面 | 同源 `fetch('/__desktop/actions/call')` → gateway → loopback HTTP | `/webapps/pages/actions/call` | `localPageGateway`（page token，由 gateway 注入） | `contracts/webapp/bridge.mjs:1,25`；`src/main/modules/webs/webapps/gateway.ts:27,494-516`；`src/main/modules/desktop-actions/action-http-server.ts:138-163` |
| 受管 Node 后端 | `createBackendClient({url, token})` → loopback HTTP | `/webapps/actions/call` | `backendActionToken`（环境变量注入） | `contracts/webapp/bridge.mjs:387-399`；`src/main/modules/webs/webapps/launchers.ts:154-157`；`src/main/modules/desktop-actions/action-http-server.ts:105-130` |

- token 缺失、过期或越权返回 403（`action-http-server.ts:119,152`）。
- 文档约束：page token 不进入 HTML/URL/日志（`docs/本地网站应用.md:97`）；页面不能读取 Platform token（`docs/本地网站应用.md:101`）；应用标识来自宿主 token（`docs/本地网站应用.md:154`）；后端凭据不得转给前端（`contracts/webapp/bridge.mjs:385-386`）。本地调用身份为本地应用主体，与官网登录无关（`docs/鉴权SSO与TokenBridge.md:72,74`）。

### 2.3 现有限制

- Agent 选择：默认 `desktopHelperAgentKey`；Manifest 声明 `copilot` 时用其 `agentKey`；用户配置中 `source: desktop.agents` 的 select 字段可覆盖，但须在 Agent 列表中存在（`action-dispatch.ts:99-142`）。
- 参数白名单：仅 `message`、`skillIds`、`background`（`action-dispatch.ts:83-94`）；`skillIds` ≤16 且须属于 Manifest copilot references（L112-119）；`background` 必须为 boolean（L152）。
- message ≤ 12000 字符（`src/shared/webapp-manifest.ts:7`；`action-dispatch.ts:144-150`）。
- 请求体：gateway 64 KiB（`gateway.ts:31`；`docs/本地网站应用.md:101`），action server 256 KiB（`action-http-server.ts:18`）。
- 页面经 gateway 转发超时 120 秒（`gateway.ts:516`）。
- 后台 Run：最多 128 个、单个 30 分钟释放、每秒校验实例、每 Run 最多缓存 256 条事件、只转发文本与 run 状态事件（`webapp-assistant.ts:10-11,17,29-37,49-58`）。
- 取消：`assistant.stop` 只作用于本应用 Run（`webapp-assistant.ts:81-88`）。

## 3. Platform `/api/execute` 接口约定

来源：agent-platform `docs/智能体执行接口.md`、`docs/API与协议.md:390`、`internal/server/handler_execute.go:22-62`、`internal/server/server_auth.go:44-84`。

- 仅 HTTP：`server_routes.go:336`；WS 只注册 `/api/query`（`internal/server/ws_routes.go:214`）。
- 请求：`application/json`，或 `multipart/form-data`（`request` 字段放 JSON，其余字段为文件）。
  - 必填：`agentKey`（有效工具须含 `result_submit`）、`message`、`outputSchema`（根 `type: object`，≤64 KiB）。
  - 可选：`input`（任意 JSON，`{"$file":"<字段名>"}` 引用文件）、`requestId`（不去重）、`accessLevel`（`default` / `auto_approve` / `full_access`）。
  - 严格解码：未知字段返回 400 `unknown_field`；不接受 `chatId`、`references`、`stream`、`planningMode` 等 query 字段；每次新建 Chat。
- 响应：同步等待 Run 结束。成功 `{code:0, data:{chatId, status:"success", output}}`；Agent 交 failure 时 `{chatId, status:"failure", reason}`。无异步启动、无按 requestId 查询。
- 错误：

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_request` / `unknown_field` | 请求、Schema、文件引用或 accessLevel 不合法 |
| 400 | `result_submit_unavailable` | 目标 Agent 无 `result_submit` |
| 400 | `execute_unsupported_agent` | 非 Native Agent |
| 404 | `agent_not_found` | Agent 不存在 |
| 403 | `approval_required` | 遇到需人工审批的操作 |
| 422 | `output_missing` / `output_invalid` | 未交卷或打回次数用完 |
| 409 | `cancelled` | Run 被中断 |
| 500 | `run_error` | 模型或工具故障 |

- 取消：调用方断开连接即中断 Run。
- 鉴权：`/api/*` 在 Platform 开启鉴权时校验 Bearer 或 Cookie（`server_auth.go:49,63-83`）；`/api/execute` 不在强制鉴权名单中（L48）。Desktop 侧无论如何都应携带主进程签发的 token。

## 4. 方案

### 4.1 SDK

在 `contracts/webapp/bridge.mjs` 的 `createDataClient` 的 `assistant` 中新增：

```js
assistant.execute({ message, outputSchema, input?, skillIds?, accessLevel? }, { signal? })
// → { chatId, status: "success", output } | { chatId, status: "failure", reason }
```

- 页面与 `createBackendClient` 均暴露（两边共用 `createDataClient`）。
- `signal` 中止即断开请求（见 4.5）。
- `accessLevel` 是否开放给 WebApp：「待确认」（建议首版不开放，固定 `default`）。

### 4.2 内部 action 与能力

- `src/shared/webapp-bridge.ts`：`WEBAPP_BRIDGE_ACTIONS` 增加 `assistantExecute: "desktop.assistant.execute"`；新增能力 `assistant.execute`（或并入 `assistant.chat` 能力，「待确认」）并写入 `WEBAPP_BRIDGE_CAPABILITY_ACTIONS`。
- `src/shared/desktop-actions.ts`：登记 `desktop.assistant.execute` 定义（参照 L298 `desktop.assistant.chat`）。

### 4.3 参数白名单与校验（主进程）

- 仅允许 `message`、`outputSchema`、`input`、`skillIds`（及待定的 `accessLevel`）；其他键返回 `invalid_args`。
- `message`：非空，≤12000 字符（复用 `WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS`）。
- `outputSchema`：plain object，`type === "object"`，序列化后 ≤64 KiB；完整 Schema 校验交给 Platform（不在 Desktop 重复实现）。
- `input`：可 JSON 序列化；受整体请求体上限约束（页面 64 KiB / 后端 256 KiB）。
- `skillIds`：沿用现有规则（≤16，须属于 Manifest copilot references）。注意 Platform execute 不接受 `references`，skillIds 如何传递「待确认」（可能只能首版不支持）。

### 4.4 Agent 选择与调用

- Agent 选择沿用 `desktop.assistant.chat` 的规则（`action-dispatch.ts:99-142`），建议抽成共享函数供 chat / execute 共用。
- 目标 Agent 须带 `result_submit`：以 Platform 返回 `result_submit_unavailable` 为准；Desktop 是否预检（例如 Agent 列表是否暴露工具信息）「待确认」。
- 主进程通过 `PlatformClient.resolvePlatform()`（内部 `issueAccessToken`）取得 baseUrl 与 token，用 HTTP `POST /api/execute`（可复用 `platformFetch`，`platform-client.ts:66`）；WebApp 不接触 Platform token。
- 调用前后用 `captureWebappContext(...).check()` 校验实例身份，与现有 `assistant.chat` 一致；成功后 `rememberWebappChat` 记录 chatId。
- 页面与后端入口复用现有 page/backend token 与 scope，不新增 token 类型。

### 4.5 超时与取消

- 问题：execute 同步等待 Run 结束，常超过 gateway 的 120 秒（`gateway.ts:516`）。备选（「待确认」）：
  1. gateway 对 `desktop.assistant.execute` 单独放宽超时；
  2. 后台化：Desktop 主进程持有 HTTP 请求，向 WebApp 返回 `{runId/jobId}`，WebApp 用类似 `assistant.events` 的轮询取结果；
  3. 首版仅建议后端调用长任务，页面调用受 120 秒限制。
- 取消：Platform 在调用方断开时中断 Run。Desktop 需把 WebApp 的 abort、实例失效（`context.signal`）、应用停止、退出账号转化为对 Platform HTTP 请求的 abort。若采用后台化，`assistant.stop` 需支持 execute 任务。

### 4.6 错误码映射

| Platform | WebApp 侧 code（建议） |
|---|---|
| 400 `invalid_request` / `unknown_field` | `invalid_args` |
| 400 `result_submit_unavailable` / `execute_unsupported_agent` | `assistant_agent_unsupported` |
| 404 `agent_not_found` | `assistant_agent_unavailable`（与现有一致） |
| 403 `approval_required` | `approval_required`（原样透传，提示需人工审批） |
| 422 `output_missing` / `output_invalid` | 原样透传 |
| 409 `cancelled` | `cancelled` |
| 500 `run_error` | `assistant_failed`（不转发 `data.cause` 原文，「待确认」） |
| 401 / 网络错误 | `assistant_unavailable` |

失败时尽量带回 `chatId` 便于排查（与现有 `assistant_failed` 的 details 一致）。`status: "failure"` 属于业务结果，不当作错误。

### 4.7 multipart 文件

是否支持「待确认」。若支持：页面需走专用上传入口（参照 Assistant Image 一次性句柄，`docs/本地网站应用.md:101`），主进程再组装 multipart；首版建议仅 JSON。

## 5. 需要改动的文件（预估）

- `contracts/webapp/bridge.mjs`（SDK `assistant.execute`）
- `contracts/webapp/README.md`（SDK 文档）
- `src/shared/webapp-bridge.ts`（action / capability 映射）
- `src/shared/desktop-actions.ts`（action 定义）
- `src/main/modules/desktop-actions/action-dispatch.ts`（新 case；抽 Agent 选择函数）
- 新增 `src/main/modules/desktop-actions/webapp-execute.ts`（或放入 `webapp-assistant.ts`）
- `src/main/modules/agent-platform/platform-client.ts` / `bridge.ts`（HTTP execute 调用封装）
- `src/main/modules/webs/webapps/gateway.ts`（若采用单独超时）
- `docs/本地网站应用.md`、`docs/智能助理集成.md`（说明）
- 生成的 schema / 类型（`contracts/webapp/webapp.schema.json` 是否需改「待确认」）

## 6. 测试计划

- SDK：`test/webapp-sdk.test.mjs` 增加 `assistant.execute` 的请求形状、错误包装、signal 中止。
- 主进程：`test/desktop-action-bridge.test.mjs` 增加白名单、message 长度、outputSchema 根类型与 64 KiB 上限、skillIds 规则、Agent 选择、错误码映射（含 403 `approval_required`）、实例失效中止。
- 入口：`test/webs.test.mjs` 验证页面 gateway 与后端 token 两条入口都能调用、scope 不串用、缺 token 返回 403。
- Platform 交互：用假 HTTP 服务验证携带主进程 token、请求体字段、断开即中止。
- 手工回归：在 `qa/manual-regression.md` 增加 execute 用例（「待确认」格式）。

## 7. 风险与待决问题

- 超时策略（4.5）「待确认」。
- execute 不接受 `references`，WebApp 声明的 copilot skills 如何生效「待确认」。
- 是否向 WebApp 开放 `accessLevel`；`full_access` 风险较高，建议不开放「待确认」。
- multipart 文件支持「待确认」。
- execute 结果 `output` 中的 `@chat/...` 文件如何让 WebApp 读取（是否复用 `artifact.read`）「待确认」。
- Platform 无按 requestId 去重，Desktop 不得自动重试，避免重复执行。
- 是否需要 Platform 侧同步改动（如 WS 版 execute）「待确认」，需与 Platform 负责方确认。
