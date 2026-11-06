# WebClient 与 Desktop 统一导出/保存文件交互改造计划（方案 A）

> 状态：已批准，待实施。
> 核对日期：2026-11-06。基线：`agent-webclient@a3649075`、`zenmind-desktop@c97b4724`（工作区均已恢复干净）。

## 1. 目标与成功标准

### 1.1 目标

所有用户主动触发的“导出/保存文件”交互统一为同一生命周期：

1. 内容准备好后，Desktop 先弹出系统保存对话框。
2. 用户确认后才写入文件；取消不写文件。
3. 页面等待明确的 `saved / canceled / failed` 结果。
4. 只有真正保存成功后显示成功提示；取消不显示成功；失败显示错误。
5. 不再用 `<a download>` 的“已开始下载”冒充“已保存完成”。
6. 后续新增导出/保存功能必须复用同一套 helper 和契约，不得再各自实现 `anchor.click()`。

### 1.2 成功标准

- Desktop 内嵌 WebClient 的历史对话/当前对话导出 Markdown 与静态 HTML：弹保存框期间无成功提示；确认后写入所选路径并提示成功；取消后无文件、无成功提示。
- Desktop 原生历史对话导出 Markdown/HTML、二维码保存也遵循同一流程。
- Standalone 浏览器仍走浏览器下载，但只显示“已开始下载”，不宣称文件已保存到磁盘。
- 所有现有 WebClient 下载入口（资源附件、技能包、知识库源文件）统一走新 helper。
- 新增静态检查阻止绕过 helper 的 `<a download>`。

## 2. 现状与根因

当前 WebClient 导出链路：

`HistoryModal` / `ChatActionsMenu` → `useChatOperations.exportChat()` → `downloadChatExport()` / `downloadConversationHtmlExport()` → 取回 Blob → `triggerBrowserDownload()`（`resources.ts:185` 创建 `<a download>` 并 `click()`）

`anchor.click()` 同步返回，只代表浏览器开始下载。Desktop 的默认下载行为会弹原生保存框，但页面拿不到“确认/取消/写盘完成”的结果，因此 `HistoryModal.tsx:402` 和 `ChatActionsMenu.tsx:120` 会在保存框尚未关闭时立即执行成功提示。

现有可复用能力：

- Desktop 已有 `desktop:download:file` service webview 消息（`zenmind-desktop/src/shared/service-webview-bridge.ts:27`），渲染层由 `serviceWebviewBridgeHost.ts:371` 处理，主进程由 `shell/ipc.ts:696` 的 `desktopDownloads.saveFile` 写入 Downloads。
- 该能力目前只支持直接写下载目录，不能等待系统保存框结果；WebClient 也没有使用它。
- Desktop 原生对话导出（`assistant/ipc.ts:84`、`conversation-share/html-export.ts:9`）和二维码保存（`ConversationShareQrDialog.tsx:92`）同样直接写 Downloads，没有保存框结果语义。

## 3. 统一交互规范

### 3.1 状态机

```text
idle
  -> saving（禁用重复操作，显示保存中）
  -> dialog-open（Desktop：系统保存框）
  -> saved（写入成功，显示成功）
  -> canceled（不写文件，不显示成功）
  -> failed（显示错误）
Standalone: idle -> started（浏览器开始下载，不宣称完成）
```

### 3.2 交互规则

- Desktop 必须使用系统保存对话框，默认目录为 Downloads，默认文件名由内容声明的文件名决定；同名时默认建议 `name (1).ext`，不静默覆盖。
- 保存框打开期间保持 pending，禁止重复点击同一入口。
- 取消：无文件、无错误提示、无成功提示；清除 pending，可再次操作。
- 成功：写入完成后显示“已导出/已保存”；需要时可显示实际路径。
- 失败：显示具体失败原因；不得显示成功。
- Standalone：浏览器下载无法获得完成结果，统一返回 `started`，文案使用“已开始下载”，不使用“已导出到下载目录”。
- 所有新功能必须通过统一 helper；不允许在 feature 组件内直接创建 anchor 下载。

## 4. 协议与类型

### 4.1 复用并扩展现有 bridge

继续使用 `desktop:download:file`，不新增请求类型，避免版本升级：

```ts
// 请求（WebClient -> Desktop）
{
  type: "desktop:download:file";
  requestId: string;
  filename: string;
  mimeType?: string;
  dataBase64: string;
  saveAs?: boolean;   // true：系统保存对话框；缺省保持旧行为直接写 Downloads
}

// 响应（Desktop -> WebClient）
{
  type: "desktop:download:file:response";
  requestId: string;
  ok: boolean;
  cancelled?: boolean;
  path?: string;
  message?: string;
}
```

兼容策略：

- `saveAs` 缺省为 false，旧调用方（二维码等）行为不变。
- 新 WebClient helper 始终发送 `saveAs: true`。
- 旧 Desktop 忽略 `saveAs` 时仍会写 Downloads，且只有写盘后才返回，因此页面不会提前提示成功；升级 Desktop 后自动获得保存框。

### 4.2 WebClient 统一结果类型

新增 `agent-webclient/src/shared/data/saveFile.ts`：

```ts
export type SaveFileOutcome =
  | { status: "saved"; path?: string }
  | { status: "started"; transport: "browser" }
  | { status: "canceled" };

export const MAX_DESKTOP_SAVE_BYTES = 64 * 1024 * 1024;
export function saveBlob(
  blob: Blob,
  options: { filename: string; mimeType?: string; signal?: AbortSignal }
): Promise<SaveFileOutcome>;
```

规则：

- Desktop 模式且 `blob.size <= MAX_DESKTOP_SAVE_BYTES`：走 bridge 保存框，返回 `saved`/`canceled`，失败抛错。
- Desktop 模式且超过上限：回退浏览器下载，返回 `started`，不宣称保存完成；后续再设计分块 streaming（本计划不实现）。
- Standalone：浏览器下载，返回 `started`。
- 统一做文件名去空、长度限制、非法字符处理；空文件名拒绝。
- bridge 请求设置 30 分钟超时；超时抛错，页面显示导出失败。
- 响应必须校验 `type`、`requestId`、`ok`、`cancelled`、`path`；只接受可信宿主消息源。

## 5. 分层实现

### 5.1 Desktop 主进程：统一保存 helper

新增 `zenmind-desktop/src/main/infrastructure/filesystem/save-file.ts`：

```ts
export type SaveFileWithDialogResult =
  | { status: "saved"; path: string }
  | { status: "canceled" };

export async function saveFileWithDialog(options: {
  bytes: Uint8Array;
  defaultPath: string;                 // 调用方决定 Downloads/导出目录
  platform?: NodeJS.Platform | string;
  showSaveDialog: (options: Electron.SaveDialogOptions, owner?: BrowserWindow | null) => Promise<Electron.SaveDialogReturnValue>;
  ownerWindow?: BrowserWindow | null;
  title?: string;
  filters?: Electron.FileFilter[];
  fsAccess?: ...; fsMkdir?: ...; fsWriteFile?: ...; fsRename?: ...; fsUnlink?: ...;
}): Promise<SaveFileWithDialogResult>;
```

职责：

- 使用 `sanitizeDownloadFilename` 清洗文件名，使用 `getAvailableFilePath` 生成不覆盖的默认路径。
- 只通过 `showSaveDialog` 获取目标路径，不接受调用方或页面传入绝对路径。
- 用户取消直接返回 `canceled`，不创建目录、不写文件。
- 确认后创建目录，先写同目录临时文件，再 `rename` 原子替换；失败清理临时文件并抛错。
- Windows/macOS 路径分别使用 `getPlatformPath`/`path.win32|posix`，显式处理平台差异。

重构 `desktopDownloads.saveFile`（`shell/ipc.ts:696`）：

- 输入增加 `saveAs?: boolean`。
- `saveAs === true`：调用 `saveFileWithDialog`，成功返回 `{ ok: true, path }`，取消返回 `{ ok: false, cancelled: true, path: "", message: "" }`，失败返回 `{ ok: false, message }`。
- `saveAs !== true`：保留当前直接写 Downloads 的兼容行为。
- 增加 payload 校验：`filename` 长度/类型、`dataBase64` 合法性与解码后大小上限；超过上限返回稳定错误。
- 在 `ShellIpcOptions` 与 `ipc-shell-workpanel.ts` 注入 `showSaveDialog`。

扩展类型：

- `zenmind-desktop/src/shared/contracts/desktop-api.ts:985`：`saveAs?: boolean`，返回值增加 `cancelled?: boolean`。
- `zenmind-desktop/src/shared/service-webview-bridge.ts`：消息增加 `saveAs?: boolean`。
- `serviceWebviewBridgeHost.ts`：转发 `saveAs`，响应回传 `cancelled`。

### 5.2 WebClient：统一 helper 与下载入口迁移

新增：

- `agent-webclient/src/shared/data/desktop/desktopSaveFile.ts`：低层 bridge 请求/响应、`canUseDesktopSaveFile()`、`saveBlobViaDesktop()`，复用现有 `desktopHostBridge` 的 postMessage/来源校验模式。
- `agent-webclient/src/shared/data/saveFile.ts`：环境选择、浏览器回退、`SaveFileOutcome`、`saveBlob()`；把 `triggerBrowserDownload` 从 `resources.ts` 移入此文件。

迁移 `agent-webclient/src/shared/data/api/resources.ts`：

- `downloadResource`、`downloadChatExport`、`downloadConversationHtmlExport`、`downloadAdminSkill`、`downloadAdminSkillFile`、`readAdminSkillDownload` 全部改为调用 `saveBlob`，返回 `Promise<SaveFileOutcome>`。
- 保留现有响应校验、文件名解析、HTML 组装逻辑，只替换最后一步下载。

迁移调用方：

- `useChatOperations.exportChat` 返回 `SaveFileOutcome`。
- `HistoryModal`、`ChatActionsMenu`：`canceled` 直接返回；`saved` 显示“已导出”；`started` 显示“已开始下载”；失败显示错误。
- `SkillConsole`：取消不报错；失败继续显示现有错误提示。
- `KnowledgeSourceRead`：移除第 22 行的临时 anchor，新增 `savePublishedKnowledge()`（`kbases.ts`）或直接调用 `saveBlob`，取消不报错。
- `artifactResourceRuntime`、`viewerRuntime`、`MarkdownContent` 等调用方适配新返回类型；没有成功提示的入口保持静默。

新增静态检查：

- `agent-webclient/src/shared/data/saveFile.boundaries.test.ts` 扫描 `src/**/*.{ts,tsx}`，除 `saveFile.ts` 与测试外禁止出现 `document.createElement("a")`、`anchor.download`、`triggerBrowserDownload`。
- 该测试随 `npm run test:unit` 执行，保证后续新增导出不再绕过 helper。

### 5.3 Desktop 原生导出与二维码保存对齐

Desktop 原生入口也迁移到同一流程，避免“WebClient 有保存框、原生入口没有”的双标准：

- `assistant.exportChat`（`assistant/ipc.ts:84`）：取回 Markdown 后调用 `saveFileWithDialog`；取消返回 `{ ok: false, cancelled: true }`；成功返回 `filePath`。
- `assistant.exportChatHtml`（`conversation-share/html-export.ts:9`）：HTML 渲染完成后调用同一 helper。
- `assistant.exportChatHtml` 的保存端口通过 `registerAssistantIpcHandlers` 注入，避免修改 `app-ready` 的组合根；`ConversationShareFacade.exportChatHtml` 增加可选的保存端口参数。
- `AssistantNavActionResult` 增加 `cancelled?: boolean`；`ChatHistoryDialog`、`AppSidebar`、`ChatHistoryDialog` 的反馈逻辑在 `cancelled` 时不显示成功或错误。
- `ConversationShareQrDialog`（`:92`）调用 `desktopDownloads.saveFile({ ..., saveAs: true })`；`cancelled` 时不显示“已保存”，`!ok` 时显示失败。
- 已使用保存框的 `resource-images.saveCopy`、`document-html-file-actions`、`artifacts.actions` 保持现状；它们已满足“先选择路径、后写盘”，本次只补充取消结果语义的统一说明，不做大范围重构。

## 6. 迁移清单

| 入口 | 现状 | 目标 |
| --- | --- | --- |
| WebClient 历史对话 Markdown 导出 | `<a download>`，提前成功 | `saveBlob` → 保存框 → 成功/取消/失败 |
| WebClient 历史对话静态 HTML 导出 | 同上 | 同上 |
| WebClient 当前对话菜单导出 | 同上 | 同上 |
| WebClient 资源附件下载 | `<a download>` | `saveBlob`，大文件回退 browser + `started` |
| WebClient 技能包/技能文件下载 | `<a download>` | `saveBlob`，取消不报错 |
| WebClient 知识库源文件下载 | 组件内手写 anchor | `saveBlob` |
| Desktop 原生历史对话 Markdown/HTML | 直接写 Downloads | `saveFileWithDialog`，取消无成功 |
| Desktop 二维码保存 | 直接写 Downloads | `saveAs` 保存框，取消无成功 |
| Desktop 图片/HTML 文档/Artifact 保存 | 已弹保存框 | 保持；统一取消结果类型（后续小步） |

## 7. 边界、失败与大文件

- 不修改 Agent Platform、Tunnel 或 canonical `agent-webclient-bridge.ts`；只扩展 Desktop 内部 service webview 消息。
- 页面永远不能提交绝对保存路径；路径只来自系统对话框。
- 文件名、扩展名、MIME 只用于建议名和过滤器，不作为权限依据。
- `dataBase64` 必须校验长度、字符集和解码后大小；主进程再次限制最大字节数。
- 取消不是错误；不写文件、不显示成功。
- 大文件：本次统一流程覆盖 ≤ 64 MiB；超过上限回退浏览器下载并返回 `started`，避免 base64/IPC 内存峰值。若产品要求所有大文件也走保存框，需追加分块 `begin/chunk/end` streaming 协议，列为后续阶段，不在本次实现。
- 并发保存：通过 `requestId` 关联；若同时触发多个保存，主进程按现有原生对话框控制器串行处理，避免叠框。

## 8. 测试与验收

### 8.1 单元测试

- WebClient `desktopSaveFile`：成功、取消、失败、超时、非法响应、非 Desktop 不可用。
- WebClient `saveBlob`：Desktop 走 bridge；Standalone 走 anchor；超 64 MiB 回退 browser。
- `resources.requests.test.ts`：Markdown/HTML/资源/技能在 Desktop 分支与 Standalone 分支分别返回正确 outcome；取消不触发 anchor。
- `HistoryModal.test.ts` / `ChatActionsMenu.test.ts`：取消无成功提示；成功提示；失败错误；pending 防重复。
- `SkillConsole` / `KnowledgeSourceRead`：取消不报错，失败提示。
- Desktop `save-file-with-dialog`：默认路径避让、取消不写、成功原子写、写失败清理临时文件、Windows/macOS 路径。
- Desktop `desktopDownloads.saveFile`：`saveAs` 取消/成功/失败；旧无 `saveAs` 行为不变。
- Desktop 原生导出：取消结果 `cancelled`，renderer 不显示成功。
- 静态检查：禁止绕过 helper 的 anchor 下载。

### 8.2 构建与检查

- `agent-webclient`：`npm run typecheck`、`check:boundaries`、`check:i18n`、`check:desktop-contract`、`test:unit`、`npm run build`。
- `zenmind-desktop`：`build:main:types`、`typecheck:renderer`、`architecture:check`、`i18n:check`、相关 `node --test`、`build`。
- 桌面契约回归：`agent-webclient-contract:check`、`desktop-api` 类型检查。

### 8.3 手工验收

- CuteJ 与 ZenMind、macOS 与 Windows。
- WebClient 历史/当前对话的 Markdown/HTML 导出：弹框期间无成功；取消无文件无提示；确认后文件写入所选路径；重复导出默认建议新文件名。
- Desktop 原生历史导出、二维码保存同样验证。
- Standalone 浏览器导出仍可用，文案为“已开始下载”。
- 资源附件、技能包、知识库源文件下载不因改造失败。

## 9. 发布与兼容

- `service-webview-bridge` 只增加可选字段，不升级 canonical bridge 版本；WebClient bundle 与 Desktop 必须同批发布。
- 发布顺序：Desktop main/preload 与 WebClient bundle 同步打包；旧的 WebClient 仍走 anchor，不会因新 Desktop 失效；新的 WebClient 遇到旧 Desktop 会退化为直接写 Downloads，但仍等待真实写盘结果，不会提前提示成功。
- WebClient 改动必须重新打包并同步内置资源；只重启应用不同步无效，只同步不重启无效。联调时按 `webclient-desktop-integration` 的 sync + 重启 agent-webclient 流程执行，删除/重建 `dist/release` 前需用户确认。
- 不手工修改 `build/resources` 或安装目录。

## 10. 实施顺序与交付物

1. 将本计划写入 `zenmind-desktop/plans/webclient-save-file-flow.md`，记录日期、基线 commit、状态。
2. Desktop：新增 `saveFileWithDialog`；扩展 `desktopDownloads.saveFile`、bridge host、desktop-api、service-webview-bridge；补测试。
3. WebClient：新增 `desktopSaveFile.ts`、`saveFile.ts`；迁移 `resources.ts` 与所有下载调用方；补测试和静态边界测试。
4. Desktop 原生导出/二维码对齐；更新 `AssistantNavActionResult` 与 renderer 反馈。
5. 更新文档：`agent-webclient/docs/81-宿主集成-Desktop宿主桥接.md`、`zenmind-desktop/docs/前端嵌入与导航.md`、`zenmind-desktop/docs/对话快照分享与导出.md`、`zenmind-desktop/qa/manual-regression.md`。
6. 运行第 8 节检查；按用户确认决定是否执行内置资源同步与桌面重启。
7. 提交时按仓库约定拆分 commit（计划/契约、Desktop、WebClient、文档测试），只提交本次相关文件。

## 11. 风险与待确认假设

- **行为变更**：Desktop 原生对话导出和二维码保存从“直接写 Downloads”改为“先弹保存框”；这是方案 A 的必然结果。若只想先覆盖 WebClient，可把 5.3 作为第二阶段，但本计划默认统一覆盖。
- **大文件**：64 MiB 以上仍回退浏览器下载，不保证 native 保存框；若必须全覆盖，需要追加 streaming 协议。
- **旧版本兼容**：旧 Desktop 忽略 `saveAs`，会直接写 Downloads；页面仍等待写盘结果，不会提前成功，但用户看不到保存框。
- **超时**：保存框允许用户长时间停留，helper 超时设为 30 分钟；超时后提示失败，用户可重试。
- **未做真实 GUI 验收**：本计划的验收要求包含 macOS/Windows 手工回归，不能以单测代替。
