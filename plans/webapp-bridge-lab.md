# bridge-lab：Desktop WebApp Bridge 测试应用方案

> **状态：方案，未实现。**
> 相关计划：[webapp-bridge-execute.md](./webapp-bridge-execute.md)（WebApp Bridge 接入 `/api/execute`）。
> 依据：zenmind-desktop `main` @ `04e68c45`，只读调研。

目标：做一个没有业务功能的 WebApp，前端加最小 Node 后端，用来逐项测试和验证 Desktop WebApp Bridge 的全部能力，包括智能体聊天（同步和后台两种模式）和智能体执行。

## 1. 放在哪个目录

- 仓库里没有 `examples/` 或 `qa/webapps`，也没有现成的 webapp 示例包。测试里的 webapp 都是在 `test/webs.test.mjs:220-245` 里临时生成的。
- 最接近的先例是 `qa/skin-packages/`：示例目录、打包脚本 `build-example.mjs`，以及 `package.json:51` 里的 `npm run build:skin-example`，产物放在 `build/qa/*.zip`（`build/` 已在 `.gitignore`）。
- **建议放 `qa/webapp-packages/bridge-lab/`**，打包脚本放 `qa/webapp-packages/build-bridge-lab.mjs`。理由是它属于 QA 工具，和皮肤示例包同类。
  - 也可以放 `examples/webapps/bridge-lab/`，这只是位置问题。
  - 先不改 `package.json`，不加 npm script。

## 2. 打包和导入规则（已从源码确认）

- **界面导入只接受 ZIP**，两种入口：
  - 「设置 → 网页应用」里拖入 ZIP（`src/renderer/pages/settings/WebappImportDropTarget.tsx:60` 会拒绝目录）；
  - 「导入网页应用」文件对话框，过滤条件是 zip（`src/main/modules/webs/ipc.ts:229-233`）。
  - 直接装目录的 `installPackageDirectory` 只给插件内部用。
- **ZIP 布局**（`src/main/modules/webs/webapps/package-validation.js:38-67`）：
  - ZIP 里只能有一个顶层目录，**目录名必须等于 manifest 的 `id`**（形如 `webapp-<16位hex>`）；
  - 顶层目录下直接放 `webapp.json`。
- **禁止出现的路径段**（同文件 L5）：`.env*`、`.git`、`node_modules`、`__pycache__`、`coverage`、`log`/`logs` 等。所以包内不能有叫 logs 的目录。
- **打包方式**：源码目录可以叫 `bridge-lab/`，打包时先复制成 `build/qa/<id>/` 再压成 zip。脚本有两个选项：
  - 用系统 `zip` 命令（不依赖 npm）；
  - 用 Desktop 已有的 `jszip`（需要 Desktop 的 node_modules，和皮肤示例一样）。
  - Windows 上可以用 PowerShell 的 `Compress-Archive`。

## 3. Bridge 能力清单

来源：`contracts/webapp/bridge.mjs`、`contracts/webapp/README.md`、`src/shared/webapp-bridge.ts`、`src/main/modules/desktop-actions/` 下的 `action-dispatch.ts`、`webapp-connector.ts`、`webapp-assistant.ts`、`webapp-native-actions.ts`、`webapp-image-input.ts`、`webapp-kanban.ts`。

「自检」列的含义：

- ✅：进入一键自检（安全、只读）；
- 🔁：有前置条件，拿到 chatId 后才能跑，在「聊天后自检」里跑；
- ✋：只能手动点（有副作用、会弹窗，或需要用户手势）；
- ⛔：预留接口，自检里只验证它返回 `not_implemented`，算「符合预期」。

### A. 前端 SDK（`import … from '/__desktop/bridge.js'`）

| 分组 | 方法 | 参数 | 返回 | 自检 |
|---|---|---|---|---|
| assistant | `chat(msg \| {message, skillIds?, background?})` | message ≤ 上限；skillIds 必须是 copilot 声明技能的子集；**页面不能传 agentKey** | 同步：`{text, agentKey, chatId, runId}`；后台：`{accepted, chatId, runId}` | ✋ |
| | `subscribe({runId, cursor?}, {signal})` | 内部每 500 ms 轮询 `assistant.events` | 异步迭代事件 `{type: text.delta \| run.finished \| run.failed \| subscription.failed, cursor, …}` | ✋（跟着聊天走） |
| | `stop({runId})` | 只能停本应用发起的后台 run | `{stopped: true}` | ✋ |
| | `image({requestId, operation, prompt?, negativePrompt?, width?, height?, count?, strength?, seed?, preserveComposition?, edgeMode?, source?: Blob, mask?: Blob})` | operation 取值：generate / imageToImage / inpaint / outpaint / removeObject / replaceBackground / removeBackground / enhance / repairSelection；requestId 为 8–128 位 | 图片结果 | ✋ |
| | `image.cancel(requestId)` | — | — | ✋ |
| connector | `list()` | — | `{items: [{connectorId, name}]}` | ✅ |
| | `describe({connectorId})` | — | revision、adapters、components | ✅（取列表第一项） |
| | `invoke(...)` | CLI：`{connectorId, adapter: "cli", args[], idempotencyKey?, credentialRevision?}`；MCP：`{connectorId, adapter: "mcp", component, toolName, arguments, …}` | `{invocationId, exitCode, stdout?, stderr?, …}` 或 `mcp` 结果 | ✋（可能有副作用） |
| skill | `list()` | 需要 manifest 里有 copilot，否则报 `assistant_agent_unavailable` | `{items: [{skillId, name, description, agentHasSkill}]}` | ✅ |
| | `describe({skillId})` | — | 单个技能 | ✅ |
| artifact | `list({chatId, runId?, cursor?, limit?})` | 只能看本应用实例发起的 Chat | 产物列表 | 🔁 |
| | `get` / `read({chatId, runId?, artifactId})` | read 上限 1 MiB | get 返回元数据；read 返回 `ReadableStream` | 🔁 |
| | `open` / `saveAs(同上)` | 仅页面可用 | `{opened: true}`；`{saved: true}` 或 `{cancelled: true}` | ✋ |
| kanban | `boards.list()` | — | — | ✅ |
| | `issues.list({projectId?, cursor?, limit?})` | — | — | ✅ |
| | `issues.get({issueId})` | — | — | ✅（取列表第一项） |
| desktop | `capabilities.list()` / `has(id)` | — | `{bridgeVersion: 2, capabilities: [{id, status, declared, permission}]}` / bool | ✅ |
| | `app.getConfig()` / `app.getUserConfig()` | 走 `/__desktop/*.json` | appConfig / values | ✅ |
| | `theme.get()` / `locale.get()` | — | `{themeMode, resolvedTheme}` / `{locale, source}` | ✅ |
| | `theme.set({themeMode})` / `locale.set({locale})` | 会改**整个 Desktop** | — | ✋ |
| | `requestAccess({capability, connectorId?, adapter?})` | 兼容入口，直接返回 granted，不弹窗 | — | ✅ |
| | `authenticateConnector({connectorId})` | 需要用户手势 | `{status}` | ✋ |
| | `browser.openExternal({url})` | 只允许 http(s)，≤ 8192 字符 | `{opened, url}` | ✋ |
| | `dialog.selectFiles({multiple?, filters?})` / `selectDirectory()` / `selectSavePath({suggestedName?, filters?})` | 原生对话框 | — | ✋ |
| | `microphone.getPermission()` | — | — | ✅ |
| | `microphone.requestAccess()` / `open(constraints)` | open 返回 MediaStream，测完要停掉 | — | ✋ |
| | `clipboard.writeText({text})` | — | — | ✋ |
| | `notification.show({title ≤ 120, body? ≤ 1000})` | — | — | ✋ |
| | `clipboard.readText`、`screen.capture`、`file.reveal`、`window.getState/minimize/maximize/restore/close`、`camera.getPermission/requestAccess/open`、`share.open` | 预留 | — | ⛔ |
| auth | `isAvailable()` | 检查 preload 是否注入了 `__ZENMIND_AUTH__` | bool | ✅ |
| | `createSession({exchangePath})` | 弹原生确认框，需要后端交换接口 | `{ok: true}` | ✋ |
| automation | `list/get/create/update/pause/resume/remove`、`runs.list/get` | 预留 | — | ⛔ |
| 错误 | `DesktopBridgeError` | `{code, action, details?}` | 用于界面统一展示 | — |

### B. 后端 client（`createBackendClient({url, token})`，`contracts/webapp/bridge.mjs:387-400`）

- 可用：
  - `connector.list` / `describe` / `invoke`
  - `skill.list` / `describe`
  - `kanban.boards.list`、`kanban.issues.list` / `get`
  - `assistant.chat` / `subscribe` / `stop`
  - `artifact.list` / `get` / `read`
- 预留：`assistant.image`、`artifact.open` / `saveAs`、`automation.*`。
- **后端没有 `desktop.*`，也没有 `auth`**。backend token 的权限范围同样只有 connector.execute、assistant.chat、skill.read、artifact.read、kanban.read（`src/main/modules/desktop-actions/capability-policy.ts`）。

### C. `assistant.execute`：当前 SDK 中不存在

- `bridge.mjs` 和 `src/shared/webapp-bridge.ts` 的白名单里都没有。
- 与 [webapp-bridge-execute.md](./webapp-bridge-execute.md) 的计划状态一致，还没有实现。

## 4. 页面布局（纯 HTML/JS/CSS，一个页面）

- **顶栏**：Desktop 主题和语言、Bridge 版本、「全部自检」按钮、汇总表（通过 / 失败 / 不可用 / 预留 / 跳过）。
- **左栏**：能力分组，与上表一致：assistant、connector、skill、artifact、kanban、desktop.config、desktop.theme·locale、desktop.native、auth、预留、后端通道。
- **能力卡片**：
  - 方法名、预填好的默认参数 JSON、「运行」按钮、耗时；
  - 结果和错误（code / action / details）用折叠的 JSON 显示；
  - ✋ 项带「有副作用」标记。
  - 能力探测：在调用前按路径检查 SDK 上有没有这个函数，没有就标「SDK 未提供」，不报错。
- **聊天区**：
  - 同步模式：调 `assistant.chat({message})`，显示 text、agentKey、chatId、runId。
  - 后台模式：调 `chat({message, background: true})`，再用 `subscribe` 流式拼接 `text.delta` 并显示事件流，带「停止」按钮（调 `stop`）和「中止订阅」按钮（AbortController；中止订阅不等于停止 run）。
  - 可选的 skillIds 多选框，选项来自 `skill.list`。
  - 记下最近一次的 chatId 和 runId，「聊天后自检」用它来跑 artifact 系列。
  - 注意：gateway 转发 action 的超时是 120 秒，长回答可能超时，界面提示用后台模式。
- **智能体执行区**：
  - 三个输入框：message、input JSON、outputSchema JSON（默认填一个 `{type: "object", …}` 示例）。
  - 检测到 `assistant.execute` 存在就直接调用。
  - 不存在时明确显示「Desktop 尚未接入 /api/execute（见 plans/webapp-bridge-execute.md）」，并展示将要发送的请求体：`{action: "assistant.execute", args: {message, input, outputSchema, skillIds?}}`，带「复制」按钮。
  - 本地先校验：两个 JSON 能解析，outputSchema 根是 object 且不超过 64 KiB。
- **后端通道**：调用 `/api/health`、`/api/env`、`/api/backend-call`，以及 WebSocket 回声测试（连接、发送、收到回声、关闭）。

## 5. 后端设计（electron-node，只用 Node 内置模块）

- 入口 `backend/server.mjs`，用 `http`、`crypto`、`url`。监听注入的 `HOST` 和 `PORT`。
- SDK 用的 `backend/bridge.mjs` 由打包脚本从 `contracts/webapp/bridge.mjs` 原样复制过来（`contracts/webapp/README.md` L32 要求这样做），避免出现手抄后不同步的副本。
- 接口：
  - `GET /api/health`：返回 `{ok, uptime}`，同时作为 manifest 里的健康检查路径（gateway 转发时保留原路径，`src/main/modules/webs/webapps/gateway.ts:311`）。
  - `GET /api/env`：只列出哪些 `HOST`、`PORT`、`WEBAPP_*`、`DESKTOP_ACTION_BRIDGE_*` 变量存在，加上 `process.versions.node` / `electron`，不返回任何值。
  - `POST /api/backend-call {action, args}`：用 backend client 按**白名单**调用。返回 `{ok, result | error{code, action}, ms}`。后台聊天的订阅事件可以缓存在后端，再由前端分页拉取。
  - `GET /api/ws`：WebSocket 回声。
    - 用 `Sec-WebSocket-Accept` 加 sha1 手写握手，只支持文本帧，带掩码解码、ping/pong 和 close，单帧不超过 64 KiB。
    - 工作量小，可以做；gateway 只给 backendPrefixes 转发 WS（`gateway.ts:659-670`），正好拿来测转发。
    - 计划**选 WS**，SSE `/api/sse` 作为后备方案。
  - （可选，待确认）`POST /api/auth/session` 加 `GET /api/auth/me`：用来测 `auth.createSession`，见第 8 节风险。
- 安全：
  - `contracts/webapp/README.md` L42 要求后端业务 API 校验访问者，不能公开转发任意 connector 请求。
  - 建议 backend-call 只放行只读 action，并且要求 Origin 与 gateway 同源，再加一个自定义请求头。
  - 默认不放行 `connector.invoke`；`assistant.chat` 是否放行待确认。
  - 不打印 token。

## 6. manifest 草稿要点（v2，`src/shared/webapp-manifest.ts`）

- `schemaVersion: 2`；`id: "webapp-" + 16 位随机 hex`（生成后固定）；`key: "bridge-lab"`；`label: "Bridge Lab"`；`version: "0.1.0"`。
- **target 只能填一个值**（枚举，L341-348），没法同时写 darwin 和 win32。electron-node 跨平台，**建议写 `"any"`**；executable 才需要写具体平台。
- `frontend: {root: "frontend", index: "index.html", routeConfig: {backendPrefixes: ["/api"]}}`。
- `backend: {command: {type: "electron-node", entry: "backend/server.mjs"}, health: {type: "http", path: "/api/health", startupTimeoutMs: 10000}, shutdownTimeoutMs: 3000}`。
- `copilot: {agentKey: "desktopAssistant", references: [{type: "skill", id: "<某个现有技能>"}]}`：
  - `desktopAssistant` 是 Desktop 默认助手的 key（`src/shared/assistant-settings.ts:1`）。
  - 需要 copilot 才能测 `skill.list` / `describe` 和 `skillIds`；references 至少要有 1 项，用哪个技能 id 待确认。
  - 修改方式：改 `copilot.agentKey` 和 `references[].id`，重新打包导入。
- 另外加一个 `userConfig` 字段 `{name: "agent", type: "select", source: "desktop.agents"}`，用户可以在设置里换 Agent，换了会覆盖 copilot 的 agentKey（`src/main/modules/desktop-actions/action-dispatch.ts:119-140`）。字段名不能叫 `agentKey`，因为它和 copilot 互斥（`webapp-manifest.ts` L406）。
- `appConfig` 放一个示例对象，用来测 `getConfig`。不需要 `desktopBridge`，它已不参与权限判断。
- 校验：`contracts/webapp/webapp-manifest-validator.mjs` 导出了 `webappManifestSchema`，本机 node 可以直接 `import` 后 `safeParse` 做只读校验，不需要 npm install。目录布局规则需要单独按第 2 节检查。

## 7. 导入和测试步骤

1. `node qa/webapp-packages/build-bridge-lab.mjs`，生成 `build/qa/bridge-lab.zip`（顶层目录就是 id）。
2. Desktop「设置 → 网页应用」，拖入 ZIP 或点「导入网页应用」，然后启动、打开。
3. 点「全部自检」，看汇总表。
4. 聊天区分别跑同步和后台模式，再跑「聊天后自检」（artifact）。
5. 手动逐项测 ✋ 能力。
6. 后端通道：health、env、backend-call、WS 回声。
7. 执行区：现在只能看到「未接入」提示和请求体；Desktop 接入 `/api/execute` 后再实测。

## 8. 风险和待确认问题

1. 目录：放 `qa/webapp-packages/bridge-lab/`（建议）还是 `examples/webapps/bridge-lab/`？
2. target 写 `"any"` 可以吗？（schema 不支持同时写 darwin 和 win32。）
3. copilot 声明哪个技能 id 用来测 skill？agentKey 默认用 `desktopAssistant` 可以吗？
4. 后端 `/api/backend-call` 是否允许 `assistant.chat` 和 `connector.invoke`？（安全考虑，建议默认只放行只读 action。）
5. 是否测 `auth.createSession`？测试接口会收到真实的 SSO Bearer token，计划是不验签、不记录，只种一个测试 Cookie；有风险，需要确认。
6. `theme.set` / `locale.set` 会改整个 Desktop，只做成手动测试，可以吗？
7. 打包用系统 `zip`，还是复用 Desktop 的 jszip（需要 node_modules）？要不要加 npm script（会改 `package.json`）？
8. 已知限制：
   - 同步聊天超过 120 秒会被 gateway 超时；
   - artifact 只能看本应用这次运行发起的 Chat；
   - 后台 run 事件缓存最多 256 条、30 分钟；
   - 应用崩溃不会自动重启；
   - 局域网模式下 Bridge 不可用；
   - `assistant.execute` 还没实现，执行区只能展示请求体。
