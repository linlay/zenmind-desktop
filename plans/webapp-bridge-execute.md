# WebApp Bridge 接入 Platform `/api/execute`：评估与完整方案

> 状态：实现已落地；macOS 原生 Electron 页面与受管后端的真实十分钟期限、interrupt 和连接回收已验证，见文末实施记录。Windows 原生与双平台安装包回归仍需目标环境验收。
> 核对日期：2026-10-29。基线：Desktop `f86bfece`、Agent Platform `8a514534`。
> 替代原先基于 v0.5.27 的草案。按用户后续要求加入 HTTP /api/interrupt 主动取消，并保留连接断开取消。

## 1. 评估结论

方向可行。Platform 已实现同步结构化执行接口，Desktop 增加受限 WebApp 适配与完整的请求生命周期；Platform 同步增加 execute 的 run.started 请求关联字段并修复空对象交卷序列化，不增加 WS execute 或任务查询接口。

首版建议：**页面和受管 Node 后端共用 `assistant.execute`；同步等待；仅 JSON；固定 `accessLevel: "default"`；只接受 `message / input / outputSchema`；取消贯穿整个 HTTP 链路。**

这不是单纯增加一个 SDK 方法，而是中等规模的跨模块改造。主要工作在断开传播、长请求超时、身份连续性、响应校验和错误边界。原草案的方向正确，但还不能直接作为实施契约。

### 1.1 原草案的关键缺口

| 问题 | 当前代码事实 | 本方案处理 |
| --- | --- | --- |
| 将生成 SDK 当修改入口 | 生成器从 `src/main/modules/webs/webapps/bridge-module.ts` 生成 `contracts/webapp/bridge.mjs` | 修改源文件，再运行生成器 |
| 独立 capability 没有覆盖后端授权 | `capability-policy.ts` 对 backend scope 显式筛选 capability | 同时更新 shared 映射和 backend 允许集合 |
| 把 Manifest 声明当权限开关 | 当前 policy 忽略 Manifest 能力声明，采用安装即信任 | capability 用于发现和入口分组，不增加权限申请 |
| 直接复用现有 HTTP helper | `webapp-platform-client.request` 固定 35 秒，读取 `data.errorCode`；execute 返回 `data.error.code` | 专用 execute HTTP adapter |
| 跨领域调用私有 client | `agent-platform/PlatformClient` 是领域私有实现 | 复用 WebApp 数据桥已有身份端口，不深层导入私有 client |
| SDK abort 被当作上游取消 | gateway 只有 120 秒 timeout；action server 没传客户端断开 signal | 补齐两层代理和最终 fetch 的取消 |
| skillIds 没有合法传输路径 | Platform 严格 DTO 不接受 references/skillIds | 首版拒绝，使用目标 Agent 自身配置 |
| schema 限额与整包限额混淆 | 页面完整 envelope 最多 64 KiB | 明确两个限制同时成立 |
| 结果路径被视为 artifact | 现有 artifact API 要求真实 artifactId | 不自动下载 `@chat` 字符串 |
| 官网退出与本地身份混淆 | 当前鉴权文档明确官网 SSO 不轮换本地 Platform 身份；源码未在官网退出时全量撤销 WebApp token | 不新增官网账号门禁或退出取消 |
| success 含义被放大 | Platform 优先返回已经接受的 submission，再处理没有 submission 的 Run 错误 | success 只证明结构化交卷通过 |

存在两处需在实施时同步修正的旧文案：`docs/本地网站应用.md` 数据能力段仍写“退出账号撤销已有 page/backend token”，与 `docs/鉴权SSO与TokenBridge.md` 及当前调用代码不一致；`docs/桌面协议与动作桥.md` 入口表仍写“manifest 授权”。应以当前本地身份不变量和源码为准，不能借这次改造恢复旧权限模型。

## 2. 首版范围与技术取舍

交付范围是本机 WebApp 页面与 Desktop 注入 backend token 的受管 Node 进程。每次创建新 Chat，执行一个 Run，等待结构化结果；不续聊。页面不接触 Platform token、Cookie、服务 URL 或宿主文件路径。

| 决策项 | 首版决定 | 原因 |
| --- | --- | --- |
| 执行模型 | 有界同步 | 与 Platform 当前协议一致，不引入另一套任务事实 |
| 页面长任务 | execute 专属外层期限 | 两种入口保持相同的执行模型 |
| 后台 job / 轮询 / 持久恢复 | 不增加 | 会引入任务身份、缓存、恢复、清理与 stop 语义，超出接入范围 |
| Platform WS execute | 不需要 | 没有必要为单个 HTTP 能力改造 Broker |
| accessLevel | Main 固定 default | 页面和后端不能自提权 |
| 技能 | 只使用 Agent 自身配置 | execute 不接受 references |
| 文件输入 | 不支持 multipart | 无上传句柄、生命周期与字节协议前不能直接透传 |
| 结果文件 | 只复用已发布 artifact | 任意 @chat 文件读取另立方案 |
| 新 Agent/设置项 | 不增加 | 复用现有 Agent 选择机制，不自动改写 helper |
| 自动重试 | 禁止 | requestId 不去重，重发可能重复产生副作用 |

不自动创建 Copilot Dock、Root Observer、SiteControlScope 或 WorkPanel grant。execute 是数据执行能力，不因应用身份而获得页面控制授权。

不提供审批和问答 UI。Platform 遇到审批可以返回 `approval_required`，但 `ask_user_question / ask_user_form` 仍可能等待；本桥只能等待、取消或到期。目标 Agent 应面向无人交互的任务配置，不能宣传为完整交互式聊天替代品。

同步连接中断后没有恢复句柄。跨页面重载或 Desktop 重启继续取结果的业务不属于首版保证范围。

## 3. 对外 API 与参数契约

### 3.1 SDK

页面和后端使用相同签名：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue };

type ExecuteInput = {
  message: string;
  input?: JsonValue;
  outputSchema: { type: "object"; [key: string]: JsonValue };
};

type ExecuteResult =
  | { chatId: string; status: "success"; output: Record<string, JsonValue> }
  | { chatId: string; status: "failure"; reason: string };

assistant.execute(input: ExecuteInput, options?: { signal?: AbortSignal }):
  Promise<ExecuteResult>;
```

```js
import { assistant } from "/__desktop/bridge.js";

const controller = new AbortController();
const result = await assistant.execute({
  message: "提取订单金额，无法识别时提交 failure。",
  input: { text: "订单总额 128 元" },
  outputSchema: {
    type: "object",
    properties: { amount: { type: "number" } },
    required: ["amount"],
    additionalProperties: false
  }
}, { signal: controller.signal });

if (result.status === "success") {
  console.log(result.output.amount);
} else {
  console.log(result.reason);
}
```

后端使用既有注入配置创建 `createBackendClient({url, token})`，调用 `client.assistant.execute(...)`；backend token 不能交给前端或远端请求。

signal 是本地选项，不进入 JSON。业务 `status: failure` 正常 resolve；协议、传输和执行失败才 reject `DesktopBridgeError`。execute 的主动取消统一为 `code: cancelled`，包含 fetch 和响应体读取期间的取消，不误报为 bridge_unavailable/invalid_response。只为新增路径定义此行为，不附带修改其他 SDK 方法。严格 JSON 嵌套最多 64 层。

### 3.2 Bridge envelope

```json
{
  "action": "assistant.execute",
  "args": {
    "message": "提取订单金额",
    "input": { "text": "订单总额 128 元" },
    "outputSchema": {
      "type": "object",
      "properties": { "amount": { "type": "number" } },
      "required": ["amount"]
    }
  }
}
```

响应沿用 `{ok:true, action:"assistant.execute", result:ExecuteResult}` 或 `{ok:false, action, error:{code,message,details?}}`。不返回 Platform envelope，不虚构 runId/jobId。

output 是应用拥有的 JSON，Desktop 原样保留合法业务字段，不按字段名转换时间或改写字符串；宿主元数据、认证信息和内部错误不得混入 output。

### 3.3 校验与大小限制

| 项目 | 规则 |
| --- | --- |
| args | 非数组 JSON object；仅允许 message、input、outputSchema，未知字段拒绝 |
| message | string，trim 后非空，原文转发；沿用 `.length` 口径，最多 12,000 个 UTF-16 code unit |
| outputSchema | JSON object，根 type 严格为 object；UTF-8 JSON 字节数不超过 65,536 |
| Schema 语义 | 完整编译和结果校验只由 Platform 负责 |
| input | 可省略或任意标准 JSON；保留 false、0、空串和 null，不用 truthy 判断省略 |
| 页面完整请求体 | 保持 gateway 的 65,536 字节上限，含 action、args、转义和全部字段 |
| 后端完整请求体 | 保持 action server 的 262,144 字节上限 |
| Platform 完整响应 | 新 adapter 按实际读取字节限制为 1,048,576 字节，包含 envelope |

因此不保证页面能发送恰好 64 KiB 的 schema：完整请求也必须放得下。首版不放宽普通 Action 边界；较大的任务数据可使用现有受管后端 256 KiB 入口，文档必须明确双入口的传输差异。

SDK 在序列化前为 execute 校验严格 JSON。显式 input:undefined 视为省略，嵌套 undefined、循环、BigInt、函数、Symbol、NaN/Infinity、Blob 和自定义 toJSON 对象仍拒绝。input/schema 各从自身根节点计数，最多 64 层；Main 校验仍是权威，不复制完整 Schema 编译器。

input 中的 `$file` 是 Platform 的保留语义。首版没有 multipart，发送前拒绝 input 中任何对象键 `$file`，返回 invalid_args；不把它当普通键，不从宿主或旧 Chat 补文件。普通 `"@chat/foo"` 输入字符串也不会获得旧 Chat 文件访问能力。

## 4. 能力、身份和 Agent 选择

### 4.1 独立 WebApp 数据方法

新增 `assistant.execute` capability 和同名公开 action，直接由 WebApp 数据桥 handler 处理，组织方式与 assistant.events、connector.invoke 一致。

- 在 `src/shared/webapp-bridge.ts` 登记 capability/action，action 值直接使用 `assistant.execute`。
- 在 `webapps/capability-policy.ts` 同时允许 localPageGateway、backendActionToken。
- 在 `action-handlers.ts` 的通用 Action lookup 前分发；handler 内再次要求真实 invocation 为 webappPage/webappBackend。
- 不新增 desktop.assistant.execute alias，不登记 DESKTOP_ACTION_DEFINITIONS，不改 `src/shared/desktop-actions.ts`。
- 普通 `/actions/call`、Desktop WS 和 Platform 反向 Action 无权调用，直接 assistant.execute 返回 forbidden；不存在的 desktop.assistant.execute 返回 unknown_action。

capability 只表示宿主实现了方法，不证明当前 Platform/Agent 可执行。Manifest v2 不增加字段，不增加能力授权或通用 Action 确认框。Bridge version 保持 2，属于向后兼容的方法增量。

### 4.2 身份连续性

沿用同源 gateway 注入的不可读 page token 和受管后端的 backend token；两种 scope 不串用。LAN、Tunnel 发布入口、Website 和跨 origin 不开放 Desktop 保留路由。

复用 captureWebappContext 捕获本地 Platform endpoint、应用主体、WebApp runtime 指纹与 grant。身份从宿主 token 派生，不接受调用方 appId、subject、source、凭据、路由或服务地址。

**grant signal 和单次 request signal 必须分开。** 当前 captureWebappContext 用 `WeakMap<AbortSignal, identityKey>` 绑定 grant 的身份连续性。把每次新建的组合 signal 替换 invocation.signal 会丢失跨请求绑定。

保留 invocation.signal 的 grant 含义，为 WebApp invocation 新增独立 `requestSignal?: AbortSignal`。capture 仍接收稳定 grant signal；仅最终 fetch 合并 grant、request、deadline、context 失效和宿主 dispose 信号。

官网登录/退出/刷新不轮换本地调用身份，不新增“必须先官网登录”。Agent 依赖官网凭据的 Provider/连接器失败，按对应服务原有机制返回。

### 4.3 Agent 与技能

保留 chat 当前优先级：有效用户配置中 `source: desktop.agents` 的选择值 → Manifest copilot.agentKey → Desktop desktopHelperAgentKey。指定了不可用 Agent 时失败，不能回退。

抽出 `desktop-actions` 内部窄函数供 chat/execute 共用选择逻辑；chat 的 references/skillIds 保持在 chat 路径，不改变已有行为。

执行资格以 Platform 的 Native Agent + 有效 result_submit 校验为准，不按 mode 为 EXECUTOR 过滤，不额外读取 admin API 或重复预检工具。默认 helper 未必支持 result_submit，应通过现有固定 Agent/用户选择机制绑定适合的 Agent；不自动创建或替换 Agent、不修改 helper 配置。

execute 只使用目标 Agent 自身配置的技能、连接器和工具，**不注入 Manifest copilot.references**。同一应用调用 chat 时原引用仍生效。需要 execute 专属技能时在 Agent 配置中挂载，不把技能文本拼到 message 模拟 references。

## 5. 模块和调用流程

```text
页面 SDK → gateway → /webapps/pages/actions/call ─┐
                                                 ├→ assistant.execute handler
Node SDK ─────────→ /webapps/actions/call ────────┘
  → 校验 invocation、输入并预留容量
  → captureWebappContext、选择 Agent、发送前复验
  → 专用 HTTP adapter → POST /api/execute
  → 有界读取、校验 Platform 响应
  → 最终 context 复验、登记可信 chatId 归属
  → 交付 ExecuteResult 或稳定错误
  → finally 释放计时器、监听、reader 与容量
```

`webapp-execute.ts` 负责请求协调，`webapp-execute-client.ts` 负责固定 HTTP 请求与响应解码，`webapp-assistant-agent.ts` 负责共享 Agent 选择。单元测试可替换 Node HTTP 端口；连接池与长请求由真实 Electron 脚本另验。不增加通用任务框架或任意路由代理。

adapter 使用现有 WebApp 身份捕获结果，通过 Node HTTP(S) 独立 socket（agent:false）发送，不使用 Chromium 默认 session，不跟随重定向、不继承 Cookie，不设置短于业务期限的连接空闲超时。携带 Main 的 Bearer token、Content-Type、Accept 和现有 X-Locale，不转发调用方 headers。固定构造：

```ts
{
  agentKey: resolvedAgentKey,
  message: args.message,
  outputSchema: args.outputSchema,
  ...(args.input === undefined ? {} : { input: args.input }),
  accessLevel: "default",
  requestId: hostGeneratedUUID
}
```

requestId 只关联诊断，不提供去重。401、网络错误、超时或非法响应均不自动重发 POST。

不深层导入 agent-platform 私有 PlatformClient；不直接复用固定 35 秒的 webapp-platform-client.request、会在 unauthorized 后重发的 platform-http helper，也不进入 query RunController 或订阅 Broker 的 Run stream；仅为主动取消被动接收共享 Primary Push。

## 6. 超时、取消与资源生命周期

以下是首版建议常量，不新增用户设置或调用参数；测试允许注入短期限：

| 限制 | 值与语义 |
| --- | --- |
| Main 期限 | 600,000 ms，从 handler 受理起覆盖身份、Agent 查询、执行和响应体读取 |
| gateway 外层期限 | 615,000 ms，仅 assistant.execute；给 Main 返回错误留余量，其他 Action 保持 120 秒 |
| 在途并发 | 全局 8，同一 WebApp 实例 2，页面/后端共享实例额度 |
| 排队 | 不排队；超限在访问 Platform 前返回 app_capacity_exceeded |
| 在途 context 检查 | 每十五秒兜底，单请求不重入，同宿主一秒内合并身份探测；仅确认身份、endpoint 或实例不匹配才撤销，瞬时失败只记诊断；交付前严格复验 |

并发额度在首次异步操作前原子预留，所有出口 finally 释放；不保留终态任务或结果。

### 6.1 取消传播

1. SDK abort、页面刷新或真实断开 → gateway abort 到 action server 的 fetch。
2. gateway/backend 断开 → action server 生成 requestSignal，同时保留稳定 grant signal。
3. handler 合并请求断开、grant 撤销、context 失效、Main deadline、宿主停止 → abort Platform fetch 和响应体；Platform 根据断开中断 Run。

两段 Node HTTP 接收层均监听 req.aborted 与 res.close，仅在 `!res.writableFinished` 时把后者判为离开。不能将普通 req.close 当中断，它在请求体正常读完时也可能出现。开始读 body 前安装监听，并覆盖已断开状态及“body 读完、fetch 未开始”的竞争。

每层 finally 移除监听、清除 timer、释放 reader。下游已经断开时停止 writeJSON/res.end；正常完成后的 close 不再取消。

不能只把 AbortSignal.timeout 改成十分钟：gateway 到 Action server、Main 到 Platform execute 和 interrupt 均使用独立 Node HTTP(S) socket（agent:false），不共用 Chromium 或其他请求的连接池；其他 Action 保持原路径。

受管 Node SDK 没有 gateway，但当前使用 global fetch，同样不能依赖其默认长请求行为。首版为 createBackendClient 的 execute 提供专用 Node HTTP 传输：仅在该方法被调用时动态加载 node:http，连接已经校验的注入 loopback URL，不跟随重定向；外层期限 615,000 ms，不设置更短的响应头/活动 socket 期限。它复用相同 JSON envelope、错误解码和 AbortSignal 语义，并有界读取 Bridge 响应（上限为 Platform 响应限额加 4 KiB envelope 余量）。浏览器方法和其他后端方法继续使用现有 fetch，不把 Node 依赖加载到页面。

真实集成测试必须覆盖原 35 秒、120 秒和可能的 300 秒边界，分别验证页面完整链路及真实 Node SDK 传输，而非只检查配置常量。执行环境若通过额外代理转发本机请求，也必须在发布验收中证明不会提前断开。

Main 到期时向仍连接的调用方返回 assistant_timeout；gateway 自己到期且客户端仍在时返回同码。客户端主动 abort 在 SDK 本地得到 cancelled，不能保证仍收到服务端正文。身份失效、主动取消、超时要保留具体原因，不能被随后出现的通用 fetch 异常覆盖。

### 6.2 实例与宿主停止

- WebApp 停止、重启、替换或卸载撤销旧 grant；runtime 指纹变化另由在途和最终检查兜底。
- 隐藏页面、切换侧栏、主工作区/WorkPanel 展示转移不主动取消；连接还在就继续。
- guest 销毁/文档刷新导致连接断开，取消该页面调用；后端独立调用不因页面关闭取消。
- action bridge 停止或更换端口前 abort 所有在途 execute controller，再 close server；单纯 server.close 会留下长请求。
- 不用 assistantBridge.stopRun 取消 execute，也不扩展 assistant.stop/subscribe。Main 发送前同步登记共享 Primary 的 run.started 订阅，后台准备连接，不阻塞 POST；通过宿主 requestId 与根 agentKey 匹配 canonical runId/chatId。取消时在独立三秒期限内获取当前 token，复验主体和 endpoint 未改变，再发 HTTP /api/interrupt 并校验 ack；同时 abort execute。不自动重试，不接受页面指定 Run。尚未取得身份或通知丢失时，由连接断开取消兜底。

Main 期限必须覆盖前置异步操作：不能只给最终 fetch 加 timeout。等待身份/Agent 查询时也应及时结算取消，并用 epoch/终态保护阻止迟到回调再发送 POST。

取消不能撤销已经发生的外部副作用，也不保证 Platform 已观察到断开才返回 SDK 错误；不能宣称事务回滚或 exactly-once。

## 7. 响应校验与错误模型

HTTP 成功与 code === 0 必须同时成立。data 必须含非空 chatId，且为以下之一：success + 非数组 JSON object output；failure + 非空 string reason。只投影对应字段，缺失 output、未知 status、空 chatId、非法 JSON 或矛盾 envelope 均为 invalid_platform_response。

完整输出 Schema 校验由 Platform 负责，Desktop 不做第二遍。Platform 接受 result_submit 后，模型还可继续使用工具直到 Run 结束；当前源码在有 submission 时优先返回它，后续错误或中断不一定覆盖成功交卷。首版忠实转发权威结果，不承诺所有工具或副作用都成功；如业务需要该保证，应另行修改 Platform 语义和测试。

从结构化 data.error.code 读取错误码，msg 只作受控错误名的兼容校核。数字 code、旧 helper 的 data.errorCode 均不能作为错误名。采用白名单映射，不返回原始 message/cause、工具输出、服务地址或认证信息。

| 场景 | WebApp code |
| --- | --- |
| 参数形状、未知字段、$file | invalid_args |
| message 超长 | assistant_message_too_long |
| 完整 Bridge 请求超限 | 入口沿用 invalid_request，提示明确大小；SDK 预检可报 invalid_args |
| 本地服务身份不可用 | desktop_identity_required |
| 来源/scope 错误 | forbidden |
| grant/runtime/身份连续性失效 | app_grant_required |
| 并发超限 | app_capacity_exceeded |
| Platform 400 invalid_request/unknown_field | invalid_args |
| 400 result_submit_unavailable/execute_unsupported_agent | assistant_agent_unsupported |
| 404 agent_not_found | assistant_agent_unavailable |
| 403 approval_required | approval_required |
| 422 output_missing/output_invalid | 同名保留 |
| 409 cancelled | cancelled |
| 500 run_error | assistant_failed |
| Platform 401 或无已知业务码的 403 | assistant_unavailable |
| 路由 404，无 agent_not_found 结构 | assistant_execute_unavailable |
| 其他 HTTP/网络故障 | assistant_unavailable |
| 响应超限 | assistant_result_too_large |
| 响应非法 | invalid_platform_response |
| Main/gateway 期限到期 | assistant_timeout |

SDK 到本地桥的普通网络故障沿用 bridge_unavailable；execute 主动取消为 cancelled。终态只能交付一次。

details 只允许已校验 chatId、所选 agentKey、白名单 platformCode、HTTP status 和宿主 requestId。连接拒绝和 Platform 明确的 invalid_request、unknown_field、agent_not_found、result_submit_unavailable、execute_unsupported_agent 准入拒绝标 executionState:not_started；其余发送后丢失响应标 unknown，不提示无条件重试。

日志只记上述标识、阶段、耗时和稳定错误码，不记 message/input/schema/output/reason/token/完整 URL/data.cause。合法业务 failure.reason 属于应用结果，可返回但不写宿主日志。业务 output 由 Agent 生成，WebApp 自行按业务规则消费，不因 Schema 合法而视作可信 HTML 或可执行代码。

## 8. Chat 归属与结果文件

成功交卷（包括业务 failure）最终复验 context 后，调用 rememberWebappChat 登记归属。结构化 Platform 业务错误携带合法 chatId 时，也只在原 context 有效时登记和交付，供排查和读取该 Chat 已发布产物；网络错误或非法正文中的 chatId 不采信。

现有归属缓存有容量限制。必须避免“Platform 已完成，缓存登记满了，最后返回容量错误”：发送前检查/预留应用 Chat bucket，完成或失败释放预留。保留已有实例隔离和有界缓存，不另建持久 Chat 权限表。

Platform 不解释 output 字符串，也不保证 @chat 文件存在。现有 artifact.read 要求 chatId + artifactId，只读已经登记的产物：

- output 原样返回，不改写 @chat 路径、不自动下载。
- Agent 通过原有机制发布文件后，可在该 Chat 的 artifact.list/get/read 使用真实 artifactId，沿用归属和大小限制。
- 只有 `@chat/report.pdf` 的文件首版不能下载，不开放任意 `/api/resource` 透传。
- 若后续支持未发布文件，需独立定义同 WebApp/Chat 绑定、路径归一化、越界/符号链接防护、MIME、字节上限与下载协议。

## 9. 实施文件与步骤

| 文件 | 改动 |
| --- | --- |
| src/shared/webapp-bridge.ts | capability、同名 action、需要跨层复用的 DTO/常量 |
| src/main/modules/webs/webapps/bridge-module.ts | 共用 SDK 方法、严格 JSON、signal；后端 execute 专用 Node HTTP 传输与取消包装 |
| src/main/modules/webs/webapps/capability-policy.ts | backend scope 开放 execute |
| src/main/modules/webs/webapps/gateway.ts | 专属期限、长请求 HTTP 栈、断开传播、停止写回 |
| src/main/modules/desktop-actions/action-contracts.ts | requestSignal 与原 grant signal 分离 |
| src/main/modules/desktop-actions/action-http-server.ts | 两类 WebApp 路由断开 signal、关闭和端口替换清理 |
| src/main/modules/desktop-actions/action-handlers.ts | WebApp 数据方法分发和来源门禁 |
| 新增 webapp-execute.ts、webapp-execute-client.ts | 协调、HTTP adapter、校验、错误映射与容量 |
| 新增 webapp-assistant-agent.ts；调整 action-dispatch.ts | 抽取 Agent 选择，保持 chat 行为 |
| src/main/modules/desktop-actions/webapp-connector.ts | Chat bucket 发送前预留/登记窄接口 |
| contracts/webapp/bridge.mjs | 运行生成器更新，禁止手改 |
| contracts/webapp/README.md | 双入口示例、错误、限额、Agent/技能差异和文件边界 |
| docs/本地网站应用.md、docs/智能助理集成.md、docs/桌面协议与动作桥.md | 新边界及原有身份/权限文案修正 |
| test/、qa/manual-regression.md | 契约、真实 HTTP 断开、双平台工作流 |

Manifest 不变，webapp.schema.json/validator 不应出现无理由的结构变化，但生成器和漂移检查仍统一执行。Platform 只增加 execute 的 run.started.requestId 和空 output 对象序列化修复，并更新对应测试/文档；无需修改 preload、renderer、服务 deploy/start、.env 或启动参数。

实施顺序：① 契约/SDK/scope/生成产物；② 主进程 adapter、Agent、容量与归属；③ 全链路断开、deadline、身份失效和停止清理；④ 自动验证、真实 Platform 用例、设计文档与双平台验收。

这只是提交拆分，①至④必须作为闭环发布，不能先上线会留下孤儿 Run 的半成品。

## 10. 验收方案

### 10.1 自动验证矩阵

| 层 | 必须验证 |
| --- | --- |
| SDK | 双入口同形；signal 不入 JSON；success/failure；fetch/读正文取消；未知字段与非标准 JSON 拒绝 |
| 授权 | 两类 token 可执行且不串 scope；撤销/缺失拒绝；普通 Action/WS/Platform 不能调用；Manifest 未声明仍可用 |
| 参数/Agent | 三层优先级；失效不 fallback；unsupported；拒绝 skillIds/accessLevel；UTF-8 大小边界；input 假值保留 |
| HTTP | 固定 endpoint、Main token、default、host requestId；无 query 字段/Cookie/重定向；POST 零自动重试 |
| 响应 | 全部映射；非法 JSON/status/output/chatId/envelope；实际字节上限；cause 不泄漏；业务字段不改写 |
| 取消 | 正常 body 结束不误取消；页面/后端断开、grant 撤销、runtime 替换、deadline、bridge stop/端口替换均断开同次 Platform 请求 |
| 竞态/释放 | grant 身份绑定不丢失；旧实例不交付；双入口共享额度；原子预留；超时与成功只结算一次；所有资源清理 |
| 归属 | success/failure/可信业务错误的 chatId；跨 app 拒绝；bucket 满在发送前失败 |
| 回归 | chat 的 Agent/skillIds/background/subscribe/stop、image 保持；LAN/Tunnel/伪造 Origin 不获能力 |

新增 `test/webapp-execute.test.mjs` 与 `test/webapp-execute-http.test.mjs`，复用现有 SDK、connector、action bridge、webs、LAN fixture，不把所有测试继续堆进大文件。

HTTP 集成测试用假的 Platform server 阻塞响应，观察真实连接关闭；分别穿过 gateway→action server 和 backend→action server，不能只断言 mock fetch 收到 signal。短期限/可控时钟测试超时状态机；长请求边界另用实际目标 HTTP 栈验证，缩短业务 timer 不能代替对传输层隐含 timeout 的验证。

```sh
npm run webapp-contract:generate
npm run webapp-contract:check
npm run architecture:check
npm run build:main:prepared
node --test --test-concurrency=1 test/webapp-sdk.test.mjs test/webapp-execute.test.mjs test/webapp-execute-http.test.mjs test/webapp-connector.test.mjs test/desktop-action-bridge.test.mjs test/webs.test.mjs test/webapp-lan-access.test.mjs
```

发布按仓库既有完整检查执行。新增 execute 单元/HTTP 集成测试已实现；验证结果见文末实施记录，不以 Node HTTP 夹具代替真实 Electron 长请求或安装包验收。

### 10.2 手工回归（macOS / Windows 分别执行）

1. 静态 WebApp 与受管 Node WebApp 使用带 result_submit 的 Native Agent，取得同形 success/failure；不依赖官网凭据的模型环境在未官网登录时也可用。
2. 实际运行超过两分钟、超过五分钟但小于十分钟的任务，两入口均可完成；到期后没有挂起连接。
3. abort、刷新/关闭 guest、停止/重启/卸载 WebApp、退出 Desktop 后，Platform 本次 Run 收到中断；展示转移/隐藏不主动取消；页面关闭不取消独立 backend 调用。
4. 切换官网账号不轮换本地调用；真正本地身份/实例变化时旧请求不能交付。
5. 缺工具、非 Native Agent、坏 Schema、审批、无交卷和超大响应各有对应错误，没有权限提升参数。
6. 只对真实已发布 artifact 下载；普通 @chat 字符串不能读取任意文件，跨 app 拒绝。
7. Windows 检查真实进程停止/socket 回收；macOS 检查实际窗口关闭/退出与 Electron 网络取消。涉及平台生命周期时明确分支并分别验收，不依赖 POSIX 信号或手拼 home 路径；共享 JSON/HTTP 逻辑不增加无意义平台分支。

## 11. 发布和后续边界

Desktop 与内置 Platform 的交付组合必须实际支持 /api/execute，生成 SDK 与宿主同版本。旧 SDK 继续 chat；新 SDK 遇到旧宿主不得把 execute 降级为 chat。页面可通过 capability 发现，后端方法存在不代表宿主实现；路由不存在返回 assistant_execute_unavailable，不改发 /api/query。

实施时检查 WebApp Builder 技能/示例是否复制了 SDK；存在时通过既有 `--skill-root` 生成/分发机制同步。示例不能继续教开发者传 skillIds/accessLevel 或把 @chat 路径当 artifactId。不为本接口无条件升级不相关 WebClient transport。

后续只有明确需求才另行扩展：持久任务恢复、multipart、未发布文件读取、每次技能引用和交互式执行。每项单独定义权限与生命周期，不在首版用隐式 fallback 预埋。

## 12. 核对来源

- 设计：[模块边界](../docs/架构与模块边界.md)、[本地网站应用](../docs/本地网站应用.md)、[鉴权与 Token Bridge](../docs/鉴权SSO与TokenBridge.md)、[动作桥](../docs/桌面协议与动作桥.md)、[助理集成](../docs/智能助理集成.md)。
- SDK：[权威源](../src/main/modules/webs/webapps/bridge-module.ts)、[生成器](../scripts/generate-webapp-contract.mjs)、[shared 契约](../src/shared/webapp-bridge.ts)。
- 授权/传输：[capability-policy](../src/main/modules/webs/webapps/capability-policy.ts)、[action-tokens](../src/main/modules/webs/webapps/action-tokens.ts)、[gateway](../src/main/modules/webs/webapps/gateway.ts)、[action-http-server](../src/main/modules/desktop-actions/action-http-server.ts)。
- 协调：[action-handlers](../src/main/modules/desktop-actions/action-handlers.ts)、[action-dispatch](../src/main/modules/desktop-actions/action-dispatch.ts)、[身份与通用 helper](../src/main/modules/desktop-actions/webapp-platform-client.ts)、[后台 chat](../src/main/modules/desktop-actions/webapp-assistant.ts)、[Chat 归属/artifact](../src/main/modules/desktop-actions/webapp-connector.ts)。
- Platform：`docs/智能体执行接口.md`、`internal/api/execute.go`、`internal/server/handler_execute.go`、`internal/runtime/query/execute_result.go`；以当前源码为事实源，不依赖旧草案行号。

## 13. 实施记录（2026-10-29）

- 新增 WebApp execute capability、双入口 SDK、Main HTTP adapter、共享 Agent 选择、并发/期限/归属预留及全链路断开传播。
- grant signal 与单次 requestSignal 分离，主进程销毁/端口替换会清理在途请求。
- 按后续需求加入主动 HTTP interrupt：通过既有 Primary Push 关联精确 Run，不创建 Run stream、独立物理 WS 或页面控制授权；没有关联时仍 abort HTTP。
- Platform 增加 execute run.started.requestId；修复成功空 output:{} 被 omitempty 丢失的问题。两仓库需配套交付，旧 Platform 缺少关联字段时仍有断开取消。
- 自动测试覆盖 SDK、参数、错误、取消/身份/容量、真实 loopback 双入口与断开；真实 Electron 超过五分钟的长请求和双平台安装包工作流仍待验收。

### 本次自动验证结果

- Desktop：Main 类型检查与生产 bundle、WebApp 生成契约/漂移、架构、i18n、renderer 类型检查通过；八个相关测试文件共 283 项通过。
- Platform：首次验证采用临时基线副本。为消除工作区整文件复制可能夹带并行修改的疑问，审查修正时直接导出已提交 df26af48 的原样快照，重新运行 runtime/query、runtime/types、完整 server、architecture 四个包，均通过；该提交不含 onContinuation 的并行修改。
- 真实 loopback 集成已验证页面/原生 Node 双入口、scope 串用拒绝、页面/后端取消和 bridge 停止会关闭上游连接并发送匹配 Run 的 HTTP interrupt。
- 没有在本次运行中验证真实 Electron 十分钟长请求或 Windows/macOS 安装包工作流；这些保留在 qa/manual-regression.md，不能把 Node HTTP 夹具当作该验收结果。

## 14. 审查修正与复验

- execute 两段长连接与 interrupt 均改为 Node HTTP(S) 独立 socket，消除默认 Chromium session 的同源六连接池限制；Main 仍按全局八个、单应用两个即时准入。
- 在途身份探测降至十五秒并在同宿主短窗口内合并，临时服务/续签失败不误杀任务。最终交付仍严格复验。
- interrupt 重新取得当前同主体、同 endpoint 的 token，独立三秒期限覆盖身份获取和 HTTP；检查 HTTP/业务 ack，失败记录固定错误码，断开取消兜底保持。
- Push 同步登记、后台连接；新增 requestId、阶段、耗时和稳定错误码日志。空 Agent 在发送前失败，可证明未开始的准入/连接拒绝标 not_started。
- SDK 和 Main 的 input/schema 深度从各自根节点计数；显式 input:undefined 视为省略，嵌套 undefined 仍拒绝。
- 新增 qa/webapp-execute-electron-smoke.cjs，使用项目原生 Electron/Chromium、默认 net.fetch 与真实 Broker/本地 WS v2 夹具。验证八路到达、第九路立即拒绝、普通请求不饥饿、持有超过五分钟后刷新 token 的精确 interrupt 与连接回收；同时断言挂起期间请求没有提前结束。
- Platform 直接验证 df26af48 原样快照，四个相关测试包通过；该提交不含 onContinuation 的并行变更。两端仍需配套发布，成功空对象修复不能缺少。

审查后最终验证：相关回归 291 项全部通过；Main 构建、WebApp 契约漂移、架构、i18n 和 renderer 类型检查通过。macOS 原生 Electron 42.11.4 持有八路请求 310 秒，期间无请求提前结束；普通默认 session 调用 11 ms、第九路拒绝 13 ms、换票后精确 interrupt 11 ms，八条连接及八个中断全部完成。结果见 build/qa/webapp-execute-electron.json。Windows 原生与安装包工作流仍需分别验收，不以本次 macOS 结果代替。

## 15. 后续审查收尾

- Node HTTP end 回调捕获 Headers / Response 构造异常并 reject Promise，避免非常规 HTTP 状态触发 Main 未捕获异常；真实本地 HTTP 测试覆盖 600、999、合法 599 与空响应 204。
- 最终交付仅对 `desktop_identity_required` 等待 100 ms 后重试一次校验，不重发 execute，不延长总期限；身份或实例变化立即拒绝，等待可被取消与期限中止。永久不可用仍拒绝交付，可信业务错误的 Chat 归属登记遵循同一复验。
- Electron 冒烟新增独立 `electron-node` 子进程，使用正式后端 SDK 和 backend scope，验证成功、取消及精确 interrupt；WS 夹具补齐授权续期应答。Windows 夹具显式忽略真实 runtime-root 注册表配置，所有路径留在临时 home 下。
- `--verify-timeout` 使用真实 600,000 ms Main 期限，同时验证页面与受管后端收到 `assistant_timeout`、各自 canonical Run 被 interrupt、两条上游连接关闭。此模式不缩短生产 timer，也不通过手动 abort 代替到期。
- 本轮相关回归 164 项通过；Main 类型检查、架构与两类生成契约漂移检查通过。macOS Electron 42.11.4 的十分钟测试通过，累计 11 个精确中断和 11 条取消/超时连接回收；受管后端运行 Node 24.19.0。证据保存在 `build/qa/webapp-execute-electron-timeout.json`，普通冒烟结果单独保存。
- Windows 原生以及 macOS / Windows 安装包流程仍待验收；本轮使用本地 Platform 协议夹具，不替代真实模型业务任务或安装包验证。
