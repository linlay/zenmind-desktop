# Kanban 云端与 Desktop 同步协议 v3.2

## 1. 范围与兼容性

v3.2 在 v3.1 增量同步和远程 delivery 协议之上，增加 Desktop 原子认领与用户手动运行能力。WebSocket wire version 仍为整数 `v: 3`，业务版本通过 URL 与 `sync.hello.payload.contractVersion = "3.2"` 协商。Server 的 hello response 同时返回 `capabilities: ["issue.claim", "run.event.append.desktop_manual"]`；Desktop 必须同时看到 3.2 和对应能力才显示动作，避免旧 Server 原样回显未知版本时误开放。

- 旧 Desktop 继续以只读云缓存方式工作。
- Website 的 `issue.run.request → command.runIssue` 远程派发链保持不变。
- Desktop 不调用 `issue.run.request`，不新增 `issue.claimAndRun`。
- Desktop 仅新增受限的 `issue.claim`；Issue 正文、拖拽、删除和通用 CRUD 仍由 Website/Server 管理。

最终链路：

```text
Desktop -> Kanban Server: issue.claim
Desktop -> Agent Platform: POST /api/query
Desktop -> Kanban Server: run.event.append
Kanban Server -> Website/Desktop: issue.updated
```

## 2. 身份与授权

Desktop WebSocket session 的 actor 始终来自已验证 JWT `sub`。`sync.hello.ownerUserId` 只能与 JWT subject 相同，不能覆盖 session 身份。

Desktop 的 `issue.claim` 与 `desktop_manual` 运行还必须满足：

- 当前用户具有 Project 访问权限；
- Project 位于当前 Desktop device binding scope；
- 手动运行选择的 Agent 出现在当前 Desktop session 的 Agent 能力列表中。

## 3. `issue.claim`

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.claim",
  "id": "stable-mutation-id",
  "role": "desktop",
  "projectId": "project-id",
  "payload": {
    "id": "issue-id",
    "baseIssueRevision": 12
  }
}
```

语义：

- 只允许 contract 3.2 Desktop 调用。
- Server 使用 JWT subject 作为 assignee，不接受 Desktop 指定 `ownerUserId`、worker 或 Agent。
- 只认领未分配的 Todo；本人已认领时幂等成功，别人已认领返回 `already_claimed`。
- 成功只写 assignee、Issue revision 和权威 `issue.updated`，不选 Agent、不创建 delivery、不启动 run、不改变 Todo。
- Request `id` 是持久 mutation key。请求中断后 Desktop 使用同一 ID 重试。

## 4. Desktop 手动运行

Renderer 只触发本地 IPC：

```ts
kanban.runIssue({ issueId, agentKey })
```

Main 在调用 Agent Platform 前检查 Cloud Todo、当前 JWT 用户已认领、Kanban WS 在线、Agent 本机可用且没有 active run。随后：

1. 预生成并持久化 `chatId`、`runId` 和 manual run receipt；
2. 用相同 ID 调用正常 Chat `POST /api/query`；
3. Query 接受后，将 `run.started` 写入持久化 outbox；
4. Server 原子绑定 worker Agent、device、`chatId`、`runId`、run state，并切换到 In Progress；
5. Server 拒绝 `run.started` 时 Desktop 调用 `assistant.stopRun(runId)`。

Query 启动失败时不发送 `run.started`，Issue 保持已认领的 Todo。重启恢复先按 receipt 的 `chatId/runId` 查询 Agent Platform；已存在的 run 不重复 Query，不存在且仍处于 `starting` 的 receipt 才使用相同 request identity 恢复启动。

Agent 选择顺序为 Issue 已绑定且本机可用的 Agent、Desktop 默认 Chat Agent、用户显式选择。运行成功后导航唯一主 Chat 路由 `/agent/:agentKey?chatId=...`，不创建 Kanban 专用 WebView。

## 5. `run.event.append`

手动开始事件：

```json
{
  "deviceId": "desktop-device-id",
  "clientEventId": "stable-event-id",
  "projectId": "project-id",
  "issueId": "issue-id",
  "chatId": "chat-id",
  "runId": "run-id",
  "eventType": "run.started",
  "payload": {
    "source": "desktop_manual",
    "agentKey": "agent-key"
  }
}
```

终态继续使用 `run.completed`、`run.failed`、`run.cancelled`。`clientEventId` 由 `deviceId + issueId + runId + eventType` 稳定生成；事件在发送前进入 SQLite outbox，断线和重启后使用同一 ID 重试。

Server 按来源校验：

- `desktop_manual`：当前 JWT 用户必须是 assignee，Agent 必须属于当前 Desktop；
- `cloud_dispatch`：沿用 command、delivery 和目标设备校验。

只有精确匹配 active `runId` 的终态才能改变 Issue。相同 `chatId` 不足以关联终态，因此普通 Chat 后续消息产生的新 run 不会修改 Issue。

状态收敛完全依赖 Server 的 `issue.updated`：成功且当前工作流存在 `reviewRequired` 审核节点时进入 In Review，否则进入 Completed；Failed/Cancelled 回到 Todo，且不会自动循环重试。

## 6. Private Issue

Private Issue 只存 Desktop SQLite，不进入 cloud mutation/run-event outbox，不发送 Kanban WS 请求，标题、描述、附件和本地路径也不得进入 Kanban WS 日志。

Private Issue 创建或由用户移入 Todo 后，若已选 Agent、没有 automation 且没有 active run，可自动走正常 `/api/query`。成功进入 Completed，失败或取消回 Todo；回到 Todo 后不自动再次执行。

## 7. 发布顺序

先发布支持 contract 3.2 的 Kanban Server，再发布 Desktop。Desktop 连接未返回 3.2 的 Server 时隐藏“认领”和“开始处理”，继续按 v3.1 只读缓存运行。
