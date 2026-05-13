import type {
  AssistantAttachment,
  AssistantChatMessage,
  AssistantPageContext,
  AssistantRunAction
} from "../../shared/contracts";
import { ZENMIND_ASSISTANT_CAPABILITY_PROMPT } from "../../shared/assistant-capabilities";

export type OpenAIToolCall = {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAIChatMessage =
  | {
      role: "system" | "user";
      content: string | OpenAIChatContentPart[];
    }
  | {
      role: "assistant";
      content?: string | OpenAIChatContentPart[] | null;
      tool_calls?: OpenAIToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
    };

export type OpenAIChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type AssistantRuntimeContext = {
  localDateTime: string;
  isoTime: string;
  timeZone: string;
  platform: string;
};

export const MAX_SELECTED_TEXT_LENGTH = 8000;
export const MAX_BODY_TEXT_LENGTH = 40000;
export const MAX_CHAT_BODY_TEXT_LENGTH = 12000;
export const MAX_ATTACHMENT_TEXT_LENGTH = 20000;
export const MAX_MEMORY_TEXT_LENGTH = 12000;
export const MAX_MODAL_TEXT_LENGTH = 12000;
export const MAX_LEFT_REGION_TEXT_LENGTH = 6000;
export const MAX_SHELL_SIDEBAR_TEXT_LENGTH = 2000;
const MAX_HEADING_COUNT = 24;
const MAX_ATTACHMENT_COUNT = 8;
const HISTORY_LIMIT = 12;
const MAX_HISTORY_MESSAGE_LENGTH = 1800;
const MAX_HISTORY_TOTAL_LENGTH = 10000;
const EXPLICIT_PAGE_CONTEXT_PATTERN =
  /(当前页面|这个页面|该页面|本页|页面内容|左侧|左边|网页|浏览器|webview|选中文本|选中内容|current\s+page|web\s*page|browser|left\s+(?:side|pane)|selected\s+text)/iu;

const SYSTEM_PROMPT = [
  ZENMIND_ASSISTANT_CAPABILITY_PROMPT,
  "你可以根据用户消息、历史对话、运行上下文、当前页面内容、网页内容、选中文本和附件摘录回答问题和总结信息。",
  "默认按用户意图回答：当前页面是可用上下文，不是默认回答范围；只有当用户问题指向当前页面、左侧网页、选中文本、附件或浏览器结果时，才引用这些内容。",
  "如果用户说“直接回答”“不用看页面”等表达，请优先按通用知识和运行上下文回答。",
  "如果用户询问当前时间、日期、星期、时区或平台，可基于运行上下文回答，不要因为页面内容没有时间显示而拒答。",
  "当桌面应用提供了受限浏览器操作结果时，你可以围绕这些结果说明已经完成了什么。",
  "长期记忆只是辅助上下文；如果当前用户消息或最近历史对话与长期记忆冲突，必须以当前消息和最近历史为准，不要让旧记忆覆盖用户刚表达的新偏好或新约束。",
  "请区分用户目标、页面上下文、附件上下文和浏览器操作结果；填写表单时根据字段标签推断值，不要把整句用户目标当作单个字段值。",
  "图片、截图和扫描 PDF 页图会先由 MiniMax 图片理解接口转换为附件上下文中的“视觉识别”文本；回答图片问题时基于该文本，不要自行猜测未识别出的内容。",
  "当用户追问“这个文件”“这张图”“刚才上传的 PDF”时，默认引用最近附件上下文，不要改去搜索网页。",
  "只基于用户消息、历史对话、本次提供的运行上下文、页面上下文、附件上下文和工具结果回答；不要声称你读取了未提供的网页、文件、系统或私有数据。",
  "如果用户要求查询网页但没有可操作网页目标或工具结果，请基于当前可见页面说明能回答的部分，并明确当前页面无法直接完成外部查询。",
  "当用户提到“左侧区域”“左边”“左栏”时，优先使用页面上下文中的“应用左导航”和“当前页面左侧区域”结构化内容回答；没有对应内容时要明确说读不到，不要编造成浏览器快捷链接或网站列表。",
  "当页面上下文里存在“前台弹层/模态框内容”时，应把它视为当前页面最优先的可见内容，先回答弹层，再按需补充背景页面。",
  "回答要简洁、清楚、可执行。总结页面时优先给出核心结论、关键事实、待办或风险点。",
  "输出要适合聊天阅读：优先使用短段落和项目符号，少用多级 Markdown 标题；只有在比较结构化数据时才使用表格。",
  "如果页面内容为空、不可读取或信息不足，要明确说明需要用户补充。"
].join("\n");

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateText(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\n...[已截断 ${normalized.length - maxLength} 字符]`;
}

export function normalizePageContext(
  pageContext: AssistantPageContext | null | undefined,
  options: { maxBodyTextLength?: number } = {}
): AssistantPageContext | null {
  if (!pageContext) {
    return null;
  }
  const maxBodyTextLength = options.maxBodyTextLength ?? MAX_BODY_TEXT_LENGTH;
  return {
    url: truncateText(pageContext.url ?? "", 1000),
    title: truncateText(pageContext.title ?? "", 500),
    selectedText: truncateText(pageContext.selectedText ?? "", MAX_SELECTED_TEXT_LENGTH),
    metaDescription: truncateText(pageContext.metaDescription ?? "", 1000),
    headings: Array.isArray(pageContext.headings)
      ? pageContext.headings.map((heading) => truncateText(String(heading ?? ""), 240)).filter(Boolean).slice(0, MAX_HEADING_COUNT)
      : [],
    bodyText: truncateText(pageContext.bodyText ?? "", maxBodyTextLength),
    shellSidebarText: truncateText(pageContext.shellSidebarText ?? "", MAX_SHELL_SIDEBAR_TEXT_LENGTH),
    leftRegionText: truncateText(pageContext.leftRegionText ?? "", MAX_LEFT_REGION_TEXT_LENGTH),
    modalText: truncateText(pageContext.modalText ?? "", Math.min(maxBodyTextLength, MAX_MODAL_TEXT_LENGTH)),
    browserTarget: pageContext.browserTarget
      ? {
          kind: "webview",
          webContentsId: pageContext.browserTarget.webContentsId,
          surfaceId: truncateText(pageContext.browserTarget.surfaceId ?? "", 120),
          surfaceLabel: truncateText(pageContext.browserTarget.surfaceLabel ?? "", 240),
          currentUrl: truncateText(pageContext.browserTarget.currentUrl ?? "", 1000),
          browserSkill: truncateText(pageContext.browserTarget.browserSkill ?? "", 2000)
        }
      : undefined
  };
}

export function createAssistantRuntimeContext(now = new Date()): AssistantRuntimeContext {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const localDateTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);

  return {
    localDateTime,
    isoTime: now.toISOString(),
    timeZone,
    platform: typeof process !== "undefined" ? process.platform : "unknown"
  };
}

export function normalizeAttachments(attachments: AssistantAttachment[] | null | undefined) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.slice(0, MAX_ATTACHMENT_COUNT).map((attachment) => ({
    id: truncateText(attachment.id ?? "", 120),
    name: truncateText(attachment.name ?? "attachment", 240),
    mimeType: truncateText(attachment.mimeType ?? "", 120),
    sizeBytes: Number.isFinite(attachment.sizeBytes) ? attachment.sizeBytes : 0,
    text: truncateText(attachment.text ?? "", MAX_ATTACHMENT_TEXT_LENGTH),
    dataUrl: attachment.dataUrl && attachment.dataUrl.startsWith("data:image/")
      ? attachment.dataUrl
      : "",
    truncated: Boolean(attachment.truncated),
    error: truncateText(attachment.error ?? "", 500),
    document: attachment.document
      ? {
          format: attachment.document.format,
          readStatus: attachment.document.readStatus,
          extractedChars: Number.isFinite(attachment.document.extractedChars) ? attachment.document.extractedChars : 0,
          truncated: Boolean(attachment.document.truncated),
          ...(Number.isFinite(attachment.document.pageCount) ? { pageCount: attachment.document.pageCount } : {}),
          ...(Array.isArray(attachment.document.sheetNames)
            ? { sheetNames: attachment.document.sheetNames.map((sheetName) => truncateText(sheetName, 120)).slice(0, 40) }
            : {}),
	          ...(Number.isFinite(attachment.document.slideCount) ? { slideCount: attachment.document.slideCount } : {}),
	          ...(attachment.document.imageMode === "vision" ? { imageMode: "vision" as const } : {}),
	          ...(attachment.document.errorCode ? { errorCode: truncateText(attachment.document.errorCode, 120) } : {}),
	          ...(attachment.document.visionSummary
	            ? { visionSummary: truncateText(attachment.document.visionSummary, MAX_ATTACHMENT_TEXT_LENGTH) }
	            : {}),
	          ...(attachment.document.visionStatus ? { visionStatus: attachment.document.visionStatus } : {})
	        }
	      : undefined
	  }));
}

function getActionInstruction(action: AssistantRunAction) {
  switch (action) {
    case "summarize_page":
      return "请总结当前页面内容，输出核心结论、关键事实、可能的待办事项。";
    case "explain_selection":
      return "请解释当前选中文本，必要时结合页面上下文说明背景。";
    case "extract_todos":
      return "请从当前页面提炼待办、负责人、时间点和需要跟进的事项。";
    case "chat":
    default:
      return "";
  }
}

function buildPageContextBlock(pageContext: AssistantPageContext | null) {
  if (!pageContext) {
    return "";
  }
  const browserTarget = pageContext.browserTarget;
  const browserTargetText = browserTarget
    ? [
        "左侧浏览器目标：可操作",
        browserTarget.surfaceLabel ? `入口：${browserTarget.surfaceLabel}` : "",
        browserTarget.currentUrl ? `当前地址：${browserTarget.currentUrl}` : ""
      ].filter(Boolean).join("；")
    : "";
  const sections = [
    pageContext.modalText ? `前台弹层/模态框内容：\n${pageContext.modalText}` : "",
    pageContext.shellSidebarText ? `应用左导航：\n${pageContext.shellSidebarText}` : "",
    pageContext.leftRegionText ? `当前页面左侧区域：\n${pageContext.leftRegionText}` : "",
    browserTargetText,
    pageContext.title ? `标题：${pageContext.title}` : "",
    pageContext.url ? `地址：${pageContext.url}` : "",
    pageContext.metaDescription ? `描述：${pageContext.metaDescription}` : "",
    pageContext.headings.length > 0 ? `标题层级：\n${pageContext.headings.map((heading) => `- ${heading}`).join("\n")}` : "",
    pageContext.selectedText ? `选中文本：\n${pageContext.selectedText}` : "",
    pageContext.bodyText ? `页面正文：\n${pageContext.bodyText}` : ""
  ].filter(Boolean);

  return sections.length > 0
    ? `<当前页面上下文>\n${sections.join("\n\n")}\n</当前页面上下文>`
    : "";
}

function buildRuntimeContextBlock(runtimeContext: AssistantRuntimeContext) {
  return [
    "<运行上下文>",
    `本地时间：${runtimeContext.localDateTime}`,
    `ISO 时间：${runtimeContext.isoTime}`,
    `时区：${runtimeContext.timeZone}`,
    `平台：${runtimeContext.platform}`,
    "</运行上下文>"
  ].join("\n");
}

function buildLocalMemoryBlock(memory: string | null | undefined) {
  const normalized = truncateText(memory ?? "", MAX_MEMORY_TEXT_LENGTH);
  return normalized ? `<长期记忆>\n${normalized}\n</长期记忆>` : "";
}

function escapeFileAttribute(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeFileBody(value: string) {
  return value
    .replace(/<\/file>/giu, "<\\/file>")
    .replace(/<file/giu, "< file");
}

function documentMetaLine(attachment: ReturnType<typeof normalizeAttachments>[number]) {
  const document = attachment.document;
  if (!document) {
    return "";
  }
  const details = [
    `format=${document.format}`,
    `status=${document.readStatus}`,
    `extractedChars=${document.extractedChars}`,
    document.truncated ? "truncated=true" : "",
    Number.isFinite(document.pageCount) ? `pages=${document.pageCount}` : "",
    document.sheetNames?.length ? `sheets=${document.sheetNames.join(", ")}` : "",
    Number.isFinite(document.slideCount) ? `slides=${document.slideCount}` : "",
	    document.imageMode ? `imageMode=${document.imageMode}` : "",
	    document.visionStatus ? `visionStatus=${document.visionStatus}` : "",
	    document.errorCode ? `errorCode=${document.errorCode}` : ""
	  ].filter(Boolean);
	  return details.length > 0 ? `文档状态：${details.join("; ")}` : "";
	}

function buildAttachmentContextBlock(attachments: ReturnType<typeof normalizeAttachments>) {
  if (attachments.length === 0) {
    return "";
  }

  const sections = attachments.map((attachment, index) => {
    const document = attachment.document;
    const meta = [
      `附件 ${index + 1}：${attachment.name}`,
      attachment.mimeType ? `类型：${attachment.mimeType}` : "",
      `大小：${attachment.sizeBytes} bytes`,
	      documentMetaLine(attachment),
	      attachment.dataUrl ? "图片：已作为视觉附件发送给模型" : "",
	      document?.visionSummary ? `视觉识别：\n${document.visionSummary}` : "",
	      attachment.truncated ? "内容：以下为截断摘录" : "",
      attachment.error ? `读取说明：${attachment.error}` : "",
      attachment.text ? `内容摘录：\n${attachment.text}` : ""
    ].filter(Boolean);
    const attrs = [
      `name="${escapeFileAttribute(attachment.name)}"`,
      attachment.mimeType ? `mime="${escapeFileAttribute(attachment.mimeType)}"` : "",
      document?.format ? `format="${escapeFileAttribute(document.format)}"` : "",
      document?.readStatus ? `status="${escapeFileAttribute(document.readStatus)}"` : ""
    ].filter(Boolean).join(" ");
    return `<file ${attrs}>\n${escapeFileBody(meta.join("\n"))}\n</file>`;
  });

  return `<附件上下文>\n${sections.join("\n\n")}\n</附件上下文>`;
}

function buildUserGoalBlock(message: string) {
  const normalized = truncateText(message, 4000);
  return normalized ? `<用户目标>\n${normalized}\n</用户目标>` : "";
}

function shouldIncludePageContext(input: {
  action: AssistantRunAction;
  message: string;
  attachments: ReturnType<typeof normalizeAttachments>;
}) {
  if (input.action !== "chat") {
    return true;
  }
  if (input.attachments.length === 0) {
    return true;
  }
  return EXPLICIT_PAGE_CONTEXT_PATTERN.test(input.message);
}

function buildRecentHistory(history: AssistantChatMessage[]) {
  const recent: OpenAIChatMessage[] = [];
  let totalLength = 0;
  for (const item of history.slice(-HISTORY_LIMIT).reverse()) {
    const content = truncateText(item.content, MAX_HISTORY_MESSAGE_LENGTH);
    if (recent.length >= 4 && totalLength + content.length > MAX_HISTORY_TOTAL_LENGTH) {
      break;
    }
    recent.unshift({
      role: item.role,
      content
    });
    totalLength += content.length;
  }
  return recent;
}

export function buildAssistantMessages({
  history,
  message,
  action = "chat",
  pageContext,
  attachments,
  runtimeContext,
  memory
}: {
  history: AssistantChatMessage[];
  message: string;
  action?: AssistantRunAction;
  pageContext?: AssistantPageContext | null;
  attachments?: AssistantAttachment[];
  runtimeContext?: AssistantRuntimeContext;
  memory?: string | null;
}): OpenAIChatMessage[] {
  const normalizedRuntimeContext = runtimeContext ?? createAssistantRuntimeContext();
  const normalizedPageContext = normalizePageContext(pageContext, {
    maxBodyTextLength: action === "chat" ? MAX_CHAT_BODY_TEXT_LENGTH : MAX_BODY_TEXT_LENGTH
  });
  const normalizedAttachments = normalizeAttachments(attachments);
  const actionInstruction = getActionInstruction(action);
  const runtimeContextBlock = buildRuntimeContextBlock(normalizedRuntimeContext);
  const memoryContextBlock = buildLocalMemoryBlock(memory);
  const pageContextBlock = shouldIncludePageContext({
    action,
    message,
    attachments: normalizedAttachments
  })
    ? buildPageContextBlock(normalizedPageContext)
    : "";
  const attachmentContextBlock = buildAttachmentContextBlock(normalizedAttachments);
  const userContent = [
    actionInstruction,
    runtimeContextBlock,
    memoryContextBlock,
    pageContextBlock,
    attachmentContextBlock,
    buildUserGoalBlock(message)
  ].filter(Boolean).join("\n\n");
  const imageParts = normalizedAttachments
    .filter((attachment) => attachment.dataUrl)
    .map((attachment) => ({
      type: "image_url" as const,
      image_url: {
        url: attachment.dataUrl
      }
    }));

  const recentHistory = buildRecentHistory(history);
  const userMessageContent: OpenAIChatMessage["content"] = imageParts.length > 0
    ? [
        {
          type: "text",
          text: userContent
        },
        ...imageParts
      ]
    : userContent;

  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...recentHistory,
    { role: "user", content: userMessageContent }
  ];
}

export const __testInternals = {
  HISTORY_LIMIT,
  MAX_HISTORY_MESSAGE_LENGTH,
  MAX_HISTORY_TOTAL_LENGTH,
  SYSTEM_PROMPT,
  buildAttachmentContextBlock,
  buildLocalMemoryBlock,
  buildRuntimeContextBlock,
  buildRecentHistory,
  buildPageContextBlock,
  buildUserGoalBlock,
  createAssistantRuntimeContext,
  getActionInstruction
};
