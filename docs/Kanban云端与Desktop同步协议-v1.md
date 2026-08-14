# Kanban 云端与 Desktop 同步协议 V1

## 1. 范围与版本

Kanban 的首次发布合同为 Contract `1.0`，WebSocket URL 和 envelope 都使用整数 `v=1`。Server、Website 与 Desktop 不提供旧版本协商、字段别名或双读；任何非 V1 连接都必须被拒绝。

Desktop 将 Cloud Issue 内容和工作流状态视为 Server 权威只读缓存。允许的原子动作包括 `issue.claim`、`issue.run.prepare`、`issue.chat.bind/unbind` 与 `run.event.append`；Desktop 不调用 Website 的 `issue.run.request`，也不直接修改 Cloud Issue 正文或工作流。

## 2. Worker

Worker 按 `(issueId, stageId, workerRole)` 保存：

- `run`：执行节点 Worker。
- `review`：审查节点 Worker。

Worker 类型为 `human | agent`。Agent Worker 必须同时固定 `agentKey + deviceId`；Worker 不在不同 Stage 之间共享。

## 3. Chat

Chat 节点身份为 `(issueId, deviceId, stageId, statusId, agentKey)`。

- Stage 或 Status 任一变化，都不能复用上一节点 Chat。
- 返回完全相同的 Stage、Status、Agent 和 Desktop 时，Agent Run 默认复用该节点的首选 Chat。
- `forceNewChat=true`、Agent 改变或本机 Chat 丢失时，新建 Chat 并替换首选。
- 其他 Desktop 的 Chat 只用于历史展示，不能在本机打开或复用。
- Human Run 可以没有 Chat，也可以通过 `issue.chat.bind/unbind` 关联本机已有 Chat；这只产生 `human_reference`，不产生 Run。
- 每个 Agent Review attempt 强制新建 Chat，Review Chat 不进入首选复用池。

## 4. Run 与运行事件

每次 Agent 执行都创建新的 `issueRunId`，即使复用 Chat。Server 使用 `issueRunId + deviceId + externalRunId` 精确匹配 `run.event.append`；`chatId` 不能单独定位运行。

Desktop 收到 `command.runIssue` 时使用 Server 指定的 Stage、Status、Agent 与 Chat policy 启动运行；收到 `command.reviewIssue` 时必须使用全新 Chat。运行事件先写入本地可靠 outbox，断线或重启后使用稳定 `clientEventId` 重试。重复 delivery、ACK 和事件必须幂等。

同一 Issue 最多一个活动 Agent Run。Human Run 进入 `in_progress` 时可以没有 Chat 和 Run，也不占用 Agent Run 锁。

## 5. Review attempt

进入 Review 节点时，Server 原子创建新的 attempt：

- Human Review：状态为 `awaiting_human`，不创建 Chat 或 Run，由人工 mutation 提交 verdict。
- Agent Review：派发到 Worker 指定的 Desktop，为本 attempt 创建全新 Chat 和 Run。

Agent Review 最终结果必须为严格 JSON：

```json
{
  "verdict": "approved | changes_requested | rejected",
  "summary": "审查结论"
}
```

Desktop 从对应 external run 的最终助手消息解析并随终态事件上报。非法或缺失结果只把 attempt 标记为 `failed`，Issue 留在 Review 节点；重新审查会创建新的 attempt、Chat 和 Run。

## 6. 同步握手

Desktop 连接：

```text
wss://<host>/ws?role=desktop&v=1&contractVersion=1.0&token=<jwt>
```

`sync.hello` 必须携带当前 `deviceId`、JWT 对应的 `ownerUserId`、本机 Agent 列表、项目映射、同步 cursor 和 `cacheSchemaVersion=1`。Server 返回 Contract `1.0`、能力列表和是否需要全量快照。

Snapshot 包含 `issueStageWorkers[]`、`issueChats[]`、`issueRuns[]` 与 Review attempts。Issue 顶层不提供全局 worker、Chat、Run 或 dispatch 标量；附件字段 `attachmentChatId` 独立保留。

## 7. 身份与权限

- Desktop session actor 始终来自已验证 JWT subject；`ownerUserId` 不能覆盖身份。
- `deviceId` 来自认证 Desktop session，Website 不能填写或伪造本机 Chat ID。
- Agent 必须存在于目标 Desktop 上，且当前用户具有 Project 访问权限。
- 只有本机 Chat 可以打开；Website 仅展示 Chat ID、Agent、Desktop、Review 和 Run 状态。

## 8. 发布顺序

Kanban 尚未发布过旧合同。首次发布顺序为：备份并升级 Server 数据库，发布 V1 Website，再发布 V1 Desktop。回滚必须同时恢复迁移前数据库和三个端的旧程序。
