# WebApp SDK 接入

机器契约由 `npm run webapp-contract:generate` 从源码生成；`webapp-contract:check` 检查漂移。`bridge.mjs` 与运行时 `/__desktop/bridge.js` 内容一致，生成文件不能手改。

浏览器：

```js
import { connector, desktop, assistant, skill, artifact, kanban, automation }
  from '/__desktop/bridge.js';

// 在点击处理器中，按连接器和 adapter 申请执行权限。
const access = await desktop.requestAccess({
  capability: 'connector.execute', connectorId: 'wecom', adapter: 'cli'
});
if (access.status !== 'granted') return;
const result = await connector.invoke({
  connectorId: 'wecom', adapter: 'cli',
  args: ['calendar', 'schedules', 'list', '--json', JSON.stringify({
    begin_time: '2026-09-19 00:00:00', end_time: '2026-09-19 23:59:59'
  })]
});
if (result.exitCode !== 0) throw new Error('CLI failed');
const output = JSON.parse(result.stdout); // 应用继续检查业务错误码。
```

Manifest 声明 `desktopBridge:{version:2,connectorExecution:[{connectorId:"wecom",adapter:"cli"}]}`。声明不等于授权，旧的 connector.read/write 权限不升级。允许的 adapter 为 cli/mcp；同一连接器的两个 adapter 分别确认。该权限可读写、发消息，不推断命令只读性，也不提供操作系统沙箱。

CLI 请求为 `{connectorId,adapter:"cli",args:string[],idempotencyKey?,credentialRevision?}`；返回 `{invocationId,connectorId,adapter,credentialRevision,exitCode,stdout?,stderr?}`，输出未经业务投影，WebApp 按连接器语义处理且不自动显示原始诊断。调用者不能指定可执行路径、环境或工作目录。

MCP 请求为 `{connectorId,adapter:"mcp",component,toolName,arguments,idempotencyKey?,credentialRevision?}`；返回相同身份字段及 `mcp` 原生结果（content/structuredContent/isError），不要求只有结构化对象。只访问已配置组件和实际存在、未禁用工具，禁止自定义 URL。

`connector.list()` 返回已授权连接器及 adapters；`describe({connectorId})` 返回 revision、adapters、components。revision 为描述信息，执行端自己冻结并复核包指纹，不要求应用维护业务 operation revision。

收到 `connector_auth_required` / `connector_auth_expired` 后显示登录按钮，在新的用户点击中调用 `desktop.authenticateConnector({connectorId})`，只得到 `{status:'authorized'|'cancelled'|'failed'}`。认证接口不接受 URL、回调、账号或 token。成功后由业务显式重试原只读请求；SDK 不自动重放。

Node 后端将生成的 `bridge.mjs` 随应用复制到后端目录：

```js
import { createBackendClient } from './bridge.mjs';
const { assistant, skill, artifact, kanban } = createBackendClient({
  url: process.env.DESKTOP_ACTION_BRIDGE_URL,
  token: process.env.DESKTOP_ACTION_BRIDGE_TOKEN
});
```

仅受管后端使用 Desktop 注入的 loopback URL 与 token；不得转发至前端或日志。Node SDK 不依赖 DOM。连接器 list/describe/invoke、UI 登录、权限确认、产物预览/保存和其他原生交互只允许页面调用。退出账号后 token 失效，登录并重启应用后重新获得。

| 能力 | 当前接口与约束 |
| --- | --- |
| Agent | `assistant.chat(message)` 或 `assistant.chat({message,skillIds?,background?})`；默认返回 `{text,agentKey,chatId,runId}`，后台返回 `{accepted,chatId,runId}` |
| 运行 | `assistant.subscribe({runId,cursor?},{signal?})` 异步迭代精简事件；`assistant.stop({runId})`，只操作本应用后台运行 |
| 技能 | `skill.list()`、`skill.describe({skillId})`；只返回固定 Copilot 声明的技能元数据，使用技能经 Agent chat，不直接执行任意技能脚本 |
| 产物 | `artifact.list({chatId,runId?,cursor?,limit?})`；`get/read/open/saveAs({chatId,runId?,artifactId})`；只允许当前应用实例发起的 Chat |
| 看板 | Manifest `desktopBridge.kanbanRead:true`，点击 `desktop.requestAccess({capability:'kanban.read'})`；`kanban.boards.list()`、`kanban.issues.list({projectId?,cursor?,limit?})`、`kanban.issues.get({issueId})` |
| 宿主 | `desktop.capabilities.list/has`、`desktop.app.getConfig/getUserConfig`、browser、dialog、microphone、clipboard.writeText、notification |
| 预留 | `automation.*`、desktop.screen.capture、clipboard.readText、file.reveal、window、camera、share；调用抛 `not_implemented` |

后台运行示例：

```js
const { chatId, runId } = await assistant.chat({
  message: '生成报告', background: true, skillIds: ['report-writer']
});
const controller = new AbortController();
for await (const event of assistant.subscribe({ runId }, { signal: controller.signal })) {
  if (event.type === 'text.delta') renderText(event.text);
}
const { items } = await artifact.list({ chatId, runId });
if (items.length) await artifact.open({ chatId, runId, artifactId: items[0].artifactId });
```

技能 id 必须在应用固定 `copilot.mustUseSkills` 中，未传时使用声明的技能集；Agent 由固定 Copilot、用户配置或 Desktop 默认助手选择，页面不能传 agentKey。事件含单调 `cursor`；当前缓存最多 256 条、128 个运行、保留 30 分钟。游标过期返回 `event_cursor_expired`，不要据此重新提交 Agent 请求。订阅停止不等于停止运行。当前产物 Chat 归属只保留当前应用实例，尚不恢复历史 Chat。

`artifact.read()` 返回 `ReadableStream<Uint8Array>`，内部是最多 1 MiB 的有界缓冲；`saveAs` 同样受此上限约束。超限返回 `artifact_too_large`。预览成功为 `{opened:true}`；另存为返回 `{saved:true}` 或 `{cancelled:true}`，不返回绝对文件路径。Platform 不存在全局产物列表时，SDK 不模拟全局列表。

错误统一为 `DesktopBridgeError`，可读取 `code` 和 `action`；常见权限错误为 `app_permission_required`、`app_grant_required`、`operation_not_allowed`。`capabilities.has()` 仅表示能力已实现且应用声明，不表示已取得用户授权；应检查 `permission` 或发起权限申请。

连接器登录可单独声明 `desktopBridge.connectorAuthentication:["wecom"]`，执行声明也允许相应连接器登录。认证复用现有 config，不创建额外凭据目录。

## 重试与执行回执

SDK 不自动重试。应用为发送等有副作用请求提供稳定 idempotencyKey，Platform 在执行前落盘 claim，完成后保存原始结果；同键同请求返回收据，不同参数冲突，未完成 claim 返回 invocation_outcome_unknown。退出码非零和 MCP isError 仍是可回放的执行结果，不代表肯定未产生副作用。无幂等键调用不提供去重保障。

credentialRevision 是不含凭据的账号状态版本，可在连续业务调用中回传；登录变化后执行前拒绝。超时、输出超限或响应丢失后不能换键自动重发。CLI 输出不是凭据保密沙箱；应用获得执行权限后可使用该 CLI 自身提供的数据功能。

## 升级

撤销旧 operationId、connectorOperations、connectorWrite 契约。旧 operationId 请求返回 connector_contract_upgrade_required；旧权限请求被拒绝，旧 Manifest 不能静默升级为全量执行。无连接器执行声明的 Bridge v1 应用仍保留原有其他能力。Desktop、Platform 和应用新契约须同步升级，宿主 grant 请求固定 version:2。
