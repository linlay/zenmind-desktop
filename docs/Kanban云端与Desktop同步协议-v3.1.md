# Kanban 云端、Website 与 Desktop 同步协议 v3.1

## 1. 文档状态

本文是 ZenMind Kanban 跨 `zenmind-kanban-server`、`zenmind-kanban-website` 和 `zenmind-desktop` 的 JSON 对接规范。

协议标记：

- **Current v3**：兼容层保留的旧 v3 行为，用于尚未升级的 Website/Desktop。
- **Target v3.1**：v3.1 的规范行为；三端代码已于 2026-07-12 按此合同完成首轮实现。
- **Compatibility**：v3 客户端连接 v3.1 Server 时的兼容规则。

本文中的 wire protocol 仍使用整数 `v: 3`。`v3.1` 是业务 contract 版本，通过 `sync.hello.payload.contractVersion` 协商，不把 WebSocket URL 的 `v` 改成小数。

### 1.1 实现基线（2026-07-12）

- Server 已实现 project/issue revision、canonical event、project-set snapshot、多项目 event pull、项目软删除恢复、离线 run delivery、ACK 后 delivered 状态、运行事件幂等和 v3 输出适配。
- Website 已切换单实体 upsert/tombstone reducer、`issue.assign`、`issue.run.request`、项目删除恢复及重连快照收敛。
- Desktop 已切换 cache schema 4、完整 binding set 恢复、cloud cache 精确替换、private 数据隔离、command receipt 和稳定 run identity；schema 4 同时保存 Project 组件目录、可空等级和完整 Issue 详情字段。
- 三仓使用同一组 `kanban-v3.1/contract-fixtures.json` 做 JSON golden fixture 验证。
- 本文继续保留 `Current v3` 与 `Target v3.1` 标签，用于解释兼容输出，不再表示 v3.1 尚未编码。

## 2. 权威边界与基本原则

### 2.1 数据权威

| 数据 | 权威来源 | Desktop 离线时 |
|---|---|---|
| 云端 Project、Issue、Workflow | Kanban Server | Website 继续正常增删改查 |
| 云端 Issue 的 stage/status/worker | Kanban Server | Website 继续修改并产生事件 |
| 云端 run、chatId、runId | Kanban Server，Desktop 通过运行事件报告 | 命令可以等待 Desktop，云端看板不阻塞 |
| Desktop 云端缓存 | Server 快照和事件流 | 保留最后一次已同步状态，重连后重建 |
| Desktop 纯本地任务 | Desktop SQLite | 正常本地使用，永不上行 |

Desktop 不应成为云端 CRUD 的同步前置条件。用户关闭电脑后，Website 必须仍能创建、修改、删除 Issue，修改流程状态、分配 worker，以及管理 Project。

### 2.2 三条独立通道

```text
云端状态复制：snapshot.get + event.pull + issue/project push + revision
定向命令投递：sync.deliver + deliverySeq + sync.ack
运行结果报告：run.event.append + clientEventId
```

禁止用 `event_delivery` 复制普通 Issue 看板变化。普通看板变化进入全局事件流；`event_delivery` 仅保存发给特定 Desktop 的可靠命令和 `snapshot_reset` 控制消息。

### 2.3 一致性目标

- 云端实体采用 Server-authoritative、last-write-by-valid-revision。
- 所有云端写请求都进行实体 revision 冲突检查。
- Desktop 重连完成后，其 cloud-owned 缓存必须等于快照及后续事件所描述的 Server 状态。
- Desktop 的 private-owned 数据不参与云端 revision，也不受云快照删除集合影响。
- WebSocket `open` 仅表示传输已建立；完成快照和追赶事件后才进入 `ready`。

## 3. 传输、鉴权与公共 Envelope

### 3.1 WebSocket 地址

```text
wss://<host>/ws?role=web&v=3&token=<jwt>
wss://<host>/ws?role=desktop&v=3&token=<jwt>
```

- `role` 只能是 `web` 或 `desktop`。
- `v` 当前固定为 `3`。
- `token` 是 official server 签发并由 Kanban Server 验证的 JWT。
- 生产环境必须使用 `wss`。

### 3.2 Request

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.update",
  "id": "req-01J2Z5F8N0Q6Q2N1C1R9QFW4H7",
  "role": "web",
  "projectId": "project-1",
  "payload": {}
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | number | 是 | Wire protocol，固定为 `3` |
| `frame` | string | 是 | Request 固定为 `request` |
| `type` | string | 是 | 业务接口名 |
| `id` | string | 是 | 请求关联 ID；Target v3.1 写请求同时将其作为幂等键 |
| `role` | string | 是 | `web` 或 `desktop` |
| `projectId` | string | 按接口 | 单项目请求的作用域 |
| `payload` | object | 是 | 业务参数 |

### 3.3 Success response

```json
{
  "v": 3,
  "frame": "response",
  "type": "issue.update",
  "id": "req-01J2Z5F8N0Q6Q2N1C1R9QFW4H7",
  "role": "server",
  "projectId": "project-1",
  "revision": 501,
  "ok": true,
  "payload": {
    "ok": true,
    "message": "issue 已更新。",
    "revision": 501,
    "issue": {}
  }
}
```

Response 的 `type` 和 `id` 必须与 Request 相同。`revision` 是本次成功写入产生的全局事件 revision；只读请求可以返回当前 Server revision。

### 3.4 Error response

```json
{
  "v": 3,
  "frame": "response",
  "type": "issue.update",
  "id": "req-01J2Z5F8N0Q6Q2N1C1R9QFW4H7",
  "role": "server",
  "projectId": "project-1",
  "ok": false,
  "error": {
    "code": "conflict",
    "message": "任务已被其他端更新，请刷新后重试。",
    "retryable": false,
    "details": {
      "currentRevision": 500,
      "currentIssue": {}
    }
  }
}
```

标准错误码：

| Code | 可重试 | 说明 |
|---|---|---|
| `bad_payload` | 否 | 字段缺失、类型错误或业务组合非法 |
| `unauthorized` | 刷新凭证后 | JWT 无效或过期 |
| `forbidden` | 否 | 无项目或操作权限 |
| `not_found` | 否 | 实体不存在或已删除 |
| `conflict` | 重新读取后 | `base*Revision` 与实体当前 revision 不一致 |
| `cursor_expired` | 通过快照 | 增量事件已被压缩，cursor 不再可用 |
| `snapshot_required` | 通过快照 | 缓存 schema 或权限范围改变 |
| `device_unavailable` | 视接口而定 | 没有符合条件的 Desktop 设备 |
| `unsupported_message` | 否 | 当前 contract 不支持该业务类型 |
| `server_error` | 是 | Server 内部错误 |

### 3.5 Push

```json
{
  "v": 3,
  "frame": "push",
  "type": "issue.updated",
  "role": "server",
  "projectId": "project-1",
  "revision": 501,
  "ok": true,
  "payload": {}
}
```

Push 没有 Request `id`。客户端必须按 `payload.seq` 或 Envelope `revision` 去重，不能依赖到达次数。

### 3.6 HTTP RPC fallback

Website 在 WebSocket 不可用时可以调用：

```http
POST /api/rpc
Authorization: Bearer <jwt>
Content-Type: application/json
```

Body 使用与 WebSocket Request 完全相同的 Envelope，响应使用相同的 Response Envelope。HTTP fallback 只替换传输，不改变业务 JSON 和幂等语义。

### 3.7 通用字段规则

- 时间字段使用 UTC ISO-8601，例如 `2026-07-11T10:00:00Z`。
- ID 是不透明字符串，客户端不得解析其格式。
- Update 中字段缺失表示“不修改”，显式 `null` 表示“清空”。
- 数组型 whole-replacement 字段必须明确记录，例如 Project 的 `versions`、`components` 以及 Issue 的 `componentKeys`、`labelIds`、`dependencies`；传空数组表示清空。
- Target v3.1 Server 对成功的 mutating Request 持久化 `id` 和结果；重复请求返回原结果，不生成第二个 revision。
- Current v3 的 Request `id` 主要用于 RPC 关联，不保证所有写接口都已实现持久幂等。

## 4. 公共 DTO

### 4.1 Issue

下例包含对接所需的完整核心字段。可选业务字段允许扩展，但已定义字段不得改变含义。

```json
{
  "id": "issue-1",
  "projectId": "project-1",
  "parentIssueId": null,
  "projectPath": "default/project-1",
  "projectName": "Desktop",
  "projectVersion": "1.4.0",
  "issueTypeKey": "task",
  "workflowId": "workflow-standard-task",
  "stageId": "stage-development",
  "stageKey": "development",
  "stageName": "开发",
  "statusId": "status-in-progress",
  "statusKey": "in_progress",
  "statusName": "进行中",
  "columnKey": "in_progress",
  "status": "in_progress",
  "title": "实现 Desktop 离线恢复",
  "description": "Desktop 重新上线后恢复云端状态。",
  "dueDate": "2026-07-18",
  "dueRisk": "high",
  "resolution": null,
  "securityLevelKey": "internal",
  "reporterId": "user-2",
  "componentKeys": ["desktop-shell", "sync"],
  "originalEstimate": 28800,
  "remainingEstimate": 14400,
  "timeSpent": 7200,
  "priority": "high",
  "severity": "medium",
  "position": 120.5,
  "assigneeAgentKey": "codeAssistant",
  "assigneeId": "user-1",
  "workerType": "agent",
  "workerId": null,
  "workerAgent": "codeAssistant",
  "activeReviewId": null,
  "dispatchState": "waiting_for_device",
  "dispatchCommandId": "cmd-1",
  "dispatchDeviceId": "device-1",
  "runState": null,
  "runAgentKey": null,
  "chatId": null,
  "runId": null,
  "runStartedAt": null,
  "runFinishedAt": null,
  "runResultMessage": null,
  "runErrorMessage": null,
  "automationId": null,
  "automationEnabled": false,
  "automationCron": null,
  "automationMessage": null,
  "automationTimezone": null,
  "attachmentChatId": null,
  "attachments": [],
  "customFields": {},
  "revision": 500,
  "createdAt": "2026-07-10T09:00:00Z",
  "updatedAt": "2026-07-11T10:00:00Z",
  "deletedAt": null,
  "createdBy": "user-1",
  "updatedBy": "user-1",
  "createdByAgent": null,
  "updatedByAgent": null
}
```

枚举：

- `status` / `columnKey`：`backlog`、`todo`、`in_progress`、`in_review`、`completed`。
- `priority`：wire 使用 `urgent`、`high`、`medium`、`low` 或 `null`。Desktop 在缓存边界映射为 `P0`、`P1`、`P2`、`P3`，Desktop Action 同时接受两组输入，但输出保持 P0–P3 兼容现有调用方。
- `severity`：`critical`、`high`、`medium`、`low` 或 `null`。`priority` 与 `severity` 缺失时均保持空值，不补默认等级。
- `dueDate`：严格的 `YYYY-MM-DD` 日历日期；缺失或 `null` 表示未设置。不得转换成时间点或受时区偏移影响。旧 `dueTime`、`dueAt` 仅供 Desktop 迁移读取，新实体不再写入旧键。
- `dueRisk`：Server 计算的只读值。Desktop 不允许动作写入，也不为 private Issue 复制 Server 风险算法。
- `projectVersion`：可选字符串；缺失、`null` 或空字符串表示未设置。非空值必须存在于所属 Project 的 `versions` 目录。旧 `version` 只作为 Desktop Action 与存量缓存的兼容读取来源。
- `componentKeys`：所属 Project `components` 目录中的字符串数组，whole-replacement；空数组表示清空。
- `originalEstimate`、`remainingEstimate`、`timeSpent`：可选非负整数秒；UI 可以小时输入，但协议和缓存统一使用秒。
- `resolution`、`securityLevelKey`、`reporterId`：可选字符串；`securityLevelKey` 在 Desktop 原生 UI 中只读。
- `workerType`：`human`、`agent`、`null`。
- `dispatchState`：`null`、`waiting_for_device`、`delivered`、`accepted`、`cancelled`、`expired`。
- `runState`：`null`、`running`、`completed`、`failed`、`cancelled`。

`dispatchState` 和相关 dispatch 字段属于 Target v3.1。Current v3 主要通过 `event_delivery` 表达排队状态，Issue JSON 尚未完整投影这些字段。

Desktop 卡片展示的工作流进度不是 Issue wire 字段。Renderer 只读消费 `workflowStages` 的顺序、当前 `stageId/stageKey`，以及该 Stage 下 `workflowStatuses` 的顺序与当前 `statusId/statusKey/columnKey` 来推导大致进度；3px 进度轨优先使用 Workflow Stage 目录中的 `color`，缺失时使用稳定语义色板，不携带历史阶段分段，也不向 Server 回写百分比或颜色。目录缺失或引用无法匹配时必须使用中性降级，不得猜测或产生 mutation。

### 4.2 Project

```json
{
  "id": "project-1",
  "parentId": "default",
  "slug": "desktop",
  "key": "DESKTOP",
  "name": "Desktop",
  "description": "ZenMind Desktop",
  "versions": ["1.3.0", "1.4.0"],
  "components": ["desktop-shell", "sync"],
  "path": "default/desktop",
  "depth": 1,
  "position": 10.0,
  "visibility": "workspace",
  "defaultWorkflowId": "workflow-standard-task",
  "revision": 210,
  "archivedAt": null,
  "deletedAt": null,
  "createdAt": "2026-07-01T08:00:00Z",
  "updatedAt": "2026-07-11T10:00:00Z",
  "createdBy": "user-1",
  "updatedBy": "user-1"
}
```

`Project.versions` 与 `Project.components` 是该 Project 可供 Issue 选择的版本和组件目录，保序、去空、去重；删除仍被 Issue 使用的目录项必须失败。默认 Project 的名称和结构仍不可修改，但允许单独维护两个目录。`Project.revision` 属于 Target v3.1，用于项目更新、移动、删除和恢复的实体级冲突检查。

### 4.3 Desktop cursor

```json
{
  "deviceId": "device-1",
  "lastAckedDeliverySeq": 12,
  "lastAppliedRevision": 500,
  "cacheSchemaVersion": 4,
  "updatedAt": "2026-07-11T10:00:00Z"
}
```

- `lastAppliedRevision`：Desktop cloud cache 已应用的全局事件高水位。
- `lastAckedDeliverySeq`：该设备已经可靠接收的连续命令高水位。
- 两个序号互相独立，不能互相替代。

## 5. Desktop 建连、快照与断线恢复

### 5.1 状态机

```text
disabled → connecting → open → syncing_snapshot → catching_up → ready
                              ↘ error / closed ↗
```

UI 只有在 `ready` 时才能显示“云端已同步”。`open` 但未 `ready` 时可以显示本地缓存，同时明确标记正在同步。

### 5.2 `sync.hello`

角色：Desktop → Server。

Request：

```json
{
  "v": 3,
  "frame": "request",
  "type": "sync.hello",
  "id": "hello-device-1-20260711T100000Z",
  "role": "desktop",
  "projectId": "default",
  "payload": {
    "contractVersion": "3.1",
    "deviceId": "device-1",
    "ownerUserId": "user-1",
    "deviceName": "Linlay MacBook Pro",
    "deviceAlias": "工作电脑",
    "hostname": "linlay-mbp",
    "username": "linlay",
    "selectedProjectId": "project-1",
    "lastAckedDeliverySeq": 12,
    "lastAppliedRevision": 480,
    "cacheSchemaVersion": 1,
    "localProjects": [
      {
        "projectId": "project-1",
        "localProjectId": "local-project-desktop",
        "localDisplayName": "Desktop Workspace",
        "controlMode": "execute"
      }
    ],
    "capabilities": [
      "command.runIssue",
      "run.event.append"
    ],
    "agents": [
      {
        "agentKey": "codeAssistant",
        "displayName": "代码助手",
        "role": "developer"
      }
    ]
  }
}
```

Success payload：

```json
{
  "ok": true,
  "message": "desktop 已连接。",
  "contractVersion": "3.1",
  "sessionId": "session-1",
  "serverRevision": 500,
  "mode": "snapshot_then_incremental",
  "snapshotRequired": true,
  "snapshotProjectIds": ["project-1"],
  "nextDeliverySeq": 13,
  "batchSize": 100,
  "device": {
    "deviceId": "device-1",
    "ownerUserId": "user-1",
    "deviceName": "Linlay MacBook Pro",
    "status": "active"
  },
  "links": [],
  "accessibleProjects": [],
  "cursor": {
    "deviceId": "device-1",
    "lastAckedDeliverySeq": 12,
    "lastAppliedRevision": 480,
    "cacheSchemaVersion": 1,
    "updatedAt": "2026-07-11T10:00:00Z"
  }
}
```

规则：

- Server 以 `deviceId` 识别稳定设备，而不是以短期 WebSocket session 识别。
- 同一 `deviceId` 新会话建立后，旧会话应被关闭。
- 未绑定的纯本地项目不得出现在 `localProjects`。
- Compatibility：从旧 Desktop 升级且已显式启用远程控制、但本地尚无 binding 记录时，Desktop 可一次性把旧版默认项目映射迁移为显式 binding metadata；迁移仍不得携带任何本地 Issue 或附件内容。
- Current v3 已支持大部分字段；`contractVersion`、`snapshotRequired`、`snapshotProjectIds` 和明确的 `snapshot_then_incremental` 属于 Target v3.1。

### 5.3 `snapshot.get`

角色：Web 或 Desktop → Server。

Target v3.1 Desktop Request：

```json
{
  "v": 3,
  "frame": "request",
  "type": "snapshot.get",
  "id": "snapshot-device-1-1",
  "role": "desktop",
  "projectId": "default",
  "payload": {
    "deviceId": "device-1",
    "projectIds": ["project-1", "project-2"],
    "include": ["projects", "issues", "workflowCatalog"]
  }
}
```

Success payload：

```json
{
  "ok": true,
  "message": "看板快照已加载。",
  "snapshotId": "snapshot-500-device-1",
  "scope": "project_set",
  "complete": true,
  "projectIds": ["project-1", "project-2"],
  "revision": 500,
  "lastSeq": 500,
  "projects": [],
  "issues": [],
  "workflowCatalog": {
    "issueTypes": [],
    "workflows": [],
    "workflowStages": [],
    "workflowStatuses": [],
    "workflowTransitions": []
  },
  "serverTime": "2026-07-11T10:00:00Z"
}
```

应用规则：

1. 在一个本地数据库事务中 upsert `projects`、`issues` 和 workflow catalog。
2. 对 `projectIds` 范围内 `syncMode=cloud` 且未出现在完整快照中的记录写 tombstone。
3. 不删除 `syncMode=private` 的 Issue。
4. 事务成功后同时写入 `lastAppliedRevision=lastSeq`。
5. 事务失败不得推进 cursor。

Current v3 的 `snapshot.get` 是单个 `projectId` 作用域，返回 `scope: "project"`。Target v3.1 增加 project set 快照；v3.1 Server 仍需接受单项目请求。

### 5.4 `event.pull`

角色：Desktop → Server。

Request：

```json
{
  "v": 3,
  "frame": "request",
  "type": "event.pull",
  "id": "event-pull-device-1-501",
  "role": "desktop",
  "projectId": "default",
  "payload": {
    "projectIds": ["project-1", "project-2"],
    "afterSeq": 500,
    "limit": 100
  }
}
```

Success payload：

```json
{
  "ok": true,
  "projectIds": ["project-1", "project-2"],
  "afterSeq": 500,
  "lastSeq": 540,
  "nextAfterSeq": 523,
  "hasMore": true,
  "events": []
}
```

规则：

- `seq` 来自全局事件流，允许因其他 aggregate 或无权项目产生间隙，客户端不能要求 `seq == previous + 1`。
- 返回事件必须按 `seq ASC` 排序。
- 客户端只在事件成功落库后推进 `lastAppliedRevision`。
- 当 `hasMore=false` 时，可以把 cursor 推进到 `lastSeq`，前提是 Server 保证所请求项目范围内没有遗漏的可见事件。
- Event retention 已无法覆盖 `afterSeq` 时返回 `cursor_expired`，客户端重新执行完整快照。

### 5.5 建连期间的实时 Push

从 WebSocket `open` 到事件追赶完成期间，Desktop 必须暂存 push：

1. 先应用快照。
2. 再执行 `event.pull`。
3. 对暂存 push 按 `seq ASC` 排序。
4. `seq <= lastAppliedRevision` 的重复事件直接忽略。
5. 最后进入 `ready`。

### 5.6 `sync.pull`

角色：Desktop → Server。仅拉取定向命令和控制消息。

```json
{
  "v": 3,
  "frame": "request",
  "type": "sync.pull",
  "id": "delivery-pull-device-1-13",
  "role": "desktop",
  "projectId": "default",
  "payload": {
    "deviceId": "device-1",
    "afterDeliverySeq": 12,
    "limit": 100
  }
}
```

```json
{
  "ok": true,
  "items": [],
  "hasMore": false,
  "serverRevision": 540,
  "nextDeliverySeq": 13
}
```

### 5.7 `sync.ack`

角色：Desktop → Server。

```json
{
  "v": 3,
  "frame": "request",
  "type": "sync.ack",
  "id": "delivery-ack-device-1-13",
  "role": "desktop",
  "projectId": "default",
  "payload": {
    "deviceId": "device-1",
    "ackedDeliverySeq": 13,
    "lastAppliedRevision": 540
  }
}
```

```json
{
  "ok": true,
  "cursor": {
    "deviceId": "device-1",
    "lastAckedDeliverySeq": 13,
    "lastAppliedRevision": 540,
    "cacheSchemaVersion": 1,
    "updatedAt": "2026-07-11T10:02:00Z"
  }
}
```

- ACK 只能连续推进。Server 不得接受跳过未存在或未处理 delivery 的 ACK。
- Target v3.1 中 ACK 表示 Desktop 已把 command receipt 可靠写入本地数据库，不表示 Agent 已完成。

## 6. Issue 写接口

### 6.1 通用成功结果

```json
{
  "ok": true,
  "message": "issue 已更新。",
  "projectId": "project-1",
  "revision": 501,
  "issue": {},
  "deletedIssueId": null
}
```

- Target v3.1 客户端使用 `issue` 或 `deletedIssueId`。
- `issues` 是 Current v3 全量列表兼容字段，标记为 deprecated；v3.1 Server 在兼容期可以继续返回。

### 6.2 `issue.create`

角色：Web → Server。Desktop role 不允许调用云端 Issue CRUD。

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.create",
  "id": "create-issue-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "input": {
      "projectId": "project-1",
      "title": "实现快照恢复",
      "projectVersion": "1.4.0",
      "description": "支持 Desktop 离线后恢复。",
      "issueTypeKey": "task",
      "workflowId": "workflow-standard-task",
      "dueDate": "2026-07-18",
      "resolution": null,
      "securityLevelKey": "internal",
      "reporterId": "user-2",
      "componentKeys": ["sync"],
      "originalEstimate": 28800,
      "remainingEstimate": 28800,
      "timeSpent": 0,
      "priority": "high",
      "severity": "medium",
      "assigneeId": "user-1",
      "workerType": "agent",
      "workerAgent": "codeAssistant",
      "attachments": [],
      "customFields": {}
    }
  }
}
```

Server 决定初始 stage/status/position，并返回完整 Issue 和新 revision。

### 6.3 `issue.update`

Target v3.1 用于内容和非流程字段更新。stage/status/position 使用 `issue.move`，worker 使用 `issue.assign`。

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.update",
  "id": "update-issue-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "issue-1",
    "baseIssueRevision": 500,
    "input": {
      "title": "实现完整快照恢复",
      "projectVersion": null,
      "description": "更新后的说明。",
      "dueDate": "2026-07-20",
      "resolution": "fixed",
      "reporterId": "user-2",
      "componentKeys": ["desktop-shell", "sync"],
      "originalEstimate": 28800,
      "remainingEstimate": 7200,
      "timeSpent": 21600,
      "priority": "high",
      "severity": "high",
      "attachments": [],
      "labelIds": ["label-sync"],
      "dependencies": [
        {
          "issueId": "issue-2",
          "type": "blocks"
        }
      ]
    }
  }
}
```

Compatibility：Current v3 的 `issue.update.input` 仍允许 stage/status/assignee/worker 字段。v3.1 Server 在迁移期可以接受，但必须归一化为相同的实体校验和 `issue.updated` 事件。

### 6.4 `issue.move`

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.move",
  "id": "move-issue-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "issue-1",
    "baseIssueRevision": 501,
    "stageId": "stage-development",
    "statusId": "status-in-progress",
    "position": 120.5,
    "comment": {
      "body": "开始开发。"
    }
  }
}
```

Server 必须：

- 校验 stage/status 属于 Issue 的 workflow。
- 由 `statusId` 推导 `statusKey`、`statusName`、`columnKey` 和兼容 `status`。
- 由 `stageId` 推导 `stageKey`、`stageName`。
- 拒绝客户端提交的互相矛盾组合。
- Issue 正处于不可中断的 `running` 状态时，按 workflow 规则拒绝切换。
- 普通 update 不得绕过完成流转规则直接进入 completed。

### 6.5 `issue.assign`

Target v3.1 的显式分配接口。

分配 Agent worker：

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.assign",
  "id": "assign-issue-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "issue-1",
    "baseIssueRevision": 502,
    "assigneeId": "user-1",
    "worker": {
      "type": "agent",
      "agentKey": "codeAssistant"
    }
  }
}
```

分配 Human worker：

```json
{
  "id": "issue-1",
  "baseIssueRevision": 503,
  "assigneeId": "user-2",
  "worker": {
    "type": "human",
    "userId": "user-2"
  }
}
```

清空 worker：

```json
{
  "id": "issue-1",
  "baseIssueRevision": 504,
  "worker": null
}
```

规则：

- 分配只修改云端 Issue，不依赖 Desktop 在线。
- Agent worker 的 `agentKey` 表示执行能力，不等同于某台设备。
- 选择执行设备属于后续 `issue.run.request`。
- Target v3.1 的 `issue.claim` 是“当前登录用户认领未分配 Issue”的兼容别名：Server 忽略客户端提交的 assignee，使用 JWT actor，并在 Issue 已有 assignee 时返回 `already_claimed`。
- 只有当前 assignee 可以通过 `issue.assign` 指定或清空 worker；可选 Agent worker 来自该用户当前在线 Desktop 会话上报的 Agent 列表。分配 worker 不自动启动执行。
- Current v3 的 `issue.claim` 仍按旧兼容语义映射到 `issue.assign`。
- Current v3 的 `issue.claimed` 下行事件必须在 v3.1 统一为 `issue.updated` 且 `reason="assigned"`。

### 6.6 `issue.delete`

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.delete",
  "id": "delete-issue-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "issue-1",
    "baseIssueRevision": 505
  }
}
```

Success payload：

```json
{
  "ok": true,
  "message": "issue 已删除。",
  "projectId": "project-1",
  "revision": 506,
  "deletedIssueId": "issue-1"
}
```

删除采用 soft delete，并产生可重放 tombstone。

### 6.7 Conflict

```json
{
  "v": 3,
  "frame": "response",
  "type": "issue.move",
  "id": "move-issue-client-uuid-1",
  "role": "server",
  "projectId": "project-1",
  "revision": 510,
  "ok": false,
  "error": {
    "code": "conflict",
    "message": "任务已被其他端更新，请刷新后重试。",
    "retryable": false,
    "details": {
      "baseIssueRevision": 505,
      "currentIssueRevision": 509,
      "currentIssue": {}
    }
  }
}
```

客户端必须用 `currentIssue` 覆盖对应云实体，重新让用户确认，不得自动把旧输入覆盖到新 revision。

## 7. Issue 下行事件

### 7.1 事件集合

Target v3.1 对普通 Issue 状态复制只使用：

- `issue.created`
- `issue.updated`
- `issue.deleted`

`assigned`、`claimed`、`moved`、`run_requested`、`run_delivered`、`run_started` 等是 `reason`，不是需要每个消费者单独维护的新 event type。`run_delivered` 表示 Desktop 已可靠 ACK command receipt，仍不等同于 Agent 已开始运行。

### 7.2 Created / Updated

```json
{
  "v": 3,
  "frame": "push",
  "type": "issue.updated",
  "role": "server",
  "projectId": "project-1",
  "revision": 511,
  "ok": true,
  "payload": {
    "seq": 511,
    "eventId": "event-511",
    "eventType": "issue.updated",
    "aggregateType": "issue",
    "projectId": "project-1",
    "issueId": "issue-1",
    "reason": "assigned",
    "issue": {},
    "actor": {
      "type": "user",
      "id": "user-1"
    },
    "createdAt": "2026-07-11T10:01:00Z"
  }
}
```

消费者按 `issue.id` upsert 完整实体。Website 和 Desktop 使用完全相同的 payload shape。

### 7.3 Deleted tombstone

```json
{
  "v": 3,
  "frame": "push",
  "type": "issue.deleted",
  "role": "server",
  "projectId": "project-1",
  "revision": 512,
  "ok": true,
  "payload": {
    "seq": 512,
    "eventId": "event-512",
    "eventType": "issue.deleted",
    "aggregateType": "issue",
    "projectId": "project-1",
    "issueId": "issue-1",
    "deletedIssueId": "issue-1",
    "deletedAt": "2026-07-11T10:02:00Z",
    "actor": {
      "type": "user",
      "id": "user-1"
    },
    "createdAt": "2026-07-11T10:02:00Z"
  }
}
```

Desktop 只 tombstone 对应的 cloud-owned Issue；相同本地 ID 不应存在，remote/local ID 必须通过映射表隔离。

### 7.4 跨项目移动

```json
{
  "seq": 513,
  "eventType": "issue.updated",
  "projectId": "project-2",
  "issueId": "issue-1",
  "reason": "project_changed",
  "fromProjectId": "project-1",
  "toProjectId": "project-2",
  "issue": {}
}
```

Server 必须把同一事件发送给订阅旧项目或新项目的会话。客户端处理顺序：

1. 从 `fromProjectId` 的集合移除旧实体。
2. 如果有权且订阅 `toProjectId`，upsert `issue`。
3. 推进到同一个 `seq`，不生成两次逻辑变更。

## 8. Project 写接口与事件

### 8.1 `project.create`

```json
{
  "v": 3,
  "frame": "request",
  "type": "project.create",
  "id": "create-project-client-uuid-1",
  "role": "web",
  "projectId": "default",
  "payload": {
    "parentId": "default",
    "name": "Desktop",
    "slug": "desktop",
    "description": "ZenMind Desktop",
    "versions": ["1.3.0", "1.4.0"],
    "components": ["desktop-shell", "sync"],
    "visibility": "workspace",
    "defaultWorkflowId": "workflow-standard-task",
    "position": 10.0
  }
}
```

### 8.2 `project.update`

```json
{
  "v": 3,
  "frame": "request",
  "type": "project.update",
  "id": "update-project-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "project-1",
    "baseProjectRevision": 210,
    "input": {
      "name": "Desktop Client",
      "description": "Desktop 客户端项目",
      "versions": ["1.4.0", "2.0.0"],
      "components": ["desktop-shell", "runtime"]
    }
  }
}
```

### 8.3 `project.move`

```json
{
  "v": 3,
  "frame": "request",
  "type": "project.move",
  "id": "move-project-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "project-1",
    "baseProjectRevision": 211,
    "parentId": "project-platform",
    "position": 30.0
  }
}
```

Server 原子更新项目 closure、path、depth、position 和 revision。

### 8.4 `project.delete`

Target v3.1 的公开删除固定为软删除子树，不提供公开 hard delete。

```json
{
  "v": 3,
  "frame": "request",
  "type": "project.delete",
  "id": "delete-project-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "project-1",
    "baseProjectRevision": 212,
    "mode": "archive_subtree"
  }
}
```

规则：

- 项目子树写入 `deletedAt` 或等价归档状态。
- 云端 Issue 和审计事件保留，但不再出现在 active snapshot。
- Desktop 删除该子树的 cloud cache，保留所有 private project/issue。
- 默认项目不能删除。

### 8.5 `project.restore`

```json
{
  "v": 3,
  "frame": "request",
  "type": "project.restore",
  "id": "restore-project-client-uuid-1",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "id": "project-1",
    "baseProjectRevision": 213,
    "recursive": true
  }
}
```

### 8.6 Project 事件

Target v3.1：

- `project.created`
- `project.updated`
- `project.deleted`
- `project.restored`

created/updated/restored 携带完整 Project；deleted 携带 tombstone。

```json
{
  "seq": 520,
  "eventType": "project.deleted",
  "aggregateType": "project",
  "projectId": "project-1",
  "deletedProjectId": "project-1",
  "deletedProjectIds": ["project-1", "project-child-1"],
  "deletedAt": "2026-07-11T10:10:00Z",
  "reason": "archive_subtree"
}
```

Current v3 的 project create/update/move 成功后广播完整 `snapshot.updated`，没有 project delete/restore。v3.1 兼容期可以同时保留完整快照广播，但增量消费者以 project event 为准。

### 8.7 权限撤销

权限撤销不是普通项目删除。Server 给受影响设备创建定向控制消息：

```json
{
  "deliverySeq": 14,
  "deviceId": "device-1",
  "projectId": "project-1",
  "kind": "snapshot_reset",
  "sourceRevision": 521,
  "eventType": "project.accessRevoked",
  "payload": {
    "projectId": "project-1",
    "reason": "permission_revoked"
  },
  "status": "pending"
}
```

Desktop 必须清除该权限范围内的 cloud cache，然后重新请求仍有权项目的快照。不得把无权数据继续展示为离线缓存。

## 9. 离线 Desktop worker 与可靠命令

### 9.1 分配与运行分离

- `issue.assign` 修改 assignee/worker，Desktop 离线也成功。
- `issue.run.request` 才创建运行命令。
- 已注册、有 execute binding 且权限有效的离线设备可以成为命令目标。
- 找不到任何已注册目标时返回 `device_unavailable`，但不回滚此前已经成功的 worker 分配。

### 9.2 `issue.run.request`

Target v3.1，角色 Web → Server。

```json
{
  "v": 3,
  "frame": "request",
  "type": "issue.run.request",
  "id": "run-request-issue-1-device-1-rev-530",
  "role": "web",
  "projectId": "project-1",
  "payload": {
    "issueId": "issue-1",
    "baseIssueRevision": 530,
    "targetDeviceId": "device-1",
    "agentKey": "codeAssistant",
    "accessLevel": "auto_approve",
    "message": "请处理该任务。"
  }
}
```

Success payload：

```json
{
  "ok": true,
  "message": "任务已加入 Desktop 可靠派发队列。",
  "projectId": "project-1",
  "revision": 531,
  "issue": {
    "id": "issue-1",
    "dispatchState": "waiting_for_device",
    "dispatchCommandId": "run-request-issue-1-device-1-rev-530"
  },
  "delivery": {
    "commandId": "run-request-issue-1-device-1-rev-530",
    "deviceId": "device-1",
    "deliverySeq": 15,
    "status": "pending"
  }
}
```

Request `id` 作为 `commandId`，保证 Website 重试不会创建两条命令。

### 9.3 `sync.deliver`

Desktop 在线时 Server push；离线时保存在 `event_delivery`，重连后通过 `sync.pull` 返回。

```json
{
  "v": 3,
  "frame": "push",
  "type": "sync.deliver",
  "role": "server",
  "projectId": "project-1",
  "ok": true,
  "payload": {
    "items": [
      {
        "deliveryId": 10015,
        "deviceId": "device-1",
        "deliverySeq": 15,
        "projectId": "project-1",
        "localProjectId": "local-project-desktop",
        "kind": "command",
        "sourceRevision": 531,
        "commandId": "run-request-issue-1-device-1-rev-530",
        "eventType": "command.runIssue",
        "payload": {
          "issueId": "issue-1",
          "issue": {},
          "agentKey": "codeAssistant",
          "accessLevel": "auto_approve",
          "message": "请处理该任务。"
        },
        "status": "pending",
        "createdAt": "2026-07-11T10:20:00Z"
      }
    ]
  }
}
```

### 9.4 Desktop command receipt

Target v3.1 Desktop 必须持久化以下等价状态：

```json
{
  "commandId": "run-request-issue-1-device-1-rev-530",
  "deliverySeq": 15,
  "eventType": "command.runIssue",
  "state": "received",
  "runId": null,
  "chatId": null,
  "receivedAt": "2026-07-11T10:21:00Z",
  "updatedAt": "2026-07-11T10:21:00Z"
}
```

可靠处理顺序：

1. 以 `commandId` 为唯一键写入 command receipt。
2. Receipt 已存在时不重复启动 Agent。
3. Receipt 事务成功后允许发送 `sync.ack`。
4. 本地 dispatcher 执行所有 `received` 且未完成的 receipt。
5. Agent 启动后写回同一 receipt 的 `runId/chatId/state=running`。
6. Desktop 崩溃恢复时从 receipt 恢复，而不是重新创建 run。

这使 `sync.deliver` 保持至少一次传输，同时实现业务层的 effectively-once 启动。

### 9.5 `run.event.append`

角色：Desktop → Server。

Started：

```json
{
  "v": 3,
  "frame": "request",
  "type": "run.event.append",
  "id": "run-event-command-15-started",
  "role": "desktop",
  "projectId": "project-1",
  "payload": {
    "deviceId": "device-1",
    "clientEventId": "device-1:delivery:15:run.started",
    "sourceDeliverySeq": 15,
    "projectId": "project-1",
    "issueId": "issue-1",
    "runId": "run-1",
    "chatId": "chat-1",
    "eventType": "run.started",
    "payload": {
      "status": "running",
      "agentKey": "codeAssistant",
      "runId": "run-1",
      "chatId": "chat-1"
    }
  }
}
```

Completed：

```json
{
  "deviceId": "device-1",
  "clientEventId": "device-1:run:run-1:completed",
  "projectId": "project-1",
  "issueId": "issue-1",
  "runId": "run-1",
  "chatId": "chat-1",
  "eventType": "run.completed",
  "payload": {
    "status": "completed",
    "runState": "completed",
    "message": "任务已完成。"
  }
}
```

Failed / Cancelled 使用相同结构，`eventType` 分别为 `run.failed`、`run.cancelled`。

Success payload：

```json
{
  "ok": true,
  "duplicate": false,
  "revision": 532,
  "message": "run event accepted"
}
```

重复 `clientEventId`：

```json
{
  "ok": true,
  "duplicate": true,
  "message": "duplicate client event ignored"
}
```

Server 接受运行事件后更新权威 Issue，并广播标准 `issue.updated`；消费者不直接用 `run.event.append` 的 Request 修改自己的看板状态。

## 10. Desktop 纯本地任务接口

### 10.1 网络边界

纯本地任务：

- `syncMode="private"`
- `syncState="local"`
- `remoteIssueId=null`
- `origin="desktop"`
- 有 `ownerUserId`
- 不生成任何 Kanban Server mutation、domain event 或 delivery

未显式绑定云端的本地 Project 不得进入 `sync.hello.localProjects`。显式绑定时只允许上传 binding metadata，不允许上传本地 Issue 内容。

### 10.2 `desktop.kanban.createIssue`

这是 Desktop action/IPC，不是云端 WebSocket 接口。

```json
{
  "action": "desktop.kanban.createIssue",
  "args": {
    "input": {
      "title": "纯本地任务",
      "projectId": "local-project-1",
      "description": "只保存在当前电脑。",
      "status": "todo",
      "projectVersion": "1.4.0",
      "dueDate": "2026-07-18",
      "resolution": null,
      "reporterId": "user-1",
      "componentKeys": ["desktop-shell"],
      "originalEstimate": 14400,
      "remainingEstimate": 14400,
      "timeSpent": 0,
      "priority": "P2",
      "severity": "medium",
      "assigneeAgentKey": "codeAssistant",
      "syncToCloud": false
    }
  }
}
```

`syncToCloud` 缺失或为 `false` 时创建 private Issue。Current v3 中设置为 `true` 会被拒绝，因为 Desktop cloud issue 是只读缓存。

Desktop Action 的 `priority` 同时接受 P0–P3 与 `urgent/high/medium/low`，返回值保持 P0–P3；`version` 仍可作为 `projectVersion` 的旧输入别名。`dueRisk` 不可写，`securityLevelKey` 可由动作设置但在 Desktop 原生 UI 中只读。

### 10.3 `desktop.kanban.updateIssue`

```json
{
  "action": "desktop.kanban.updateIssue",
  "args": {
    "id": "local_issue_1",
    "input": {
      "title": "更新后的本地任务",
      "projectVersion": null,
      "dueDate": null,
      "componentKeys": [],
      "priority": "P1",
      "syncToCloud": false
    }
  }
}
```

只能更新 private Issue。更新 cloud Issue 返回只读错误。

### 10.4 `desktop.kanban.moveIssue`

```json
{
  "action": "desktop.kanban.moveIssue",
  "args": {
    "id": "local_issue_1",
    "status": "in_progress",
    "position": 10.5
  }
}
```

### 10.5 `desktop.kanban.deleteIssue`

```json
{
  "action": "desktop.kanban.deleteIssue",
  "args": {
    "id": "local_issue_1"
  }
}
```

### 10.6 隐私清单

纯本地且未绑定的任务，网络中禁止出现：

- title、description、customFields
- attachments 正文、URL、本地路径
- chat 内容、automation message
- 本地 Project 显示名和目录路径

显式建立 cloud/local project binding 后，允许出现：

- `deviceId`
- cloud `projectId`
- 不透明 `localProjectId`
- 用户明确同意公开的 `localDisplayName`
- `controlMode`

## 11. v3 与 v3.1 兼容

### 11.1 能力差异

| 能力 | Current v3 | Target v3.1 |
|---|---|---|
| Desktop 初始快照 | 当前选中项目 | 全部已绑定项目的 project set 快照 |
| Issue create/update/delete | 已实现 | 保留并统一幂等、单实体结果 |
| Stage/status | update/move 均可修改 | 正式使用 `issue.move` |
| 认领与 Worker 分配 | `issue.claim`，实际事件可为 `issue.claimed` | `issue.claim` 仅供当前用户认领未分配 Issue；`issue.assign` 由 assignee 指定 worker；下行统一为 `issue.updated` |
| Website 实时事件 | 当前消费者期望全量 `issues`，与 Server 单实体事件不一致 | Website/Desktop 都消费同一实体事件 |
| Project create/update/move | 已实现，成功后广播完整快照 | 增量 Project 事件，并兼容完整快照 |
| Project delete/restore | 未实现 | 软删除、恢复和 tombstone |
| 普通 Issue 事件恢复 | snapshot + `event.pull` | 扩展到全部绑定项目并定义 cursor expiry |
| 离线命令队列 | `event_delivery` 和 ACK 已有 | 增加 Issue dispatch 投影和 Desktop receipt 幂等 |
| 纯本地任务 | 已实现 | 明确网络隐私和 binding 边界 |

### 11.2 Server 双协议阶段

Target v3.1 Server 在兼容期应：

- 继续接受 wire `v=3`。
- `contractVersion` 缺失时按 Current v3 返回单项目快照和兼容响应。
- 接受 `issue.claim`；缺少 `contractVersion` 时按 Current v3 转换为旧 `issue.assign`，v3.1 时只允许 JWT 当前用户认领尚未分配的 Issue。
- 不再产生 Desktop 无法识别的 `issue.claimed`；统一产生 `issue.updated`。
- 在兼容期保留 mutation payload 中 deprecated 的全量 `issues`。
- 单项目 `snapshot.get` 与 project set `snapshot.get` 同时可用。
- Project 增量事件上线初期可以同时广播完整 `snapshot.updated`。

### 11.3 推荐升级顺序

```text
1. Server 支持 v3/v3.1 双 contract 和统一事件 payload
2. Website 改为单实体 upsert/tombstone
3. Desktop 支持 project set snapshot、Project tombstone 和 receipt 幂等
4. 启用 project.delete/project.restore/issue.run.request
5. 观察兼容期后移除 deprecated 全量 issues 响应
```

## 12. 客户端应用规则

### 12.1 Website

- Mutation 发起方使用 Response 中的单实体立即更新。
- 其他浏览器使用相同的 push payload upsert/tombstone。
- 收到 `conflict` 时使用 `currentIssue/currentProject` 对齐，而不是回滚到操作前的旧对象。
- WebSocket 重连后重新请求当前 route 项目快照；如果 Website 后续持久化 cursor，再使用相同 `event.pull` 协议。

### 12.2 Desktop

- Cloud Issue 只接受 snapshot/event/run-report 回流更新，不调用云 CRUD。
- Private Issue 只通过本地 action/IPC 修改。
- 所有 snapshot/event/cursor 更新使用 SQLite 事务。
- `syncMode` 是删除边界：cloud 快照只能清理 cloud 行。
- `deliverySeq` 严格连续；发现空洞时停止处理并重新 `sync.pull`。
- 处理命令前先持久化 receipt；ACK 与 run 完成分离。

### 12.3 Server

- 实体更新与 `event_stream` 追加必须同事务。
- Push 只发送数据库中已经提交的事件。
- Mutating Request ID 必须持久幂等。
- 事件按权限和 Project scope 过滤。
- 跨项目事件覆盖 from/to 两个 scope。
- 权限撤销必须触发缓存清理控制消息。

## 13. 验收用例

### 13.1 Desktop 长时间离线

1. Desktop 完成 revision 500 后关机。
2. Website 创建、更新、移动、分配和删除 Issue，并增删改 Project。
3. Server revision 推进到 560，所有 Website 操作正常完成。
4. Desktop 重连，执行 `sync.hello → snapshot.get → event.pull → sync.pull`。
5. Desktop cloud cache 与 Server revision 560 一致，private Issue 完整保留。

### 13.2 版本冲突

1. 两个 Website 都读取 Issue revision 100。
2. A 更新成功，Issue 变为 revision 101。
3. B 使用 `baseIssueRevision=100` 更新。
4. Server 返回 `conflict` 和 revision 101 的完整 Issue，不产生 revision 102。

### 13.3 Worker 分配时 Desktop 离线

1. Website 调用 `issue.assign`，Desktop 离线。
2. 分配立即成功并广播 `issue.updated/reason=assigned`。
3. 如用户继续调用 `issue.run.request`，Server 创建 pending delivery。
4. Desktop 上线后领取并只启动一次。

### 13.4 ACK 前崩溃

1. Desktop 收到 `deliverySeq=15` 并写入 receipt。
2. 在 ACK 前进程崩溃。
3. 重连后 delivery 重新到达。
4. Desktop 命中已有 `commandId`，不创建第二个 Agent run，补发 ACK 并恢复 receipt。

### 13.5 项目删除

1. Desktop 离线时 Website 软删除 Project 子树。
2. Desktop 重连后移除该子树的 cloud Project/Issue 缓存。
3. 同一 Desktop 的 private Project/Issue 不被删除。
4. Project restore 后通过事件或快照重新出现。

### 13.6 跨项目移动

1. Issue 从 Project A 移动到 Project B。
2. 只订阅 A 的客户端移除 Issue。
3. 只订阅 B 的客户端新增 Issue。
4. 同时订阅 A/B 的客户端只应用一次 revision。

### 13.7 权限撤销

1. 用户在 Desktop 离线期间失去 Project 权限。
2. Server 创建 `project.accessRevoked` snapshot reset。
3. Desktop 重连后删除无权 cloud cache，不能继续离线展示。

### 13.8 本地任务隐私

1. 创建 private Issue，包含标题、正文、附件路径和 automation message。
2. 触发 Desktop 连接、快照、事件拉取和命令拉取。
3. 网络抓包中不出现任何 private Issue 内容。

## 14. 当前实现参考

Desktop：

- `src/main/kanban-desktop-ws-client.ts`
- `src/main/kanban-runtime.ts`
- `src/main/kanban-local-store.ts`
- `src/main/kanban-cloud-sync.ts`

Kanban Server：

- `internal/realtime/hub.go`
- `internal/realtime/sync_v3.go`
- `internal/realtime/protocol.go`
- `internal/store/sync_v3.go`
- `internal/store/schema.sql`

Website：

- `src/api/wsClient.ts`
- `src/hooks/useKanbanConnection.ts`
- `src/hooks/useKanbanActions.ts`
- `src/features/kanban/store.ts`

本文的 Target v3.1 部分是当前规范合同。实现代码与本文发生偏差时，应先判断代码是否处于 Current v3 兼容输出路径，还是协议实现遗漏；不得静默改变本文定义的权威边界和离线语义。
