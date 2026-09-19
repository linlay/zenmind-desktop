# WebApp SDK 接入

机器契约由 `npm run webapp-contract:generate` 从源码生成；`webapp-contract:check` 检查漂移。`bridge.mjs` 与运行时 `/__desktop/bridge.js` 内容一致，生成文件不能手改。

浏览器：

```js
import { connector, desktop, assistant, skill, artifact, kanban, automation }
  from '/__desktop/bridge.js';

// 在点击处理器中申请当前运行实例的读取权限。
const access = await desktop.requestAccess({ capability: 'connector.read' });
if (access.status !== 'granted') return;
const description = await connector.describe({ connectorId: 'example' });
const result = await connector.invoke({
  connectorId: 'example', operationId: 'item.list',
  revision: description.revision, arguments: {}
});
```

应用的 `desktopBridge.connectorOperations` 必须包含对应 connectorId 与 operationId。声明不等于用户授权。`connector.list()` 和 `connector.describe({connectorId})` 用于发现已声明的操作；CLI/MCP adapter 由 Platform 选择，调用函数相同。平台负责执行只读政策和 operation revision 校验。

收到 `connector_auth_required` / `connector_auth_expired` 后显示登录按钮，在新的用户点击中调用 `desktop.authenticateConnector({connectorId})`，只得到 `{status:'authorized'|'cancelled'|'failed'}`。认证接口不接受 URL、回调、账号或 token。成功后由业务显式重试原只读请求；SDK 不自动重放。

Node 后端将生成的 `bridge.mjs` 随应用复制到后端目录：

```js
import { createBackendClient } from './bridge.mjs';
const { connector, assistant, skill, artifact, kanban } = createBackendClient({
  url: process.env.DESKTOP_ACTION_BRIDGE_URL,
  token: process.env.DESKTOP_ACTION_BRIDGE_TOKEN
});
```

仅受管后端使用 Desktop 注入的 loopback URL 与 token；不得转发至前端或日志。Node SDK 不依赖 DOM。UI 登录、权限确认、产物预览/保存和其他原生交互只允许页面调用。退出账号后 token 失效，登录并重启应用后重新获得。

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

连接器登录可单独声明 `desktopBridge.connectorAuthentication: ["wecom"]`，不要求 `connectorOperations`。业务操作声明仍只控制 list/describe/invoke；已有业务声明也允许相应连接器登录。示例中的 example/item.list 仅表示已安装包中实际存在的操作，不代表 WeCom 提供日历或会议接口。

连接器认证复用 Platform 现有凭据，工作台、Agent、管理界面使用同一连接器账号，不要求 personalConfig，也不新增用户目录。应用 grant 与宿主身份校验保留；登录成功不自动赋予应用业务调用权限。
