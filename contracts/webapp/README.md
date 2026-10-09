# WebApp SDK 接入

机器契约由 `npm run webapp-contract:generate` 从源码生成；`webapp-contract:check` 检查漂移。`bridge.mjs` 与运行时 `/__desktop/bridge.js` 内容一致，生成文件不能手改。

浏览器：

```js
import { connector, desktop, assistant, skill, artifact, kanban, automation }
  from '/__desktop/bridge.js';

// 安装即信任，可直接调用；连接器账号仍需登录。
const result = await connector.invoke({
  connectorId: 'wecom', adapter: 'cli',
  args: ['calendar', 'schedules', 'list', '--json', JSON.stringify({
    begin_time: '2026-09-19 00:00:00', end_time: '2026-09-19 23:59:59'
  })]
});
if (result.exitCode !== 0) throw new Error('CLI failed');
const output = JSON.parse(result.stdout); // 应用继续检查业务错误码。
```

WebApp 安装即获得宿主公开能力，无需 `desktopBridge` 能力声明或 `desktop.requestAccess()`。旧 Manifest 字段仍可解析但不限制访问；旧 `requestAccess()` 作为兼容入口直接返回 granted，不弹窗、不要求用户手势。CLI/MCP 执行可读写及发送消息，不提供操作系统沙箱。

CLI 请求为 `{connectorId,adapter:"cli",args:string[],idempotencyKey?,credentialRevision?}`；返回 `{invocationId,connectorId,adapter,credentialRevision,exitCode,stdout?,stderr?}`，输出未经业务投影，WebApp 按连接器语义处理且不自动显示原始诊断。调用者不能指定可执行路径、环境或工作目录。

MCP 请求为 `{connectorId,adapter:"mcp",component,toolName,arguments,idempotencyKey?,credentialRevision?}`；返回相同身份字段及 `mcp` 原生结果（content/structuredContent/isError），不要求只有结构化对象。只访问已配置组件和实际存在、未禁用工具，禁止自定义 URL。

`connector.list()` 读取 Platform 的 `/api/connectors` 使用目录，默认连接器由 Platform 过滤，返回 `{items:[{connectorId,name}]}`；列表不包含版本或 adapter 信息。需要执行详情时按需调用 `connector.describe({connectorId})`，返回 revision、adapters、components。revision 为描述信息，执行端自己冻结并复核包指纹，不要求应用维护业务 operation revision。

收到 `connector_auth_required` / `connector_auth_expired` 后显示登录按钮，在新的用户点击中调用 `desktop.authenticateConnector({connectorId})`，只得到 `{status:'authorized'|'cancelled'|'failed'}`。认证接口不接受 URL、回调、账号或 token。成功后由业务显式重试原只读请求；SDK 不自动重放。

Node 后端将生成的 `bridge.mjs` 随应用复制到后端目录：

```js
import { createBackendClient } from './bridge.mjs';
const { connector, assistant, skill, artifact, kanban } = createBackendClient({
  url: process.env.DESKTOP_ACTION_BRIDGE_URL,
  token: process.env.DESKTOP_ACTION_BRIDGE_TOKEN
});
```

仅受管后端使用 Desktop 注入的 loopback URL 与 token；不得转发至前端或日志。Node SDK 不依赖 DOM。连接器 list/describe/invoke 在前后端使用相同契约与短期应用授权，CLI/MCP 均支持；UI 登录、兼容权限入口、产物预览/保存和其他原生交互仍只允许页面调用。后端业务 API 必须校验访问者，不得公开转发任意 connector 请求或让远程访客隐式继承本机账号。退出账号后 token 失效，登录并重启应用后重新获得。

| 能力 | 当前接口与约束 |
| --- | --- |
| Agent | `assistant.chat(message)` 或 `assistant.chat({message,skillIds?,background?})`；默认返回 `{text,agentKey,chatId,runId}`，后台返回 `{accepted,chatId,runId}` |
| 运行 | `assistant.subscribe({runId,cursor?},{signal?})` 异步迭代精简事件；`assistant.stop({runId})`，只操作本应用后台运行 |
| 技能 | `skill.list()`、`skill.describe({skillId})`；只返回固定 Copilot 声明的技能元数据，使用技能经 Agent chat，不直接执行任意技能脚本 |
| 产物 | `artifact.list({chatId,runId?,cursor?,limit?})`；`get/read/open/saveAs({chatId,runId?,artifactId})`；只允许当前应用实例发起的 Chat |
| 看板 | 安装后直接调用；`kanban.boards.list()`、`kanban.issues.list({projectId?,cursor?,limit?})`、`kanban.issues.get({issueId})` |
| 宿主 | `desktop.capabilities.list/has`、`desktop.app.getConfig/getUserConfig`、`desktop.theme.get/set`、`desktop.locale.get/set`、browser、dialog、microphone、clipboard.writeText、notification |
| 预留 | `automation.*`、desktop.screen.capture、clipboard.readText、file.reveal、window、camera、share；调用抛 `not_implemented` |

主题和语言设置只向本机 WebApp 页面开放，复用 Desktop 的设置持久化与界面更新；不要求 Manifest 声明或额外授权。托管后端 SDK、局域网和发布页面不能调用。能力检测使用 `desktop.capabilities.has('desktop.theme')` 与 `desktop.capabilities.has('desktop.locale')`。

```js
const theme = await desktop.theme.get(); // { themeMode, resolvedTheme }
await desktop.theme.set({ themeMode: 'dark' }); // light | dark | system
const language = await desktop.locale.get(); // { locale, source }
await desktop.locale.set({ locale: 'en-US' }); // zh-CN | en-US
```

设置改变整个 Desktop，并在重启后保留。页面可用 `theme.get()` 回读偏好，`resolvedTheme` 是当前实际明暗；`system` 不会被改写为具体明暗。语言切换返回 Desktop 的语言状态，不会自动翻译 WebApp 文案，应用自行维护词典并按 `locale.get()` 同步。写入失败通过 `DesktopBridgeError` 返回，不能自行当作已保存。

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

错误统一为 `DesktopBridgeError`，可读取 `code` 和 `action`。实例或账号失效返回 `app_grant_required`；连接器未登录仍返回认证错误。`capabilities.has()` 表示接口可用；连接器和看板能力的 `declared` 为 true、`permission` 为 not_required，系统麦克风等 OS 权限独立处理。

连接器登录无需 `connectorAuthentication` 声明，直接调用 `desktop.authenticateConnector({connectorId})`。认证复用现有 config，不创建额外凭据目录。

## 重试与执行回执

SDK 不自动重试。应用为发送等有副作用请求提供稳定 idempotencyKey，Platform 在执行前落盘 claim，完成后保存原始结果；同键同请求返回收据，不同参数冲突，未完成 claim 返回 invocation_outcome_unknown。退出码非零和 MCP isError 仍是可回放的执行结果，不代表肯定未产生副作用。无幂等键调用不提供去重保障。

credentialRevision 是不含凭据的账号状态版本，可在连续业务调用中回传；登录变化后执行前拒绝。超时、输出超限或响应丢失后不能换键自动重发。CLI 输出不是凭据保密沙箱；应用获得执行权限后可使用该 CLI 自身提供的数据功能。

## 升级

旧 operationId、connectorOperations、connectorWrite 契约不恢复，旧 operationId 请求返回 connector_contract_upgrade_required。现有 connectorExecution、connectorAuthentication、kanbanRead 字段仅兼容解析，新包可省略整个 desktopBridge。Bridge v1/v2 不再作为能力门控；宿主与 Platform 内部短期 grant 请求仍使用 version:2，无需应用申请或持有该凭据。

## 网站认证：`auth.createSession`

`auth` 是第八个顶层作用域，与 `assistant`、`connector`、`desktop` 并列。页面可先用 `auth.isAvailable()` 检测宿主认证传输是否存在，再在启动时或用户点击时调用。该检测不代表已登录或获准；Main 仍验证真实 Surface 并请求原生同源授权：

```js
import { auth } from '/__desktop/bridge.js';
await auth.createSession({ exchangePath: '/api/auth/session' });
const user = await fetch('/api/me').then(response => response.json());
```

只接受 `exchangePath`：以 `/` 开头的同源绝对路径，不接受 URL、查询、片段、路径回退或 `/__desktop/`。成功只返回 `{ok:true}`，失败抛 `DesktopBridgeError`。常见 code：`unavailable`、`forbidden`、`insecure_origin`、`cancelled`、`sign_in_required`、`context_changed`、`busy`、`exchange_rejected`、`invalid_cookie`、`cookie_conflict`、`exchange_failed`。

Main 通过原生对话框展示精确交换地址，本次允许后才读取当前 SSO token。请求固定为 `POST`、`Authorization: Bearer`、JSON `{}`、同源 `Origin`，不带旧 Cookie，不跟随重定向；401 最多刷新一次重试。服务端必须自行验签、校验 issuer/audience/有效期/权限，再响应 2xx 和 1–4 个 `Set-Cookie`。响应正文不向页面透传。

Cookie 要求：host-only（不得声明 Domain）、`Path=/`、`HttpOnly`、`SameSite=Lax` 或 `Strict`；HTTPS 必须 Secure。本地已登记 WebApp 的 HTTP loopback 允许不带 Secure；远端 Website 必须 HTTPS。Cookie 有效期不超过 token 到期及八小时，服务端可进一步缩短。请使用应用专属 Cookie 名；桥不会覆盖不属于它管理的已有 Cookie。

认证通过访问者页面的专用 preload/IPC 执行，不经过发布者的 HTTP Action Bridge。`createBackendClient()` 不暴露 `auth`，公开 Desktop Action 与 WebApp backend/page HTTP token 都不能调用这个入口。页面离开、guest 销毁或身份撤销会中止在途操作；退出清理本能力登记的 Cookie，重启也清理这些会话，不清空其他站点数据。网站自己的退出、会话查询和业务权限归网站后端。

发布页面可将生成的 `bridge.mjs` 作为普通静态 ES Module 随应用提供，仍调用访问者 Desktop 的 preload。它必须在 Desktop 中作为 Website 打开；普通浏览器、Help、Service、WorkPanel 和 iframe 不获得此入口。只有该认证能力可在远端使用，其他本地 SDK 能力不随发布开放。
