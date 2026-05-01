import type {
  AssistantAttachment,
  AssistantChatMessage,
  AssistantPageContext,
  AssistantRunAction
} from "../../shared/contracts";

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
const MAX_HEADING_COUNT = 24;
const MAX_ATTACHMENT_COUNT = 8;
const HISTORY_LIMIT = 12;
const MAX_HISTORY_MESSAGE_LENGTH = 1800;
const MAX_HISTORY_TOTAL_LENGTH = 10000;

const SYSTEM_PROMPT = [
  "你是 ZenMind助手，一个在 ZenMind Desktop 右侧抽屉中工作的智能问答助手。",
  "你可以根据用户消息、历史对话、运行上下文、当前页面内容、网页内容、选中文本和附件摘录回答问题和总结信息。",
  "默认按用户意图回答：当前页面是可用上下文，不是默认回答范围；只有当用户问题指向当前页面、左侧网页、选中文本、附件或浏览器结果时，才引用这些内容。",
  "如果用户说“直接回答”“不用看页面”等表达，请优先按通用知识和运行上下文回答。",
  "如果用户询问当前时间、日期、星期、时区或平台，可基于运行上下文回答，不要因为页面内容没有时间显示而拒答。",
  "当桌面应用提供了受限浏览器操作结果时，你可以围绕这些结果说明已经完成了什么。",
  "请区分用户目标、页面上下文、附件上下文和浏览器操作结果；填写表单时根据字段标签推断值，不要把整句用户目标当作单个字段值。",
  "只基于用户消息、历史对话、本次提供的运行上下文、页面上下文、附件上下文和工具结果回答；不要声称你读取了未提供的网页、文件、系统或私有数据。",
  "如果用户要求查询网页但没有可操作网页目标或工具结果，请基于当前可见页面说明能回答的部分，并明确当前页面无法直接完成外部查询。",
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
    error: truncateText(attachment.error ?? "", 500)
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
        "左侧网页目标：可操作",
        browserTarget.surfaceLabel ? `入口：${browserTarget.surfaceLabel}` : "",
        browserTarget.currentUrl ? `当前地址：${browserTarget.currentUrl}` : ""
      ].filter(Boolean).join("；")
    : "左侧网页目标：未检测到可操作网页目标，仅可使用当前可见页面文本。";
  const sections = [
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

function buildAttachmentContextBlock(attachments: ReturnType<typeof normalizeAttachments>) {
  if (attachments.length === 0) {
    return "";
  }

  const sections = attachments.map((attachment, index) => {
    const meta = [
      `附件 ${index + 1}：${attachment.name}`,
      attachment.mimeType ? `类型：${attachment.mimeType}` : "",
      `大小：${attachment.sizeBytes} bytes`,
      attachment.dataUrl ? "图片：已作为视觉附件发送给模型" : "",
      attachment.truncated ? "内容：以下为截断摘录" : "",
      attachment.error ? `读取说明：${attachment.error}` : "",
      attachment.text ? `内容摘录：\n${attachment.text}` : ""
    ].filter(Boolean);
    return meta.join("\n");
  });

  return `<附件上下文>\n${sections.join("\n\n")}\n</附件上下文>`;
}

function buildUserGoalBlock(message: string) {
  const normalized = truncateText(message, 4000);
  return normalized ? `<用户目标>\n${normalized}\n</用户目标>` : "";
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
  runtimeContext
}: {
  history: AssistantChatMessage[];
  message: string;
  action?: AssistantRunAction;
  pageContext?: AssistantPageContext | null;
  attachments?: AssistantAttachment[];
  runtimeContext?: AssistantRuntimeContext;
}): OpenAIChatMessage[] {
  const normalizedRuntimeContext = runtimeContext ?? createAssistantRuntimeContext();
  const normalizedPageContext = normalizePageContext(pageContext, {
    maxBodyTextLength: action === "chat" ? MAX_CHAT_BODY_TEXT_LENGTH : MAX_BODY_TEXT_LENGTH
  });
  const normalizedAttachments = normalizeAttachments(attachments);
  const actionInstruction = getActionInstruction(action);
  const runtimeContextBlock = buildRuntimeContextBlock(normalizedRuntimeContext);
  const pageContextBlock = buildPageContextBlock(normalizedPageContext);
  const attachmentContextBlock = buildAttachmentContextBlock(normalizedAttachments);
  const userContent = [
    actionInstruction,
    runtimeContextBlock,
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
  buildRuntimeContextBlock,
  buildRecentHistory,
  buildPageContextBlock,
  buildUserGoalBlock,
  createAssistantRuntimeContext,
  getActionInstruction
};
