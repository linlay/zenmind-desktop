# WorkPanel 原生 HTML 草稿预览（方案 B）计划书

> 状态：计划已批准，待实施。编码按第 13 节顺序、在另行确认后执行。
> 编制日期：2026-11-06。
> 核对基线：Desktop `c97b4724`（2026-11-06），Agent WebClient `a3649075`（2026-11-06）。两个仓库当前工作区干净。
> 本文放在 Desktop 的 `plans/`，统一覆盖 Desktop 与 Agent WebClient，不复制第二份计划。

## 1. 结论

可行。Desktop 新增一个**临时 HTML 草稿**文档来源（`kind: "html-draft"`）和一个显式能力（`workpanel.document.open-draft-html`），WebClient 在 Desktop 中把 Markdown 的 HTML 代码块交给 `workpanel.openDocument`，由 WorkPanel 复用现有原生 HTML Surface（隔离 session、专用协议、批注 preload）展示；Web/Standalone 与旧宿主保持现有 blob 右侧栏预览。

关键取舍：

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 复用还是新 Surface | 复用 `document-html` | 隔离 session、协议、批注、生命周期已存在；新增 Surface 要重写一套等价安全边界 |
| 版本号 | 保持 `AGENT_WEBCLIENT_BRIDGE_VERSION = 6` | 纯增量：新 source kind + 新 capability。旧 Desktop 不宣告能力→WebClient 回落；旧 WebClient 不会发送。不破坏 v4/v5/v6 兼容矩阵 |
| 内容怎么到 Main | 走既有 workpanel bridge，`html` 放在 source 内 | 不新增上传、不产生 Chat 资源；source 同时是去重与身份依据 |
| 方案 A（上传为 Chat reference 再 openDocument） | 不采用 | 每次预览会在 Chat 根目录留下 `code-preview-*.html` 与 upload manifest，且不可清理 |
| Desktop 自己渲染源码 | 不采用 | 违反“Desktop 只原生承载 HTML/图片，源码编辑归 WebClient”的既有边界 |

## 2. 现状事实（基线，供实现对照）

| 位置 | 当前行为 |
| --- | --- |
| `agent-webclient/src/features/viewers/components/MarkdownCode.tsx:66-115` | HTML 代码块的“预览”按钮创建 `blob:`，`buildResourceViewerTarget` 后直接 `dispatch OPEN_RIGHT_SIDEBAR`，在 WebClient 自己的右侧栏打开 |
| `agent-webclient/src/features/viewers/lib/viewerTarget.ts:284` | `mimeType: text/html` → `documentKind: document-html`、`contentKind: html`；无 `source`/`revision`，`getViewerTargetKey` 为 `resource:blob:…`（每次点击都不同） |
| `zenmind-desktop/src/shared/contracts/agent-webclient-bridge.ts:570-584` | `WorkPanelDocumentSource` 只有 `workspace-file` 与 `artifact\|reference` 两种；`openDocument` 仅接受这两种 |
| `zenmind-desktop/src/main/modules/agent-platform/frame-port/workpanel-invoke.ts:81-97` | 能力只有 `workpanel.open`、`workpanel.document.open-local(-direct)` 等；`agent-chat\|agent-copilot\|agent-overview` 才有 `workpanel.open`；文档子 Surface 与 selection-explain 受限 |
| 同文件 `236-300` | `openDocument` 逐键校验 source，`workspace-file` 与 `artifact\|reference` 之外一律 `invalid_request`；`artifact\|reference` 还要求 `chatId === ownerChatId` |
| `zenmind-desktop/src/main/app/ipc-platform-frame.ts:38-129` | `openDocument` 先经图片 registry，`unsupported_native_type` 后进入 `workPanelDocumentHtmlRegistry.prepareClaim`，再经 renderer action `desktop.workpanel.openDocumentHtml` 打开 item |
| `zenmind-desktop/src/main/modules/work-panel/document-html.ts:169-186, 254-345` | `sourcePath` 只认 `path`/`relativePath`；`resolveSource` 只做 workspace 文件与 Chat 资源解析；`stableIdentity` 由 kind + 身份拼出 |
| `zenmind-desktop/src/main/modules/work-panel/document-html-preview.ts:37-77` | `resourcePrefix`/`isDocumentResourcePath` 按 workspace/artifact/reference 计算可读范围；临时文件只允许读取自身 |
| `zenmind-desktop/src/shared/work-panel.ts:307-360` | `document-html` descriptor 白名单三值 `sourceKind`，强制 `displayUrl` 必须等于 `@chat/`+路径或 `@workspace/`+路径 |
| `zenmind-desktop/src/renderer/work-panel/WorkPanelDocumentHtml.tsx:63, 405-415` | 工具条把 `displayUrl` 渲染成只读地址输入框 |
| `zenmind-desktop/src/renderer/work-panel/WorkPanelHost.tsx:1518-1526, 1662-1664` | 批注交接只接受三种 `sourceKind`；Tab 右键只传 `nativeHtml.localOriginal` |

结论：WebClient 把草稿放进 WorkPanel 的唯一障碍是“没有可被 WorkPanel 承认的来源身份”，其余能力（隔离预览、批注、刷新、关闭清理）都已具备。

## 3. 目标与验收标准

1. Desktop 主聊天中点击 HTML 代码块“预览”，在 WorkPanel 打开原生 HTML 预览标签，而不是 WebClient 内部右侧栏。
2. 预览内容与代码块逐字节一致；相对资源不越界，`blob:`/`data:` 之外的远程资源遵循 Chromium 正常网络规则（与现有 Reference HTML 一致）。
3. 同一 Chat 内同一份 HTML 重复点击复用同一个标签；内容变化则产生新标签；旧标签继续可用。
4. 草稿**没有** `@chat/`/`@workspace/` 地址，**不能**定位到 Finder/资源管理器、用默认应用/浏览器打开、另存，**不能** `document.commit`。
5. 支持 HTML 元素批注并交接到 composer，交接文案明确“直接修改对话里的代码块，不要新建资源”。
6. 关闭标签、renderer 销毁、应用退出后，Main 的临时目录被删除；不产生 Chat/Workspace/Platform 资源。
7. Web/Standalone、旧 Desktop、文档子 Surface、新会话草稿 Chat、以及任何失败路径都保留现有右侧栏预览，不出现“点击无反应”。
8. 契约镜像、WebClient vendored 副本与哈希检查在两端同步；Desktop 架构、i18n、契约检查与现有单测全部通过。

## 4. 范围与非目标

**范围内**：Desktop 契约/共享类型/Main registry/renderer 工具条与 Tab 菜单、WebClient transport 与预览按钮、两边文档与测试。

**非目标**：

- 不新增 WorkPanel Surface、不新增图片/PPT 等其它草稿类型。
- 不引入代码块源码编辑、分屏或保存；WorkPanel 仍只做 HTML 预览与批注。
- 不改变 WebClient 中 Markdown 文档 Surface（`agent-management` 子 Surface）里 MarkdownCode 的既有行为；那里的草稿会因无能力而回落到现有内部右侧栏。
- 不改变新会话草稿 Chat（`ownerChatId === ""`）的文档打开规则；草稿预览需要 canonical Chat。
- 不实现草稿持久化、历史回放或跨会话恢复。
- 不 bump `AGENT_WEBCLIENT_BRIDGE_VERSION`，不改 v4/v5 兼容矩阵。

## 5. 契约设计

### 5.1 新增常量与 source 变体（canonical：`zenmind-desktop/src/shared/contracts/agent-webclient-bridge.ts`）

```ts
export const AGENT_WEBCLIENT_HTML_DRAFT_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_WEBCLIENT_HTML_DRAFT_MAX_NAME_CHARS = 96;

export type WorkPanelDocumentSource =
  | { kind: "workspace-file"; agentKey: string; path: string }
  | { kind: "artifact" | "reference"; agentKey: string; chatId: string;
      resourceId: string; relativePath: string }
  | { kind: "html-draft"; agentKey: string; chatId: string;
      name: string; sha256: string; html: string };
```

- `name`：单个安全文件名，`^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html|htm|xhtml)$`，长度 ≤ 96；Main 用它在自己的临时目录起草稿文件。
- `sha256`：UTF-8 正文字节的 64 位小写十六进制；**Main 必须重新计算并比对**，不一致即拒绝。
- `html`：非空、UTF-8 字节 ≤ 4 MiB（Main 侧再受 `HTML_MAX_BYTES = 32 MiB` 约束，草稿上限更小）。
- `WorkPanelCapability` 增加 `"workpanel.document.open-draft-html"`。

### 5.2 能力宣告与兼容

- 仅 `agent-chat | agent-copilot | agent-overview` 且 `ownerChatId` 非空时宣告该能力；文档子 Surface、selection-explain、新会话草稿 Chat 不宣告。
- `openDocument` 的 `html-draft` 分支要求：能力已宣告、`source.chatId === ownerChatId`、结构通过统一归一化。否则 `capability_denied` / `invalid_request`。
- 版本保持 6；契约镜像与 Program Bundle 仍须原子发布（新 Desktop + 旧 WebClient、旧 Desktop + 新 WebClient 都安全降级）。
- 三个校验点复用同一条归一化函数 `normalizeWorkPanelDocumentSource`，避免三处枚举漂移。

### 5.3 线上示例

```json
{
  "version": 6,
  "title": "HTML 预览",
  "source": {
    "kind": "html-draft",
    "agentKey": "agent-1",
    "chatId": "chat-1",
    "name": "code-preview-3f2a91c8d0b4.html",
    "sha256": "3f2a91c8d0b4…（64 位）",
    "html": "<!doctype html>…"
  }
}
```

成功返回 `{ ok: true, workspaceId, itemId, renderer: "native-html" }`。宿主内部产出的 item descriptor：

```ts
{ kind: "native", surfaceKey: "document-html", title: "HTML 预览",
  context: { handleId, sourceKind: "html-draft",
    stableIdentity: "html-draft:<agentKey>:<chatId>:<sha256>",
    displayUrl: "", fileName: "code-preview-….html", mimeType: "text/html",
    sizeBytes, revision: <sha256>, localOriginal: false } }
```

### 5.4 数据流

```
MarkdownCode(点击预览)
  → buildHtmlDraftPreview：算 sha256、命名、检查 4 MiB
  → DesktopWorkPanelTransport.openHtmlDraft（先查 getCapabilities）
  → workpanel bridge → workpanel-invoke（capability + ownerChat + 结构校验）
  → ipc-platform-frame.openDocument（跳过图片 registry）
  → document-html.prepareClaim（校验摘要、写 temp、claim）
  → renderer action desktop.workpanel.openDocumentHtml
  → WorkPanelHost: claim → openItem(native/document-html) → 标签激活
  → WorkPanelDocumentHtml：documentHtml.preview → 独立 partition WebView
      → zenmind-document-html 协议只读该草稿自身
```

## 6. 安全与不变量

1. 草稿只存在于 Main 的 `os.tmpdir()/zenmind-html-draft-*`，文件 `0o600`；不写入 chats/workspace，不产生 Platform 请求。
2. 文件名单段、无 `..`/分隔符/控制字符；`isHtmlDraftName` 在 Main 与共享层各校验一次。
3. 摘要不符、超大、空正文、非法名字一律 fail closed，不做“尽力预览”。
4. 协议范围：草稿只允许读取自身 `semanticPath`；相对资源（`../x`、编码穿越、兄弟文件）返回 403/404。
5. 隔离边界沿用现有 HTML Surface：独立 partition、无权限、禁下载、禁弹窗、无 Desktop preload，允许 scheme 维持现状（`http/https/ws/wss/data/blob/zenmind-document-html`）。
6. `localOriginal === false`：不显示地址、不复制路径、不定位、不用默认应用/浏览器打开、不另存。
7. `document.commit` 对草稿返回失败；`fileAction` 对草稿返回失败（菜单也不展示）。
8. 批注只保存 selector/XPath/坐标/脱敏摘要；无法重定位时按现有机制失效。
9. 旧宿主不宣告能力时，WebClient 不发送草稿；WebClient 不因为失败而把 HTML 上传到任何服务。

## 7. 生命周期与清理

| 事件 | 行为 |
| --- | --- |
| 首次打开 | `prepareClaim` 写临时目录；`claim` 建 handle（`stableIdentity = html-draft:<agent>:<chat>:<sha256>`） |
| 相同内容再次打开 | `claim` 按 source 全等复用 handle（同一 handleId），删除旧临时文件、写入新副本；item stableKey 不变→激活原标签并替换 descriptor |
| WebClient 重载（renderer generation 变化） | 草稿的复用判定**忽略 generation**，复用 handle 并更新 `rendererGeneration`，避免每次重载泄漏一个临时目录；旧 generation 的请求随后按既有 `ownedHandle` 规则失败 |
| 关闭标签 | `release` → 释放 preview session + 删除整个临时目录 |
| renderer 销毁 / 应用退出 | 既有 `observeSender` 与 `before-quit` 回收全部 handle、claim 与临时目录 |
| 打开失败 | `discardPreparedClaim` 删除本次临时目录 |

决策：stableKey 由内容摘要决定，因此“同内容=同标签、改内容=新标签”；旧标签是历史快照，关闭前一直可用（每个打开标签最多占 4 MiB 临时文件与一份 source 内存副本，可接受）。

## 8. 实施变更（按子系统）

### 8.1 Desktop 契约与共享层

| 文件 | 变更 |
| --- | --- |
| `src/shared/contracts/agent-webclient-bridge.ts` | 第 570 行 source 联合增加 `html-draft`；第 629 行 capability 增加 `workpanel.document.open-draft-html`；新增两个常量（5.1） |
| `contracts/agent-webclient/agent-webclient-bridge.ts` | 运行 `node scripts/generate-agent-webclient-contract.mjs` 重新生成（含新 sha256 头） |
| `src/shared/work-panel-document-html.ts` | 删除本地重复的 `WorkPanelDocumentSource` 定义，改为从 bridge 契约 import/export，避免四值枚举第二份漂移 |
| `src/shared/work-panel-document-source.ts` | 新增 `isHtmlDraftName()`；`normalizeWorkPanelDocumentSource` 增加 `html-draft` 分支：精确键集 `kind,agentKey,chatId,name,sha256,html`，名字/摘要格式校验，正文非空且 ≤ 4 Mi 字符；其余分支不变 |
| `src/shared/work-panel.ts` | `normalizeDescriptor` 的 `document-html` 分支（307-360）：`sourceKind` 白名单加 `html-draft`；草稿要求 `displayUrl === ""` 且 `localOriginal === false`，跳过地址前缀校验；`stableKey` 仍是 `stableIdentity`；`WorkPanelFileAddressSource` 保持三值（草稿没有地址） |
| `src/shared/work-panel-review.ts` | `WorkPanelReviewSourceKind` 增加 `html-draft`；`buildWorkPanelReviewComposerDraft` 的 HTML 分支增加草稿文案：“这是聊天消息里 HTML 代码块的临时预览，不属于 workspace 文件或资源；请直接修改对话中对应的代码块，不要新建文件、资源或 Artifact。” |
| `src/shared/chat-work-panel-tab-context-menu.ts` | `nativeHtml?: { localOriginal: boolean; draft?: boolean }` |

### 8.2 Desktop Main

| 文件 | 变更 |
| --- | --- |
| `src/main/modules/agent-platform/frame-port/workpanel-invoke.ts` | 计算 `canOpenNativeDocuments`；能力数组增加 `html-draft` 能力（`ownerChatId` 非空）；`openDocument` 在 `workspace-file` 之后增加 `html-draft` 分支：能力检查 → `normalizeWorkPanelDocumentSource` → `chatId === ownerChatId` → `deps.options.openDocument({ ownerChatId, document: { source, title } })` |
| `src/main/app/ipc-platform-frame.ts` | 把现有 HTML claim + `callRendererAction` 抽成 `openHtmlPreview(source)`；`source.kind === "html-draft"` 时直接调用（不进入图片 registry，图片 registry 的 profile 类型不含草稿） |
| `src/main/modules/work-panel/document-html.ts` | `sourcePath` 支持 `name`；新增 `resolveHtmlDraftSource`（`isHtmlDraftName` → UTF-8 字节 ≤ 4 MiB → 重算 sha256 比对 → `mkdtemp` + `0o600` 写入 → `{ filePath, temporary: true, revision: sha256, semanticPath: name, authorityRoot: "" }`）；`resolveSource` 首分支接草稿；`stableIdentity` 增加 `html-draft:<agent>:<chat>:<sha256>`；`selection()` 对草稿返回空 `displayUrl`；`commit`/`fileAction` 对草稿显式失败；`claim` 的复用判定对草稿忽略 `rendererGeneration` 并更新之 |
| `src/main/modules/work-panel/document-html-preview.ts` | `resourcePrefix` 对草稿返回 `""`；`isDocumentResourcePath` 对草稿只接受 `semanticPath === document.semanticPath`；`resolveDocumentLocalPath` 的 temporary 分支已满足 |
| `src/main/modules/work-panel/document-local-reader.ts` / `document-local-open.ts` | 类型收窄：reader 对草稿抛错（草稿不是本地文件）；open 的文件名与去重键增加草稿分支。运行期草稿不会到达这两处，只保证类型与误用安全 |
| `src/preload/service-webview-main-world.ts` | 无改动（`openDocument` 已透传，校验在 Main） |

### 8.3 Desktop Renderer

| 文件 | 变更 |
| --- | --- |
| `src/renderer/work-panel/WorkPanelDocumentHtml.tsx` | 工具条：草稿渲染 `FileTextOutlined` + 文件名（无地址输入框/不可复制），其余按钮照旧；地址分支保持 |
| `src/renderer/work-panel/WorkPanelHost.tsx` | Tab 右键 popup 增加 `nativeHtml.draft`；`handoffNativeHtmlReview` 的 `sourceKind` 联合加入 `html-draft`；`tabContextMenuProfile` 保持 default |
| `src/main/modules/work-panel/tab-context-menu-ipc.ts` | 校验 `nativeHtml.draft`；草稿时交叉环境组只保留“复制文件名”（不提供下载/默认应用/浏览器/定位） |
| `src/renderer/styles/app-shell.css` | `.work-panel-document-html-location.is-draft` 虚线边框；`> span` 省略号样式 |
| Desktop i18n | 不新增文案（复用已有菜单与错误文案） |

### 8.4 Agent WebClient

| 文件 | 变更 |
| --- | --- |
| `src/shared/contracts/generated/agentWebclientBridge.ts` | 用 Desktop 生成的 mirror 覆盖 |
| `scripts/check-agent-webclient-contract.js` | 更新 `expectedMirrorHash` 为新的 vendored 文件 sha256 |
| `src/features/transport/lib/desktopWorkPanelTransport.ts` | `WorkPanelTransport` 增加 `openHtmlDraft(input): Promise<WorkPanelOpenDocumentResult \| null>`；`HtmlDraftPreviewRequest` 类型；实现先 `getCapabilities()`，缺少能力返回 `null`（调用方回落），否则 `bridge.openDocument({ version: 6, source: { kind: "html-draft", … } })` |
| `src/features/viewers/lib/htmlDraftPreview.ts`（新增） | `sha256Hex`（`crypto.subtle`，不可用抛错）、`htmlDraftPreviewName`（`code-preview-<sha12>.html`）、`buildHtmlDraftPreview`（上下文/大小/摘要校验，返回 `{ok:true,target}` 或 `{ok:false,reason:"invalid-context"\|"too-large"\|"hash-unavailable"}`） |
| `src/features/viewers/components/MarkdownCode.tsx` | 把现有 blob 逻辑抽成 `openBlobPreview()`；新增 `openPreview()`：Desktop + transport + chatId 时先 `buildHtmlDraftPreview` 再 `openHtmlDraft`，成功即返回；`null`/`unsupported_native_type` 静默回落；其它 `ok:false` 先 `message.error` 再回落；`too-large` 先 `message.warning` 再回落；`previewPending` 期间按钮 loading 并忽略重复点击；agentKey 按 `currentRunAgentKey → chatAgentById → chat.agentKey → firstAgentKey` 解析 |
| `src/features/viewers/lib/desktopDocumentOpen.ts` | `desktopDocumentSourceKey` 增加 `html-draft` 分支（`kind,agentKey,chatId,name,sha256`） |
| `src/shared/i18n/locales/{zh-CN,en-US}.ts` | 新增 `markdown.previewDesktopFailed`、`markdown.previewTooLarge`（含 `{limitMiB}`） |

### 8.5 文档与回归清单

- `zenmind-desktop/docs/统一文档与WorkPanel.md`：来源表增加“Ephemeral HTML Draft”行；原生安全边界段落补充草稿的临时缓存、无地址、不可保存/定位、批注交接语义；Tab 文件操作段落说明草稿只有复制文件名。
- `zenmind-desktop/docs/架构与模块边界.md`：第 117 行附近的 HTML 文档不变量补一句草稿来源规则。
- `zenmind-desktop/qa/manual-regression.md`：新增一条手工用例（见 10.2）。
- `agent-webclient/docs/33-运行时间线-Artifact发布与资源预览.md`：说明 Desktop 中 HTML 代码块预览走 WorkPanel 草稿，Web 仍为 blob 右侧栏。
- `agent-webclient/docs/81-宿主集成-Desktop宿主桥接.md`：补充新 capability 与旧宿主降级规则。

### 8.6 测试

| 仓库 | 文件 | 覆盖 |
| --- | --- | --- |
| Desktop | `test/workpanel-html-draft.test.mjs`（新增） | 草稿 claim 得到空地址/`localOriginal:false`/摘要 revision/稳定身份；协议只服务自身且拒绝兄弟与穿越；`commit`/`fileAction` 拒绝；非法摘要/名字/超大/跨 Chat 拒绝；`reduceWorkPanelCommand` 接受草稿 descriptor 且拒绝伪造地址或 `localOriginal:true`；相同内容复用 handle、释放后预览失败 |
| Desktop | `test/agent-webclient-bridge-handlers.test.mjs` | 主聊天宣告草稿能力并成功 `openDocument`；跨 Chat/非法名字/空正文/多余键/摘要格式错误被拒；文档子 Surface、新会话草稿 Chat、其它次级 Surface 不宣告能力 |
| Desktop | `test/agent-webclient-contract.test.mjs` | canonical 含 `kind: "html-draft"`、新 capability、4 MiB 常量；mirror 确定性检查 |
| WebClient | `src/features/viewers/lib/htmlDraftPreview.test.ts`（新增） | 命名确定性、摘要正确、上下文缺失、超限、无 SHA-256 |
| WebClient | `src/features/viewers/components/MarkdownCode.preview.test.tsx`（新增） | Desktop 成功走 WorkPanel 且不 dispatch 侧栏；无能力时静默回落；`capability_denied` 提示并回落；Web 模式不调用 Desktop；超限提示并回落；重复点击只发一次 |
| WebClient | 既有 `MarkdownCode.test.ts` / `MarkdownCode.copy.test.tsx` | 回归不受影响（provider 缺省返回 null） |

## 9. 边界与失败矩阵

| 场景 | 期望行为 |
| --- | --- |
| Web / 无 Desktop 桥 | 现有 blob 右侧栏（不变） |
| 旧 Desktop 无能力 | `openHtmlDraft` 返回 `null` → 静默回落 |
| Desktop 有桥但拒绝（`capability_denied`/`target_unavailable`…） | 提示 `markdown.previewDesktopFailed` 后回落 |
| `unsupported_native_type` | 静默回落（宿主明确表示不支持原生打开） |
| 无 chatId / 无 agentKey / 空正文 | 静默回落 |
| HTML > 4 MiB | `markdown.previewTooLarge` 提示后回落 |
| 无 `crypto.subtle` | 静默回落 |
| 历史只读 Chat、新会话草稿 Chat、文档子 Surface | 能力缺失或 `capability_denied` → 提示后回落 |
| 摘要不符/名字非法/文件写入失败 | Main `target_unavailable` → 提示后回落，无临时残留 |
| 重复点击 | 按钮 loading，第二次点击忽略 |
| 关闭标签 | 临时目录删除，再无该 item |
| WebClient 重载 | 同内容复用原 handle 与新 generation，不泄漏临时目录 |
| 草稿内远程资源不可达 | 页面内资源错误，不阻断外层预览；不重试、不代理 |

## 10. 测试计划

### 10.1 自动

Desktop（Node ≥ 22.12，仓库 `engines` 要求；本机 shell 默认 Node 16，需切 nvm v22）：

```
npm run agent-webclient-contract:check
npm run architecture:check
npm run i18n:keys
npm run build:main:prepared      # tsc + esbuild；测试读取 dist-electron
node --test test/workpanel-html-draft.test.mjs test/agent-webclient-bridge-handlers.test.mjs \
  test/agent-webclient-contract.test.mjs test/chat-work-panel-document-html.test.mjs \
  test/document-html-security.test.mjs test/work-panel-html-lifecycle.test.mjs \
  test/chat-work-panel-tab-context-menu.test.mjs test/work-panel-document-path.test.mjs
```

WebClient：

```
npm run check:desktop-contract
npm run check:i18n
npm run check:boundaries
npx tsc --noEmit -p tsconfig.json
node ./node_modules/jest/bin/jest.js --watchman=false   # 全量单测
```

发布前合并执行 `npm run test:unit`（Desktop）与全量 jest。

### 10.2 手工（macOS 与 Windows 各一遍）

1. 新 Chat 发一条含 `<h1>` 与远程图片的 HTML 代码块，点击预览：WorkPanel 打开“HTML 预览”标签，内容与代码块一致，远程图片按网络规则加载。
2. 再次点击同一代码块：激活原标签、不新增标签。
3. 修改代码块内容（或换一段 HTML）再预览：新标签，旧标签仍可刷新显示原内容。
4. 右键标签：只有刷新/全屏/批注/复制文件名/关闭；依次验证关闭后 `os.tmpdir()` 无 `zenmind-html-draft-*` 残留。
5. 进入批注模式标注一个元素并“交给智能体”：composer 出现草稿文本，明确要求改代码块而非新建资源；随后修改代码块并重新预览。
6. WebClient 重载（开发态 HMR 或刷新）：标签保持可用，`os.tmpdir()` 不新增残留目录。
7. 新建会话草稿 Chat（`newChat`）中预览：回落右侧栏；历史只读 Chat 中同样回落。
8. 关闭 WorkPanel 标签、关闭主窗口、退出应用后复查临时目录清理。
9. 旧版 Desktop（未含本次契约）配合新 WebClient：点击预览回落右侧栏，无报错崩溃。
10. 浏览器访问 WebClient（非 Desktop）：行为与此前完全一致。

## 11. 发布、回滚与风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 契约镜像/vendored 副本不同步 | Desktop 或 WebClient 启动/检查失败 | 按 8.1/8.4 顺序生成并更新哈希；两端 `check` 必须同批通过 |
| Program Bundle 与 Desktop 分开发布 | 旧宿主缺能力或新宿主多能力 | 能力探测在前；旧宿主静默回落；不以版本号兜底 |
| 4 MiB × 多个打开标签 | 内存与临时盘占用 | 上限固定；关闭即释放；文档写明容量边界 |
| 草稿内远程资源 | 隐私/网络行为与 Reference HTML 一致 | 沿用现有隔离 session 的 Chromium 规则，不新增代理或放宽 |
| 同标题多标签 | 用户难以区分 | 标签显示文件名；后续可加内容后缀，不影响契约 |
| 复用忽略 generation | 旧 generation 迟到请求 | 复用后更新 generation，旧请求按 `ownedHandle` 失败；不缓存旧结果 |
| Windows 临时目录/文件权限 | 清理失败或残留 | `mkdtemp`+`fs.rm` 递归删除；失败仅记录，不阻断预览；手工回归覆盖 |
| 测试环境 Node 版本 | `playwright-core` 加载失败（本次已遇到） | 文档与脚本说明使用 Node ≥ 22.12 |

回滚：仅需回退 WebClient 的按钮改动（回到 blob 右侧栏）即可让功能消失；Desktop 侧新增能力与草稿来源在无调用方时是惰性代码，可随下一版本整体回退契约与 mirror。

## 12. 假设与明确不做的判断

1. 目标宿主是 Desktop ≥ 本次版本；WebClient 不假设能力一定存在。
2. 代码块预览属于“临时查看”，不要求用户可保存、分享或回放；因此不做草稿持久化。
3. 不新增 WorkPanel Surface、不做源码编辑、不改 `WorkPanelFileAddressSource`。
4. 保持桥版本 6；若发布评审要求显式版本号，必须同时更新 `workpanel-invoke` 的版本门与两端发布说明，本计划不默认启动该改动。
5. Desktop 不新增 i18n 文案；WebClient 新增两条。
6. 批准后只先落盘计划书，不自动开始编码（编码按第 13 节单独确认后执行）。

## 13. 实施顺序与交付物

0. **本计划书**：写入 `zenmind-desktop/plans/html-draft-workpanel-preview.md`（先完成，不改代码）。
1. 契约：canonical 增常量/source/capability → 生成 mirror → 覆盖 WebClient vendored 副本 → 更新 `expectedMirrorHash` → 两端契约检查通过。
2. Desktop 共享层：类型去重、归一化、descriptor、review、Tab 菜单类型。
3. Desktop Main：invoke 校验与能力、bridge 接线、registry 草稿解析、preview 范围、local reader/open 收窄。
4. Desktop Renderer：工具条、Tab 菜单、批注交接、样式。
5. Agent WebClient：transport、`htmlDraftPreview`、`MarkdownCode` 流程、i18n、source key。
6. 测试：先 Desktop 单测（`build:main:prepared` + targeted `node --test`），再 WebClient 单测与全量检查。
7. 文档与手工回归清单更新；按 10.2 在 macOS、Windows 验收。

完成定义：第 3 节 8 条验收标准全部满足；两端自动检查全绿；计划书与代码同一批次提交（提交说明需写清契约、能力、降级与验证结果）。
