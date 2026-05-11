import { randomUUID } from "node:crypto";
import path from "node:path";
import type { App } from "electron";
import type {
  AssistantAwaitingPayload,
  AssistantAwaitingQuestion,
  AssistantAttachment,
  AssistantChatMessage,
  AssistantEvent,
  AssistantPageContext,
  AssistantPermissionMode,
  AssistantRunEvent,
  AssistantRunEventStatus,
  AssistantRunSource,
  AssistantSubmitAwaitingRequest,
  AssistantSubmitAwaitingResult,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  AssistantStopRunResult,
  ServiceCommandResult,
  ServiceState,
  AssistantVoiceChangeLevel,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceCorrectionResult,
  AssistantVoiceTranscriptionRequest,
  AssistantVoiceTranscriptionResult
} from "../../shared/contracts";
import {
  appendAssistantEvent,
  appendAssistantMessage,
  createAssistantMessage,
  getAssistantChat,
  updateAssistantMessageAttachments
} from "./chat-store";
import {
  createAssistantArtifactAttachmentsFromFiles,
  hydrateAssistantAttachmentsForChat,
  refreshAssistantAttachmentsForRun
} from "./attachment-store";
import { loadAgentPlatformMinimaxSettings, loadAgentPlatformVoiceAsrSettings } from "./agent-platform-config";
import { readAssistantSettings } from "./settings-store";
import { convertAudioBufferToWavBuffer } from "./audio-conversion";
import { buildAssistantMessages, type OpenAIChatMessage, type OpenAIToolCall } from "./prompt-builder";
import {
  getAssistantMemorySettingsFromRoot,
  readAssistantMemorySnapshotFromRoot,
  upsertAssistantMemoryItemsFromRoot,
  upsertExplicitUserMemoryFromRoot,
  type AssistantMemorySnapshot,
  type AssistantMemoryUpsertInput,
  type AssistantMemoryUpsertResult
} from "./memory-store";
import {
  completeOpenAIChatCompletion,
  streamOpenAIChatCompletion,
  transcribeOpenAIChatAudio,
  type OpenAIToolDefinition
} from "./model-provider";
import {
  ZENMIND_ASSISTANT_AGENT_KEY,
  ZENMIND_ASSISTANT_NAME
} from "../../shared/assistant-capabilities";
import {
  extractBrowserTaskIntent,
  extractBrowserIntent,
  isPotentiallySensitiveClickTarget,
  normalizeBrowserText,
  type BrowserTaskIntent,
  type BrowserTaskWebsite
} from "./browser-intent";
import type {
  BrowserAgentTaskInput,
  BrowserFieldInput,
  BrowserObservation,
  BrowserSurface,
  BrowserToolResult
} from "./browser-use";
import {
  listDesktopFiles,
  moveDesktopFiles,
  planDesktopOrganize,
  readDesktopFile,
  readDesktopDocument,
  runHostCommand,
  writeDesktopFile,
  type DesktopMoveOperation
} from "./desktop-tools";
import {
  createDocxFile,
  createPdfFile,
  createPptxFile,
  createXlsxFile,
  OFFICE_MIME_TYPES
} from "./office-tools";
import {
  buildContainerHubRunSessionId,
  ContainerHubClient,
  getAssistantWorkspacePath,
  type ContainerHubConfig
} from "./container-hub";
import type {
  DocxCreateInput,
  OfficeToolResult,
  PdfCreateInput,
  PdfRenderer,
  PptxCreateInput,
  XlsxCreateInput
} from "./office-tools";
import { canDescribeImageWithVision, describeImageWithVision } from "./vision-provider";
import { routeAssistantToolRequest } from "./capability-broker";

type AssistantBrowserUseTool = {
  listSurfaces?: () => Promise<BrowserSurface[]>;
  activateSurface?: (target: string) => Promise<BrowserToolResult>;
  openUrl?: (input: { url: string; label?: string }) => Promise<BrowserToolResult>;
  navigateUrl?: (webContentsId: number, input: { url: string; label?: string }) => Promise<BrowserToolResult>;
  createRuntimeSnapshot?: (webContentsId: number) => Promise<unknown>;
  observePage?: (webContentsId: number) => Promise<BrowserObservation>;
  click?: (webContentsId: number, input: { elementRef?: string; target?: string }) => Promise<BrowserToolResult>;
  fillFields?: (webContentsId: number, fields: BrowserFieldInput[]) => Promise<BrowserToolResult>;
  autofillForm?: (webContentsId: number, input?: { instruction?: string; skill?: string; submit?: boolean }) => Promise<BrowserToolResult>;
  executeAgentTask?: (
    webContentsId: number,
    input: BrowserAgentTaskInput,
    options?: {
      signal?: AbortSignal;
      onEvent?: (event: { type?: string; message?: string; data?: unknown }) => void;
    }
  ) => Promise<BrowserToolResult>;
  selectOption?: (webContentsId: number, input: BrowserFieldInput) => Promise<BrowserToolResult>;
  setChecked?: (webContentsId: number, input: { field?: string; label?: string; elementRef?: string; checked: boolean }) => Promise<BrowserToolResult>;
  submit?: (webContentsId: number, input?: { target?: string; elementRef?: string }) => Promise<BrowserToolResult>;
  clickElementByText: (webContentsId: number, target: string) => Promise<{
    ok: boolean;
    target: string;
    matchedText?: string;
    message?: string;
    candidates?: string[];
  }>;
  fillBestInput: (webContentsId: number, value: string) => Promise<{
    ok: boolean;
    value: string;
    submitted: boolean;
    inputLabel?: string;
    message?: string;
  }>;
  fillBestInputAndSubmit: (webContentsId: number, value: string) => Promise<{
    ok: boolean;
    value: string;
    submitted: boolean;
    inputLabel?: string;
    message?: string;
  }>;
  readPageContext: (webContentsId: number) => Promise<AssistantStartRunRequest["pageContext"]>;
  extractPage?: (
    webContentsId: number,
    extraction: { kind?: "search_results" | "hot_search" | "headings" | "links" | "table_rows" | "form_state"; count: number; itemLabel: string }
  ) => Promise<{ ok: boolean; items: Array<{ title: string }> }>;
};

const MAX_BROWSER_TOOL_STEPS = 16;
const DEFAULT_AWAITING_TIMEOUT_MS = 5 * 60 * 1000;
const FULL_ACCESS_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_SANDBOX_ENVIRONMENT = "shell";
const VOICE_CORRECTION_TIMEOUT_MS = 20000;
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 60000;
const MISSING_VOICE_ASR_PROVIDER_MESSAGE =
  "当前未配置可用的云端语音识别 provider。语音模型纠错只负责识别后的文本整理；如需录音转写，请在 agent-platform 配置百炼 qwen3-asr-flash。";
const AGW_ASK_USER_QUESTION_TOOL_NAME = "_ask_user_question_";
const LEGACY_ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
const CLAUDE_ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

const VOICE_CORRECTION_SYSTEM_PROMPT = [
  "你是 ZenMind Desktop 的语音输入 ASR 文本纠错器。",
  "你的任务只是在中文加英文混合口述场景中修正识别文本。",
  "只输出纠正后的文本，不要解释，不要回答用户问题，不要添加引号、Markdown 或前后缀。",
  "允许修正中文错别字、断句、标点、中英文空格，以及明显被 ASR 拆错的英文技术词。",
  "必须保留用户原意，不要扩写，不要总结，不要把英文翻译成中文，也不要把中文翻译成英文。",
  "保留命令、路径、代码符号、变量名、URL 和专有名词；常见技术词按标准拼写恢复，例如 API、React、MiniMax、OpenAI、GitHub、npm、TypeScript、JavaScript。",
  "如果文本本身已经合理，原样输出。"
].join("\n");

function normalizeVoiceAsrFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP\s*401|鉴权|API\s*Key|unauthorized|unauthenticated/iu.test(message)) {
    return "语音识别 provider 鉴权失败，请检查 agent-platform 的百炼 qwen3-asr-flash provider 配置；语音模型纠错开关不会影响录音转写鉴权。";
  }
  return message;
}

const BROWSER_ACTION_PATTERN =
  /(浏览器|左边网页|左侧网页|当前网页|网页里|侧边栏|页面流程|打开|进入|点击|点开|启动|停止|重启|填写|填表|填好|补全|完善|随便填|输入|搜索|搜一下|查一下|查询|查找|检索|筛选|过滤|翻页|上一页|下一页|勾选|取消勾选|选择|下拉|提交|表单|读取.*(?:网页|页面|结果)|总结.*结果)/u;
const WEB_QUERY_PATTERN =
  /(搜索|搜一下|查一下|查询|查找|检索|筛选|过滤|翻页|上一页|下一页|读取.*(?:网页|页面|结果)|总结.*结果)/u;
const PAGE_CONTEXT_ONLY_PATTERN =
  /(?:(?:当前|这个|这页|左边|左侧)?(?:页面|网页)|这条内容|这篇文章|选中文本|当前内容).*(?:讲|说|是什么|有哪些|总结|概括|分析|提炼|说明|内容|重点|待办|风险)|(?:总结|概括|分析|提炼|说明).*(?:(?:当前|这个|这页|左边|左侧)?(?:页面|网页)|这条内容|这篇文章|选中文本|当前内容)/u;
const ATTACHMENT_CONTEXT_PATTERN =
  /(?:附件|上传|刚才上传|文件|文档|pdf|PDF|Word|Excel|PPT|图片|截图|这张图|这个图|这份|扫描件|页图|里面有什么|有哪些内容|有什么内容|总结下|总结一下|概括|分析|解析|读取|阅读|识别|OCR)/u;
const EXPLICIT_WEB_SURFACE_PATTERN =
  /(?:百度|谷歌|Google|Bing|网页|浏览器|网站|网址|URL|https?:\/\/|左侧网页|左边网页|当前网页|页面里|打开网页|搜索网页|上网搜索|操作左侧|操作左边)/iu;
const DIRECT_ANSWER_PATTERN =
  /(直接回答|不用看页面|不要看页面|别看页面|不用基于页面|不要基于页面|不基于当前页|不用查网页|不用搜索)/u;
const BROWSER_FORM_FILL_PATTERN =
  /(填表|填好|补全|完善|填写).*(表单|字段|资料|信息|申请|右侧|左侧|这一页|当前页)|(?:表单|字段|资料|信息|申请).*(随便填|帮我填|填写|填好|补全|完善)/u;
const EXPLICIT_PAGE_AGENT_PATTERN = /(?:page\s*agent|pageagent|browser_agent_execute)/iu;
const HUMAN_IN_LOOP_PATTERN =
  /(?:human\s*in\s*the\s*loop|human[-_\s]*in[-_\s]*loop|hitl|agw|awaiting|弹窗|采访我|问我问题|向我提问|需要用户(?:确认|补充|回答)|人工确认|用户确认)/iu;
const DIRECT_PAGE_AGENT_SYSTEM_INSTRUCTION = [
  "你运行在 ZenMind Desktop 内嵌网页中。",
  "需要搜索时只操作文本搜索框和搜索按钮或回车；不要点击麦克风、相机、图片上传、附件或文件选择入口，除非用户明确要求上传文件。",
  "在百度页面执行搜索时，输入关键词后必须点击“百度一下”按钮或触发回车，并等待搜索结果页加载；不要把输入框下方的联想词、历史记录或建议列表当作搜索结果。",
  "只有页面出现网页搜索结果标题、摘要、来源等结果内容后，才可以读取并总结结果。",
  "如果用户要求读取前几条搜索结果标题，拿到足够数量的结果标题后立即结束并回复；不要继续滚动或探索更多页面。"
].join("\n");

const BROWSER_TOOL_SYSTEM_PROMPT = [
  "你可以通过 Browser Use 工具操作 ZenMind Desktop 内嵌网页。",
  "先用 browser_surfaces 查看可用侧边栏或当前网页；如果用户指定某个网站/侧边栏，先调用 browser_activate_surface。",
  "操作页面前先调用 browser_observe，优先使用返回的 elementRef 或字段 label。",
  "如果用户要求在输入框输入内容后按搜索、查询、回车或提交搜索，browser_fill 后必须继续调用 browser_submit；不要只填写后结束。",
  "如果用户要求填写表单、填好表单、信息随便填或填写右侧/左侧表单，优先直接调用 browser_autofill；不要把整句指令当作单个输入值。用户明确说不用提交或不要提交时，不要调用 browser_submit。",
  "如果用户要求跨多个页面步骤、连续操作、复杂页面探索或你不确定具体字段/按钮路径，优先调用 browser_agent_execute 让 PageAgent 完成任务。",
  "后续如果系统或用户注入了某个表单的填写 skill，请把 skill 规则作为 browser_autofill 的 skill 参数或转成 browser_fill 字段值。",
  "搜索、普通输入和普通页面跳转可以自动执行；删除、支付、授权、登录、保存、提交订单等敏感操作不要自动执行，遇到工具返回 sensitive_action_blocked 时请说明需要用户确认。",
  "每次工具调用后根据工具结果决定下一步；完成后用一句话说明已完成什么，必要时总结 browser_read 返回的页面内容。"
].join("\n");

const BROWSER_TOOL_DEFINITIONS: OpenAIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "browser_surfaces",
      description: "List available Desktop sidebar browser surfaces and the current active web page.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_activate_surface",
      description: "Activate a configured sidebar browser surface by label, id, URL, or domain.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Sidebar label, id, URL, or domain to activate."
          }
        },
        required: ["target"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_observe",
      description: "Observe the current browser page and return visible clickable elements, fields, and text.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click a visible element by elementRef or semantic target text.",
      parameters: {
        type: "object",
        properties: {
          elementRef: { type: "string" },
          target: { type: "string" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_fill",
      description: "Fill one or more visible form fields by elementRef, field name, or label. Use this for batch form filling after browser_observe.",
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                elementRef: { type: "string" },
                field: { type: "string" },
                label: { type: "string" },
                value: { type: "string" }
              },
              required: ["value"],
              additionalProperties: false
            }
          }
        },
        required: ["fields"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_autofill",
      description: "Autofill visible form fields in one step from page labels/options and optional form skill hints. Use this for requests like fill this form, fill casually, or do not submit.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "The user's original form filling instruction."
          },
          skill: {
            type: "string",
            description: "Optional injected form skill or field mapping rules, e.g. field=value lines."
          },
          submit: {
            type: "boolean",
            description: "Whether to submit after filling. Keep false unless the user explicitly asks to submit."
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_agent_execute",
      description: "Use PageAgent to execute a natural-language browser task inside the current ZenMind Desktop webview. Prefer this for multi-step or complex page automation.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The concrete browser task to execute."
          },
          target: {
            type: "string",
            description: "Optional sidebar label, URL, or page target."
          },
          allowSensitive: {
            type: "boolean",
            description: "Requested sensitive-operation allowance. Runtime ignores this unless the user explicitly confirms."
          }
        },
        required: ["task"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_select",
      description: "Select an option in a visible select field.",
      parameters: {
        type: "object",
        properties: {
          elementRef: { type: "string" },
          field: { type: "string" },
          label: { type: "string" },
          value: { type: "string" }
        },
        required: ["value"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_check",
      description: "Check or uncheck a visible checkbox or radio option.",
      parameters: {
        type: "object",
        properties: {
          elementRef: { type: "string" },
          field: { type: "string" },
          label: { type: "string" },
          checked: { type: "boolean" }
        },
        required: ["checked"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_submit",
      description: "Submit the current search/form by target text, elementRef, or Enter fallback.",
      parameters: {
        type: "object",
        properties: {
          elementRef: { type: "string" },
          target: { type: "string" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_read",
      description: "Read the current page text after browser operations.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  }
];

const DESKTOP_ACTION_PATTERN =
  /(桌面|文件|目录|列出|读取|写入|保存|创建|生成|发布|产物|整理|移动|归档|html|贪吃蛇|命令|终端|bash|shell|沙箱|sandbox|container|启动.*(?:应用|软件|程序|Docker|Claude)|打开.*(?:应用|软件|程序|Docker|Claude)|操作系统.*(?:应用|软件|程序))/iu;

const DESKTOP_AGENT_SYSTEM_PROMPT = [
  `你是 Desktop 单智能体 ${ZENMIND_ASSISTANT_NAME}（agentKey: ${ZENMIND_ASSISTANT_AGENT_KEY}），可以在 ZenMind Desktop 内通过工具完成受限桌面任务。`,
  "如果用户要列出、读取、整理、生成或保存桌面文件，必须调用 desktop_* 工具，不要假装已经看到了文件；读取 PDF、Office、ZIP、图片或聊天附件时优先调用 desktop_read_document。",
  "如果用户问题指向本轮上传附件、图片、截图或 PDF 内容，不要调用 Browser 搜索网页；只有用户明确要求百度、网页、浏览器或左侧页面操作时才使用 Browser。",
  `如果用户明确要求 human in the loop、HITL、AGW、弹窗采访、问用户问题或让你通过弹窗收集信息，必须调用 ${AGW_ASK_USER_QUESTION_TOOL_NAME} 工具；不要把问题直接写在普通聊天回复里。`,
  "AGW awaiting 问题必须使用结构化 questions：每项包含 question、type，选择题提供 options；需要多选时用 type=select 且 multiSelect=true。",
  "默认桌面目标就是 Electron app.getPath(\"desktop\")；生成单文件网页或小游戏时，优先写一个完整可打开的 .html 文件到桌面。",
  "整理桌面必须先调用 desktop_plan_organize 给出移动预览，然后再调用 desktop_move_files；写入、移动、覆盖和宿主机命令会自动触发用户确认。",
  "需要运行代码或普通 shell 验证时优先使用 bash_sandbox；只有确实需要访问宿主机桌面或系统命令时才使用 bash。",
  "Container Hub 沙箱默认工作目录为 /workspace，不要假设整个桌面已经挂载到容器内；真实桌面文件操作仍使用 desktop_* 工具。",
  "如果工具返回用户拒绝、取消或沙箱不可用，请清楚说明当前状态并给出下一步。"
].join("\n");

const DESKTOP_TOOL_DEFINITIONS: OpenAIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "desktop_list_files",
      description: "List files under the user's Desktop or an allowed Desktop subdirectory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional Desktop-relative or allowed absolute directory path." },
          recursive: { type: "boolean" },
          maxEntries: { type: "number" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_read_file",
      description: "Read a small UTF-8 text file from the Desktop or assistant workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_read_document",
      description: "Read and extract text from a PDF, Word, Excel, PowerPoint, ZIP, image, or chat attachment under Desktop or assistant workspace. Images and scanned PDFs use the configured vision model.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Desktop-relative or allowed absolute file path." },
          attachmentId: { type: "string", description: "Current chat attachment id, if reading an uploaded attachment." },
          pages: { type: "string", description: "Optional PDF page range hint, such as 1-3." },
          sheet: { type: "string", description: "Optional spreadsheet sheet name hint." },
          maxChars: { type: "number" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_create_docx",
      description: "Create a Word .docx document on the Desktop or assistant workspace. User approval is required.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          contentFormat: { type: "string", enum: ["plain", "markdown"] },
          overwrite: { type: "boolean" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_create_pdf",
      description: "Create a PDF document on the Desktop or assistant workspace. User approval is required.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          contentFormat: { type: "string", enum: ["plain", "markdown", "html"] },
          overwrite: { type: "boolean" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_create_xlsx",
      description: "Create an Excel .xlsx workbook on the Desktop or assistant workspace. User approval is required.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          title: { type: "string" },
          sheets: { type: "array" },
          content: { type: "string" },
          overwrite: { type: "boolean" }
        },
        additionalProperties: true
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_create_pptx",
      description: "Create a PowerPoint .pptx deck on the Desktop or assistant workspace. User approval is required.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          filename: { type: "string" },
          title: { type: "string" },
          slides: { type: "array" },
          content: { type: "string" },
          overwrite: { type: "boolean" }
        },
        additionalProperties: true
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_write_file",
      description: "Write a UTF-8 file to the Desktop or assistant workspace. User approval is required before writing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Desktop-relative or allowed absolute file path." },
          filename: { type: "string", description: "Alternative Desktop filename when path is omitted." },
          content: { type: "string" },
          overwrite: { type: "boolean" }
        },
        required: ["content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_plan_organize",
      description: "Preview a Desktop organization plan without moving files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_move_files",
      description: "Move Desktop files according to a preview plan. User approval is required before moving.",
      parameters: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" }
              },
              required: ["from", "to"],
              additionalProperties: false
            }
          }
        },
        required: ["moves"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a host shell command from an allowed directory. User approval is required.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          description: { type: "string", description: "Short Chinese purpose shown to the user." },
          cwd: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["command", "description"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash_sandbox",
      description: "Run a shell command inside Container Hub sandbox /workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          description: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
          environmentName: { type: "string", description: "Container Hub environment name, defaults to shell." }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: AGW_ASK_USER_QUESTION_TOOL_NAME,
      description: "AGW awaiting question tool. Ask the user structured questions in a Human-In-The-Loop dialog and wait for their answers.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["question"] },
          title: { type: "string" },
          description: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                header: { type: "string" },
                question: { type: "string" },
                label: { type: "string" },
                type: { type: "string", enum: ["text", "number", "select", "password"] },
                placeholder: { type: "string" },
                required: { type: "boolean" },
                multiSelect: { type: "boolean" },
                allowFreeText: { type: "boolean" },
                freeTextPlaceholder: { type: "string" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" },
                      description: { type: "string" }
                    },
                    required: ["label"],
                    additionalProperties: false
                  }
                }
              },
              required: ["question", "type"],
              additionalProperties: false
            }
          }
        },
        required: ["questions"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "artifact_publish",
      description: "Publish an artifact notice after creating or locating a useful output file.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          path: { type: "string" },
          mimeType: { type: "string" },
          description: { type: "string" },
          artifacts: { type: "array" }
        },
        additionalProperties: true
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_app_launch",
      description: "Launch an allowlisted local desktop application such as Docker Desktop, Claude, Chrome, Edge, or Terminal. User approval is required.",
      parameters: {
        type: "object",
        properties: {
          appName: { type: "string" },
          app_name_or_path: { type: "string" },
          command: { type: "string" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "plan_add_tasks",
      description: "Add visible run tasks for multi-step Desktop work.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["tasks"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "plan_update_task",
      description: "Update a visible run task status.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "number" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          task: { type: "string" }
        },
        required: ["index", "status"],
        additionalProperties: false
      }
    }
  }
];

const MEMORY_EXTRACTION_SYSTEM_PROMPT = [
  "你是 ZenMind Desktop 的本地记忆提取器。",
  "你的任务是从单轮用户消息和本轮助手回复中，提取适合长期保存的稳定偏好、明确约束、可复用工作流或长期决策。",
  "只输出 JSON，对象格式为 {\"memories\": [...]}；不要输出 Markdown、解释或额外文字。",
  "只有当信息对未来回答有复用价值时才提取；临时任务、一次性指令、当前页面细节、低信息量寒暄不要提取。",
  "不要提取密码、token、密钥、隐私敏感信息，也不要记住用户明确要求不要记住的内容。",
  "每条 memory 可包含 kind、title、summary、category、tags、importance、confidence、reason。",
  "summary 用简洁中文完整表达记忆内容；confidence 使用 0 到 1 的小数。",
  "如果没有可保存的记忆，返回 {\"memories\": []}。"
].join("\n");

const AGENT_TOOL_DEFINITIONS = [...BROWSER_TOOL_DEFINITIONS, ...DESKTOP_TOOL_DEFINITIONS];

type BrowserToolLoopState = {
  pageContext: AssistantPageContext | null;
  webContentsId: number | null;
  userText: string;
  lastResult: BrowserToolResult | null;
  runId: string;
  chatId: string;
  permissionMode: AssistantPermissionMode;
  abortSignal: AbortSignal;
  tasks: Array<{ task: string; status: "pending" | "in_progress" | "completed" }>;
};

type RunArtifactInput = {
  path: string;
  artifactId?: string;
  name?: string;
  mimeType?: string;
  description?: string;
  type?: string;
};

type ContainerHubResolverResult = ContainerHubConfig & {
  unavailableReason?: string;
};

type AssistantRuntimeDependencies = {
  openExternalUrl?: (url: string) => Promise<void>;
  renderPdf?: PdfRenderer;
  services?: {
    list?: () => Promise<ServiceState[]>;
    control?: (serviceId: string, operation: "start" | "stop" | "restart") => Promise<ServiceCommandResult>;
  };
  resolveContainerHub?: () => Promise<ContainerHubResolverResult | null>;
};

type AwaitingAnswer = {
  action: "submit" | "reject" | "dismiss";
  params: unknown[];
  reason: string;
};

type PendingAwaiting = {
  runId: string;
  chatId: string;
  payload: AssistantAwaitingPayload;
  resolve: (answer: AwaitingAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
};

function maybeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function maybeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripOptionalCodeFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function parseLearnedMemoryCandidates(value: string): AssistantMemoryUpsertInput[] {
  const trimmed = stripOptionalCodeFence(value);
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const memories = isRecord(parsed) && Array.isArray(parsed.memories)
      ? parsed.memories
      : Array.isArray(parsed)
        ? parsed
        : [];
    return memories.filter(isRecord).map((item) => ({
      ...(maybeString(item.kind) ? { kind: maybeString(item.kind) } : {}),
      ...(maybeString(item.title) ? { title: maybeString(item.title) } : {}),
      ...(maybeString(item.summary) ? { summary: maybeString(item.summary) } : {}),
      ...(maybeString(item.category) ? { category: maybeString(item.category) } : {}),
      ...(Array.isArray(item.tags)
        ? {
            tags: item.tags
              .map((tag) => maybeString(tag))
              .filter((tag): tag is string => Boolean(tag))
          }
        : {}),
      ...(typeof maybeNumber(item.importance) === "number" ? { importance: maybeNumber(item.importance) } : {}),
      ...(typeof maybeNumber(item.confidence) === "number" ? { confidence: maybeNumber(item.confidence) } : {}),
      ...(maybeString(item.reason) ? { reason: maybeString(item.reason) } : {})
    }));
  } catch {
    return [];
  }
}

function isAskUserQuestionToolName(toolName: string) {
  return (
    toolName === AGW_ASK_USER_QUESTION_TOOL_NAME ||
    toolName === LEGACY_ASK_USER_QUESTION_TOOL_NAME ||
    toolName === CLAUDE_ASK_USER_QUESTION_TOOL_NAME
  );
}

function decodePseudoToolText(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, "$1")
    .replace(/&quot;/giu, "\"")
    .replace(/&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .trim();
}

function parsePseudoJsonObject(value: string) {
  const trimmed = decodePseudoToolText(value);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePseudoToolArgs(body: string) {
  const args: Record<string, unknown> = {};
  const parameterPattern = /<(?:arg|parameter)(?:\s+name=(?:"([^"]+)"|'([^']+)'|([^\s>]+)))?[^>]*>([\s\S]*?)<\/(?:arg|parameter)>/giu;
  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(body))) {
    const name = decodePseudoToolText(match[1] || match[2] || match[3] || "");
    const value = decodePseudoToolText(match[4] || "");
    const parsedObject = parsePseudoJsonObject(value);
    if (parsedObject && (!name || name === "input" || name === "arguments")) {
      Object.assign(args, parsedObject);
      continue;
    }
    if (name) {
      args[name] = parsedObject ?? value;
      continue;
    }
    if (parsedObject) {
      Object.assign(args, parsedObject);
    } else if (value) {
      args.value = value;
    }
  }
  return args;
}

function pseudoBrowserTargetFromLocator(locator: string) {
  const hasText = locator.match(/has-text\((?:"([^"]+)"|'([^']+)')\)/iu);
  if (hasText) {
    return (hasText[1] || hasText[2] || "").trim();
  }
  const quoted = locator.match(/(?:"([^"]+)"|'([^']+)')/u);
  return (quoted?.[1] || quoted?.[2] || locator).trim();
}

function pseudoCommandLooksLikeHostAppLaunch(command: unknown) {
  const text = maybeString(command) || "";
  return /^(?:open\s+.*-a\s+|Start-Process\s+|start\s+)/iu.test(text);
}

function normalizePseudoToolName(name: string, args: Record<string, unknown>) {
  const normalized = name.trim();
  if (normalized === "browser_dom_click") {
    return "browser_click";
  }
  if (normalized === "bash_sandbox" && pseudoCommandLooksLikeHostAppLaunch(args.command)) {
    return "host_app_launch";
  }
  return normalized;
}

function findPseudoAttachmentForDocumentRead(
  request: AssistantStartRunRequest,
  args: Record<string, unknown>
) {
  const attachments = Array.isArray(request.attachments)
    ? request.attachments.filter((attachment) => attachment.kind !== "artifact" && !attachment.hidden)
    : [];
  if (attachments.length === 0) {
    return null;
  }
  const attachmentId = maybeString(args.attachmentId);
  if (attachmentId) {
    return attachments.find((attachment) => attachment.id === attachmentId) ?? null;
  }
  const rawPath = maybeString(args.path) || maybeString(args.filePath) || maybeString(args.file_path) || maybeString(args.filename);
  const basename = rawPath ? path.basename(rawPath) : "";
  if (basename) {
    const matched = attachments.find((attachment) => attachment.name === basename || attachment.name.endsWith(basename));
    if (matched) {
      return matched;
    }
  }
  return attachments.length === 1 ? attachments[0] : null;
}

function normalizePseudoToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  request: AssistantStartRunRequest
) {
  const normalized = { ...args };
  if (toolName === "browser_click") {
    const locator = maybeString(normalized.locator);
    const value = maybeString(normalized.value);
    const target = maybeString(normalized.target);
    if (target === "text" && value) {
      normalized.target = value;
    } else if (locator && (!target || /^(?:left|right|current|page)$/iu.test(target))) {
      normalized.target = pseudoBrowserTargetFromLocator(locator);
    } else if (!target && locator) {
      normalized.target = pseudoBrowserTargetFromLocator(locator);
    }
    if ((request as { permissionMode?: string }).permissionMode === "full_access") {
      normalized.allowSensitive = true;
    }
  }
  if (toolName === "desktop_read_document") {
    const filePath = maybeString(normalized.path) || maybeString(normalized.filePath) || maybeString(normalized.file_path);
    if (filePath && !normalized.path) {
      normalized.path = filePath;
    }
    const attachment = findPseudoAttachmentForDocumentRead(request, normalized);
    if (attachment) {
      normalized.attachmentId = attachment.id;
      delete normalized.path;
    }
  }
  return normalized;
}

function stripPseudoToolMarkup(text: string) {
  return text
    .replace(/<invoke\s+name=(?:"[^"]+"|'[^']+'|[^\s>]+)[^>]*>[\s\S]*?<\/invoke>/giu, "")
    .replace(/<\/?(?:function_calls|functions|tool_calls|result)>/giu, "")
    .trim();
}

function extractPseudoToolCallsFromText(text: string, request: AssistantStartRunRequest) {
  const toolCalls: OpenAIToolCall[] = [];
  let hasOperatorModeRequest = false;
  const invokePattern = /<invoke\s+name=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/invoke>/giu;
  let match: RegExpExecArray | null;
  while ((match = invokePattern.exec(text))) {
    const rawName = decodePseudoToolText(match[1] || match[2] || match[3] || "");
    const rawArgs = parsePseudoToolArgs(match[4] || "");
    const toolName = normalizePseudoToolName(rawName, rawArgs);
    if (toolName === "operator_mode_request") {
      hasOperatorModeRequest = true;
      continue;
    }
    if (!toolName) {
      continue;
    }
    toolCalls.push({
      id: `pseudo_tool_${Date.now().toString(36)}_${toolCalls.length}`,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(normalizePseudoToolArgs(toolName, rawArgs, request))
      }
    });
  }
  return {
    toolCalls,
    hasOperatorModeRequest,
    visibleText: stripPseudoToolMarkup(text)
  };
}

function operatorModePseudoFallbackMessage() {
  return "现在只有“询问后操作”和“完全允许控制”两种权限模式，请在输入栏切换。";
}

function normalizeAgwQuestionType(candidate: Record<string, unknown>): AssistantAwaitingQuestion["type"] {
  const rawType = maybeString(candidate.type)?.toLowerCase();
  if (rawType === "number" || rawType === "password") {
    return rawType;
  }
  if (rawType === "select" && candidate.multiSelect === true) {
    return "multi-select";
  }
  if (rawType === "multi-select" || rawType === "multiselect") {
    return "multi-select";
  }
  if (rawType === "select") {
    return "select";
  }
  return Array.isArray(candidate.options) && candidate.options.length > 0 ? "select" : "text";
}

function normalizeAgwQuestionOptions(value: unknown): AssistantAwaitingQuestion["options"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options: NonNullable<AssistantAwaitingQuestion["options"]> = [];
  for (const option of value) {
    if (!isRecord(option)) {
      continue;
    }
    const label = maybeString(option.label);
    if (!label) {
      continue;
    }
    options.push({
      label,
      value: maybeString(option.value),
      description: maybeString(option.description)
    });
  }
  return options.length > 0 ? options : undefined;
}

function normalizeAgwAwaitingQuestions(value: unknown): AssistantAwaitingQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index): AssistantAwaitingQuestion | null => {
      if (!isRecord(item)) {
        return null;
      }
      const questionText = maybeString(item.question) || maybeString(item.label) || maybeString(item.header);
      if (!questionText) {
        return null;
      }
      const id = maybeString(item.id) || `q${index + 1}`;
      const header = maybeString(item.header);
      const label = maybeString(item.label) || header || questionText;
      const type = normalizeAgwQuestionType(item);
      return {
        id,
        label,
        header,
        question: questionText,
        type,
        placeholder: maybeString(item.placeholder),
        required: Boolean(item.required),
        allowFreeText: typeof item.allowFreeText === "boolean" ? item.allowFreeText : undefined,
        freeTextPlaceholder: maybeString(item.freeTextPlaceholder),
        options: normalizeAgwQuestionOptions(item.options)
      };
    })
    .filter((question): question is AssistantAwaitingQuestion => Boolean(question));
}

function formatAgwAnswerValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ");
  }
  return String(value ?? "").trim();
}

function buildAgwQuestionAnswerPayload(questions: AssistantAwaitingQuestion[], params: unknown[]) {
  const submitted = params.filter(isRecord);
  const answeredParams = questions.map((question, index) => {
    const match =
      submitted.find((item) => maybeString(item.id) === question.id) ??
      submitted.find((item) => maybeString(item.question) === question.question) ??
      submitted[index] ??
      {};
    const answer = Object.hasOwn(match, "answer")
      ? match.answer
      : Object.hasOwn(match, "value")
        ? match.value
        : undefined;
    const base: Record<string, unknown> = {
      id: question.id,
      question: question.question || question.label
    };
    if (question.header) {
      base.header = question.header;
    }
    if (Array.isArray(match.answers)) {
      base.answers = match.answers.map((item) => String(item ?? "").trim()).filter(Boolean);
    } else {
      base.answer = typeof answer === "number" ? answer : String(answer ?? "").trim();
    }
    return base;
  });
  const answerMap: Record<string, string> = {};
  for (const item of answeredParams) {
    const questionText = maybeString(item.question);
    if (!questionText) {
      continue;
    }
    const value = Array.isArray(item.answers) ? formatAgwAnswerValue(item.answers) : formatAgwAnswerValue(item.answer);
    if (value) {
      answerMap[questionText] = value;
    }
  }
  return {
    mode: "question",
    answers: answeredParams,
    updatedInput: {
      answers: answerMap
    }
  };
}

function normalizeDirectHitlQuestionText(value: string) {
  const text = value
    .replace(/^[\s\-–—]*(?:问题\s*)?(?:\d+|[一二两三四五六七八九十]+)[\.．、):：]\s*/u, "")
    .replace(/^(?:请)?(?:弹窗)?(?:问我|采访我|向我提问)(?:一下|几个问题|两个问题|这些问题)?[，,:：\s]*/u, "")
    .replace(/^(?:两个|几个)?问题[：:\s]*/u, "")
    .trim();
  return text.replace(/[。；;]+$/u, "").trim();
}

function extractEnumeratedHitlQuestionTexts(userText: string) {
  const questions: string[] = [];
  const pattern = /(?:问题\s*)?(?:\d+|[一二两三四五六七八九十]+)[\.．、):：]\s*([^。！？?；;\n\r]+[！？?？]?)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(userText)) !== null) {
    const text = normalizeDirectHitlQuestionText(match[1] || "");
    if (text) {
      questions.push(text);
    }
  }
  return questions;
}

function extractTailHitlQuestionText(userText: string) {
  const match = userText.match(/(?:问我|采访我|向我提问)[，,:：\s]*(.+)$/u);
  if (!match) {
    return "";
  }
  const text = normalizeDirectHitlQuestionText(match[1] || "");
  if (!text || /(?:两个|几个)?问题[：:]?\s*$/u.test(text)) {
    return "";
  }
  if (text.length > 120) {
    return "";
  }
  return text;
}

function directHitlOptionsForQuestion(text: string): AssistantAwaitingQuestion["options"] | undefined {
  if (!/(桌面|文件|整理|分类|维度|方式)/u.test(text)) {
    return undefined;
  }
  return [
    { label: "按文件类型", value: "按文件类型", description: "文档、图片、视频、代码、压缩包等" },
    { label: "按项目/工作区", value: "按项目/工作区", description: "同一项目或任务放在一起" },
    { label: "按使用频率", value: "按使用频率", description: "常用、待处理、归档分开" },
    { label: "按日期", value: "按日期", description: "今天、本周、本月或更早" }
  ];
}

function buildDirectHumanInLoopQuestions(userText: string): AssistantAwaitingQuestion[] {
  let questionTexts = extractEnumeratedHitlQuestionTexts(userText);
  const tailQuestion = extractTailHitlQuestionText(userText);
  if (questionTexts.length === 0 && tailQuestion) {
    questionTexts = [tailQuestion];
  }
  if (questionTexts.length === 0 && /桌面|整理|文件/u.test(userText)) {
    questionTexts = [
      "你希望按什么维度整理桌面文件？",
      "有没有需要删除的文件？"
    ];
  }
  if (questionTexts.length === 0) {
    questionTexts = ["请补充你的选择或想法。"];
  }

  return questionTexts.slice(0, 6).map((questionText, index) => {
    const normalizedText = /[？?]$/u.test(questionText) ? questionText : `${questionText}？`;
    const options = directHitlOptionsForQuestion(normalizedText);
    return {
      id: `q${index + 1}`,
      header: `问题 ${index + 1}`,
      label: normalizedText,
      question: normalizedText,
      type: options ? "multi-select" : "text",
      required: false,
      placeholder: index === 0 ? "请输入你的偏好" : "请输入，或留空跳过",
      allowFreeText: options ? true : undefined,
      freeTextPlaceholder: options ? "其他想法" : undefined,
      options
    };
  });
}

function formatDirectHumanInLoopAnswer(answerPayload: ReturnType<typeof buildAgwQuestionAnswerPayload>) {
  const answers = Array.isArray(answerPayload.answers) ? answerPayload.answers.filter(isRecord) : [];
  const lines = answers
    .map((answer) => {
      const question = maybeString(answer.question);
      const value = Array.isArray(answer.answers)
        ? formatAgwAnswerValue(answer.answers)
        : formatAgwAnswerValue(answer.answer);
      if (!question || !value) {
        return "";
      }
      return `- ${question} ${value}`;
    })
    .filter(Boolean);
  if (lines.length === 0) {
    return "已通过 Human-in-the-loop 收到你的提交。";
  }
  return ["已通过 Human-in-the-loop 收到你的回答：", ...lines].join("\n");
}

function isGenericSearchSubmitTarget(target: string) {
  return /^(搜索|搜一下|查一下|查询|检索|百度一下|search)$/iu.test(normalizeBrowserText(target));
}

function isWebQueryRequest(userText: string) {
  return WEB_QUERY_PATTERN.test(userText);
}

function isPageContextOnlyRequest(userText: string) {
  return PAGE_CONTEXT_ONLY_PATTERN.test(userText) && !isWebQueryRequest(userText);
}

function wantsDirectAnswer(userText: string) {
  return DIRECT_ANSWER_PATTERN.test(userText);
}

function hasBrowserTarget(request: AssistantStartRunRequest) {
  return Boolean(request.pageContext?.browserTarget?.webContentsId);
}

function isSensitiveBrowserAgentTask(task: string, target?: string) {
  const combined = `${task} ${target || ""}`;
  return (
    isPotentiallySensitiveClickTarget(combined) ||
    /(删除|移除|清空|支付|付款|授权|同意|批准|保存|登录|登陆|注册|退出|注销|开通|签署|签章|提交订单|确认提交|最终提交)/u.test(combined)
  );
}

function shouldAutoFinishBrowserAction(userText: string, result: BrowserToolResult) {
  if (!result.ok) {
    return false;
  }
  if (result.action === "autofill") {
    return true;
  }
  if (result.action === "agent_execute") {
    return true;
  }
  if (result.action === "fill" && BROWSER_FORM_FILL_PATTERN.test(userText)) {
    return true;
  }
  return false;
}

function parseSmallChineseNumber(value: string) {
  const normalized = value.trim();
  if (/^\d+$/u.test(normalized)) {
    return Number(normalized);
  }
  const map = new Map([
    ["一", 1],
    ["二", 2],
    ["两", 2],
    ["三", 3],
    ["四", 4],
    ["五", 5],
    ["六", 6],
    ["七", 7],
    ["八", 8],
    ["九", 9],
    ["十", 10]
  ]);
  if (map.has(normalized)) {
    return map.get(normalized);
  }
  if (normalized.startsWith("十") && normalized.length === 2) {
    return 10 + (map.get(normalized.slice(1)) ?? 0);
  }
  if (normalized.endsWith("十") && normalized.length === 2) {
    return (map.get(normalized.slice(0, 1)) ?? 0) * 10;
  }
  const tenMatch = normalized.match(/^([一二两三四五六七八九])十([一二三四五六七八九])$/u);
  if (tenMatch) {
    return (map.get(tenMatch[1]) ?? 0) * 10 + (map.get(tenMatch[2]) ?? 0);
  }
  return undefined;
}

function requestedSearchResultCount(task: string) {
  const match = task.match(/前\s*([0-9一二两三四五六七八九十]+)\s*条/u);
  const count = match ? parseSmallChineseNumber(match[1]) : undefined;
  return count && count > 0 ? Math.min(count, 10) : undefined;
}

function pageAgentSearchRecoveryMaxSteps(task: string) {
  if (!requestedSearchResultCount(task) || !/(搜索|查找|查询|检索|百度|google|bing|结果|标题)/iu.test(task)) {
    return undefined;
  }
  return 8;
}

function searchQueryFromPageContext(pageContext: AssistantPageContext) {
  try {
    const url = new URL(pageContext.url);
    return (
      url.searchParams.get("wd") ||
      url.searchParams.get("word") ||
      url.searchParams.get("q") ||
      url.searchParams.get("query") ||
      ""
    ).trim();
  } catch {
    return "";
  }
}

function looksLikeSearchResultPage(pageContext: AssistantPageContext) {
  try {
    const url = new URL(pageContext.url);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (host.endsWith("baidu.com") && pathname === "/s" && (url.searchParams.has("wd") || url.searchParams.has("word"))) {
      return true;
    }
    if ((host.includes("google.") || host.endsWith("bing.com")) && pathname.includes("search")) {
      return true;
    }
  } catch {
    // Fall through to title-based detection.
  }
  return /搜索|search/i.test(pageContext.title);
}

function dedupeSearchResultTitle(title: string, seen: Set<string>) {
  const normalized = String(title || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[-_]\s*百度搜索$/u, "")
    .trim();
  if (!normalized || normalized.length > 160) {
    return "";
  }
  const key = normalized.toLowerCase();
  if (seen.has(key)) {
    return "";
  }
  seen.add(key);
  return normalized;
}

function extractSearchResultTitles(pageContext: AssistantPageContext, count: number) {
  const query = normalizeBrowserText(searchQueryFromPageContext(pageContext));
  const rejectPattern = /(百度热搜|搜索工具|相关搜索|上条.*满意吗|用户反馈|企业推广|展开剩余|深度思考|查看更多.*内容|查看更多.*视频)/u;
  const seen = new Set<string>();
  const headings = pageContext.headings
    .map((heading) => dedupeSearchResultTitle(heading, seen))
    .filter(Boolean)
    .filter((heading) => !rejectPattern.test(heading));
  const queryHeadings = query
    ? headings.filter((heading) => normalizeBrowserText(heading).includes(query))
    : [];
  const candidates = queryHeadings.length >= count ? queryHeadings : headings;
  return candidates.slice(0, count);
}

function extractBrowserResultLines(pageContext: AssistantPageContext, count: number) {
  const titleLines = extractSearchResultTitles(pageContext, count);
  if (titleLines.length >= count) {
    return titleLines;
  }
  const seen = new Set(titleLines.map((line) => normalizeBrowserText(line)));
  const bodyLines = pageContext.bodyText
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line && line.length <= 160)
    .filter((line) => {
      const key = normalizeBrowserText(line);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  return [...titleLines, ...bodyLines].slice(0, count);
}

function browserToolCompletionMessage(result: BrowserToolResult) {
  if (result.ok) {
    return result.message || "已完成浏览器操作。";
  }
  return result.message || `浏览器操作未完成：${result.error || "未知原因"}`;
}

function compactToolText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return value;
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]` : value;
}

function compactBrowserToolResult(result: BrowserToolResult): BrowserToolResult {
  if (!result.data || typeof result.data !== "object") {
    return result;
  }
  const data = result.data as Record<string, unknown>;
  if (result.action === "observe") {
    return {
      ...result,
      data: {
        ...data,
        bodyText: compactToolText(data.bodyText, 4000),
        elements: Array.isArray(data.elements)
          ? data.elements.slice(0, 80).map((item) => {
            const element = item as Record<string, unknown>;
            return {
              index: element.index,
              elementRef: element.elementRef,
              kind: element.kind,
              text: compactToolText(element.text, 160),
              ariaLabel: compactToolText(element.ariaLabel, 120),
              tagName: element.tagName,
              role: element.role,
              unsafe: element.unsafe
            };
          })
          : data.elements,
        fields: Array.isArray(data.fields)
          ? data.fields.slice(0, 80).map((item) => {
            const field = item as Record<string, unknown>;
            return {
              index: field.index,
              elementRef: field.elementRef,
              label: compactToolText(field.label, 160),
              tagName: field.tagName,
              type: field.type,
              role: field.role,
              value: compactToolText(field.value, 120),
              placeholder: compactToolText(field.placeholder, 160),
              required: field.required,
              options: Array.isArray(field.options) ? field.options.slice(0, 20) : field.options
            };
          })
          : data.fields
      }
    };
  }
  if (result.action === "read") {
    return {
      ...result,
      data: {
        ...data,
        selectedText: compactToolText(data.selectedText, 2000),
        metaDescription: compactToolText(data.metaDescription, 1000),
        bodyText: compactToolText(data.bodyText, 8000)
      }
    };
  }
  if (result.action === "autofill") {
    return {
      ...result,
      data: {
        generatedFields: Array.isArray(data.generatedFields) ? data.generatedFields.slice(0, 60) : data.generatedFields,
        fillResult: data.fillResult
      }
    };
  }
  if (result.action === "agent_execute") {
    const pageContext = data.pageContext && typeof data.pageContext === "object"
      ? data.pageContext as Record<string, unknown>
      : null;
    return {
      ...result,
      data: {
        success: data.success,
        finalText: compactToolText(data.finalText, 4000),
        history: Array.isArray(data.history) ? data.history.slice(-12) : data.history,
        url: data.url,
        title: data.title,
        pageContext: pageContext
          ? {
            ...pageContext,
            bodyText: compactToolText(pageContext.bodyText, 4000),
            selectedText: compactToolText(pageContext.selectedText, 1200)
          }
          : pageContext
      }
    };
  }
  return result;
}

function browserToolStatus(result: BrowserToolResult): AssistantRunEventStatus {
  if (result.ok) {
    return "ok";
  }
  return result.error === "sensitive_action_blocked" ? "blocked" : "error";
}

function isBlockedBrowserResult(result: BrowserToolResult) {
  return result.error === "sensitive_action_blocked";
}

function summarizeToolTarget(toolName: string, args: Record<string, unknown>) {
  const target = maybeString(args.target)
    || maybeString(args.label)
    || maybeString(args.field)
    || maybeString(args.elementRef)
    || maybeString(args.task)
    || maybeString(args.path)
    || maybeString(args.filename)
    || maybeString(args.command)
    || maybeString(args.title);
  if (target) {
    return target;
  }
  if (toolName === "browser_fill" && Array.isArray(args.fields)) {
    const labels = args.fields
      .map((field) => {
        if (!field || typeof field !== "object") {
          return "";
        }
        const candidate = field as Record<string, unknown>;
        return maybeString(candidate.label) || maybeString(candidate.field) || maybeString(candidate.elementRef) || "";
      })
      .filter(Boolean)
      .slice(0, 3);
    return labels.length > 0 ? labels.join("、") : undefined;
  }
  return undefined;
}

function browserToolStartMessage(toolName: string, args: Record<string, unknown>) {
  const target = summarizeToolTarget(toolName, args);
  switch (toolName) {
    case "browser_surfaces":
      return "正在查找可用网页入口。";
    case "browser_activate_surface":
      return target ? `正在打开「${target}」。` : "正在打开网页入口。";
    case "browser_observe":
      return "正在观察页面。";
    case "browser_click":
      return target ? `正在点击「${target}」。` : "正在点击页面元素。";
    case "browser_fill":
      return "正在填写字段。";
    case "browser_autofill":
      return "正在自动填写表单。";
    case "browser_agent_execute":
      return target ? `正在交给 PageAgent 处理「${target}」。` : "正在交给 PageAgent 处理浏览器任务。";
    case "browser_select":
      return target ? `正在选择「${target}」。` : "正在选择下拉项。";
    case "browser_check":
      return target ? `正在切换「${target}」。` : "正在切换选项。";
    case "browser_submit":
      return target ? `正在提交「${target}」。` : "正在提交当前页面。";
    case "browser_read":
      return "正在读取页面结果。";
    case "desktop_list_files":
      return "正在读取桌面文件列表。";
    case "desktop_read_file":
      return target ? `正在读取「${target}」。` : "正在读取文件。";
    case "desktop_read_document":
      return target ? `正在解析「${target}」。` : "正在解析文档。";
    case "desktop_create_docx":
      return target ? `准备生成 Word 文档「${target}」。` : "准备生成 Word 文档。";
    case "desktop_create_pdf":
      return target ? `准备生成 PDF「${target}」。` : "准备生成 PDF。";
    case "desktop_create_xlsx":
      return target ? `准备生成 Excel 文档「${target}」。` : "准备生成 Excel 文档。";
    case "desktop_create_pptx":
      return target ? `准备生成 PPT「${target}」。` : "准备生成 PPT。";
    case "desktop_write_file":
      return target ? `准备写入「${target}」。` : "准备写入文件。";
    case "desktop_plan_organize":
      return "正在生成桌面整理预览。";
    case "desktop_move_files":
      return "准备移动桌面文件。";
    case "bash":
      return "准备执行宿主机命令。";
    case "bash_sandbox":
      return "正在进入 Container Hub 沙箱。";
    case AGW_ASK_USER_QUESTION_TOOL_NAME:
    case LEGACY_ASK_USER_QUESTION_TOOL_NAME:
    case CLAUDE_ASK_USER_QUESTION_TOOL_NAME:
      return "正在通过 AGW 弹窗向用户提问。";
    case "artifact_publish":
      return "正在发布产物。";
    case "plan_add_tasks":
    case "plan_update_task":
      return "正在更新任务计划。";
    default:
      return `正在执行 ${toolName}。`;
  }
}

function browserToolResultMessage(result: BrowserToolResult) {
  if (result.message) {
    return result.message;
  }
  if (result.ok) {
    return "浏览器操作已完成。";
  }
  if (isBlockedBrowserResult(result)) {
    return "该操作需要用户确认后继续。";
  }
  return `浏览器操作失败：${result.error || "未知原因"}`;
}

function normalizeVoiceCorrectionOutput(content: string, fallback: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return fallback.trim();
  }
  return trimmed
    .replace(/^```(?:text)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/^(?:纠正后|修正后|校正后)[:：]\s*/u, "")
    .trim() || fallback.trim();
}

function createVoiceCorrectionResult(text: string, corrected: string, message: string): AssistantVoiceCorrectionResult {
  const rawText = text.trim();
  const correctedText = corrected.trim();
  const normalizedRaw = rawText.toLocaleLowerCase();
  const normalizedCorrected = correctedText.toLocaleLowerCase();
  const glossaryHits = ["OpenAI", "API Key", "GitHub Actions", "GitHub", "MiniMax", "React", "TypeScript", "JavaScript", "npm"]
    .filter((term) => normalizedRaw.includes(term.toLocaleLowerCase()) || normalizedCorrected.includes(term.toLocaleLowerCase()));
  const changeLevel: AssistantVoiceChangeLevel = correctedText === rawText
    ? "none"
    : Math.abs(correctedText.length - rawText.length) > Math.max(12, rawText.length * 0.35)
      ? "major"
      : "minor";

  return {
    ok: true,
    text: correctedText,
    message,
    rawText,
    correctedText,
    changeLevel,
    confidence: changeLevel === "major" ? 0.72 : 0.9,
    glossaryHits,
    uncertainTerms: []
  };
}

type ActiveRun = {
  controller: AbortController;
  chatId: string;
  text: string;
  attachments: AssistantAttachment[];
  action: AssistantStartRunRequest["action"];
  source: AssistantRunSource;
  userText: string;
  shouldAutoLearn: boolean;
  modelSettings: ReturnType<typeof readAssistantSettings>;
  completionEmitted: boolean;
  completionMessageSaved: boolean;
  postCompletionTask: Promise<void> | null;
  permissionMode: AssistantPermissionMode;
  fullAccessExpiresAt: number | null;
  seq: number;
};

export class AssistantRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingAwaitings = new Map<string, PendingAwaiting>();
  private readonly fullAccessGrants = new Map<string, number>();

  constructor(
    private readonly app: App,
    private readonly emitEvent: (event: AssistantEvent) => void,
    private readonly browserUse?: AssistantBrowserUseTool,
    private readonly dependencies: AssistantRuntimeDependencies = {}
  ) { }

  private getFullAccessExpiresAt(chatId?: string | null, now = Date.now()) {
    if (!chatId) {
      return null;
    }
    const expiresAt = this.fullAccessGrants.get(chatId) ?? null;
    if (!expiresAt) {
      return null;
    }
    if (expiresAt <= now) {
      this.fullAccessGrants.delete(chatId);
      return null;
    }
    return expiresAt;
  }

  private grantFullAccess(chatId: string, now = Date.now()) {
    const expiresAt = now + FULL_ACCESS_DURATION_MS;
    this.fullAccessGrants.set(chatId, expiresAt);
    return expiresAt;
  }

  private hasFullAccess(state: Pick<BrowserToolLoopState, "permissionMode">) {
    return state.permissionMode === "full_access";
  }

  private async requestApproval(
    state: BrowserToolLoopState,
    input: Omit<AssistantAwaitingPayload, "awaitingId" | "runId" | "chatId">
  ) {
    if (this.hasFullAccess(state)) {
      return { action: "submit", params: [], reason: "" } as AwaitingAnswer;
    }
    return this.requestAwaiting(state.runId, state.chatId, input);
  }

  getOperatorModeStatus(_chatId?: string | null) {
    return {
      active: false,
      expiresAt: null,
      remainingMs: 0
    };
  }

  async correctVoiceText(request: AssistantVoiceCorrectionRequest): Promise<AssistantVoiceCorrectionResult> {
    const text = request.text.trim();
    if (!text) {
      return {
        ok: false,
        text: "",
        message: "没有可纠正的语音文本。"
      };
    }

    const settings = loadAgentPlatformMinimaxSettings(this.app);
    if (!settings?.apiKey.trim() || !settings.baseURL.trim() || !settings.model.trim()) {
      return createVoiceCorrectionResult(text, text, "语音文本已确认。");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, VOICE_CORRECTION_TIMEOUT_MS);

    const messages: OpenAIChatMessage[] = [
      {
        role: "system",
        content: VOICE_CORRECTION_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: [
          `locale: ${request.locale}`,
          "请纠正下面的 ASR 语音识别文本，只输出纠正后的文本：",
          "<asr>",
          text,
          "</asr>"
        ].join("\n")
      }
    ];

    try {
      const response = await completeOpenAIChatCompletion({
        settings,
        messages,
        signal: controller.signal,
        toolChoice: "none"
      });
      const corrected = normalizeVoiceCorrectionOutput(response.content, text);
      return createVoiceCorrectionResult(text, corrected, corrected === text ? "语音文本已确认。" : "语音文本已纠正。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        text,
        message: `语音纠错失败，已保留原文：${message}`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async transcribeVoiceAudio(request: AssistantVoiceTranscriptionRequest): Promise<AssistantVoiceTranscriptionResult> {
    const audio = Buffer.isBuffer(request.data)
      ? Buffer.from(request.data)
      : ArrayBuffer.isView(request.data)
        ? Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength)
        : Buffer.from(request.data);
    if (audio.byteLength === 0) {
      return {
        ok: false,
        text: "",
        message: "没有录到可识别的语音。"
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, VOICE_TRANSCRIPTION_TIMEOUT_MS);

    let cloudSpeechFailure = "";
    try {
      const voiceSettings = loadAgentPlatformVoiceAsrSettings(this.app);
      if (!voiceSettings) {
        return {
          ok: false,
          text: "",
          message: MISSING_VOICE_ASR_PROVIDER_MESSAGE
        };
      }

      let cloudAudio = audio;
      let cloudMimeType = request.mimeType;
      if (process.platform === "darwin" && !/audio\/(?:wav|mpeg|mp3)/iu.test(cloudMimeType)) {
        cloudAudio = await convertAudioBufferToWavBuffer(audio, request.mimeType);
        cloudMimeType = "audio/wav";
      }
      const text = await transcribeOpenAIChatAudio({
        settings: voiceSettings,
        audio: cloudAudio,
        mimeType: cloudMimeType,
        signal: controller.signal
      });
      return {
        ok: true,
        text,
        message: "语音识别完成。",
        rawText: text,
        correctedText: text,
        changeLevel: "none",
        confidence: 0.9,
        glossaryHits: [],
        uncertainTerms: []
      };
    } catch (error) {
      cloudSpeechFailure = normalizeVoiceAsrFailure(error);
    } finally {
      clearTimeout(timer);
    }

    return {
      ok: false,
      text: "",
      message: cloudSpeechFailure
        ? `语音识别失败：${cloudSpeechFailure}`
        : MISSING_VOICE_ASR_PROVIDER_MESSAGE
    };
  }

  private stripImageDataUrl(attachment: AssistantAttachment): AssistantAttachment {
    if (!attachment.dataUrl) {
      return attachment;
    }
    const { dataUrl: _dataUrl, ...withoutDataUrl } = attachment;
    return withoutDataUrl;
  }

  private async prepareVisionAttachments({
    runId,
    chatId,
    attachments,
    settings,
    signal
  }: {
    runId: string;
    chatId: string;
    attachments: AssistantAttachment[];
    settings: ReturnType<typeof readAssistantSettings>;
    signal: AbortSignal;
  }) {
    if (!attachments.some((attachment) => attachment.dataUrl?.startsWith("data:image/"))) {
      return {
        attachments,
        changed: false
      };
    }

    let changed = false;
    const prepared: AssistantAttachment[] = [];

    for (const attachment of attachments) {
      if (!attachment.dataUrl?.startsWith("data:image/")) {
        prepared.push(attachment);
        continue;
      }

      changed = true;
      const baseDocument = attachment.document ?? {
        format: "image" as const,
        readStatus: "unreadable" as const,
        extractedChars: 0,
        truncated: false,
        imageMode: "vision" as const
      };

      if (baseDocument.visionSummary) {
        prepared.push(this.stripImageDataUrl(attachment));
        continue;
      }

      if (!canDescribeImageWithVision(settings, attachment.dataUrl)) {
        prepared.push({
          ...this.stripImageDataUrl(attachment),
          error: [attachment.error, "当前 MiniMax 配置无法调用图片理解接口，无法理解图片内容。"].filter(Boolean).join(" "),
          document: {
            ...baseDocument,
            imageMode: "vision",
            visionStatus: "unavailable",
            errorCode: baseDocument.errorCode || "vision_unavailable"
          }
        });
        continue;
      }

      const target = attachment.hidden && attachment.pageNumber
        ? `${attachment.name}（扫描 PDF 第 ${attachment.pageNumber} 页）`
        : attachment.name;
      this.emitRunEvent(runId, chatId, {
        type: "tool.start",
        status: "running",
        toolName: "vision_describe",
        action: "vision_describe",
        target,
        message: `正在识别「${target}」。`
      });

      try {
        const result = await describeImageWithVision({
          settings,
          name: target,
          dataUrl: attachment.dataUrl,
          signal
        });
        const visionText = `视觉识别结果（${target}）：\n${result.summary}`;
        prepared.push({
          ...this.stripImageDataUrl(attachment),
          text: [attachment.text, visionText].filter(Boolean).join("\n\n"),
          document: {
            ...baseDocument,
            readStatus: "readable",
            extractedChars: Math.max(baseDocument.extractedChars, result.summary.length),
            imageMode: "vision",
            visionSummary: result.summary,
            visionStatus: "readable"
          }
        });
        this.emitRunEvent(runId, chatId, {
          type: "tool.result",
          status: "ok",
          toolName: "vision_describe",
          action: "vision_describe",
          target,
          message: `已识别「${target}」。`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        prepared.push({
          ...this.stripImageDataUrl(attachment),
          error: [attachment.error, `视觉识别失败：${message}`].filter(Boolean).join(" "),
          document: {
            ...baseDocument,
            imageMode: "vision",
            visionStatus: "failed",
            errorCode: "vision_unavailable"
          }
        });
        this.emitRunEvent(runId, chatId, {
          type: "tool.result",
          status: "error",
          toolName: "vision_describe",
          action: "vision_describe",
          target,
          message: `识别「${target}」失败：${message}`,
          error: message
        });
      }
    }

    return {
      attachments: prepared,
      changed
    };
  }

  startRun(request: AssistantStartRunRequest): AssistantStartRunResult {
    const message = request.message.trim();
    if (!message) {
      return {
        ok: false,
        runId: "",
        chatId: request.chatId ?? "",
        message: "请输入要询问的内容。"
      };
    }

    const settings = loadAgentPlatformMinimaxSettings(this.app) ?? readAssistantSettings(this.app);

    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const existingChat = request.chatId ? getAssistantChat(this.app, request.chatId) : null;
    const existingMessages = existingChat?.messages ?? [];
    const historyLimitIndex = request.historyBeforeMessageId
      ? existingMessages.findIndex((item) => item.id === request.historyBeforeMessageId)
      : -1;
    const history = historyLimitIndex >= 0
      ? existingMessages.slice(0, historyLimitIndex)
      : existingMessages;
    const hydratedAttachments = hydrateAssistantAttachmentsForChat(
      this.app,
      request.chatId,
      request.attachments ?? []
    );
    const userMessage = createAssistantMessage("user", message, runId, hydratedAttachments);
    const chat = appendAssistantMessage(this.app, request.chatId, userMessage);
    const chatId = chat.summary.id;
    const controller = new AbortController();
    const now = Date.now();
    const fullAccessExpiresAt = request.permissionMode === "full_access"
      ? this.grantFullAccess(chatId, now)
      : this.getFullAccessExpiresAt(chatId, now);
    const permissionMode: AssistantPermissionMode = fullAccessExpiresAt ? "full_access" : "default";
    const source: AssistantRunSource = request.source === "quick-assistant" ? "quick-assistant" : "sidebar";
    const effectiveRequest: AssistantStartRunRequest = {
      ...request,
      source,
      permissionMode
    };

    this.activeRuns.set(runId, {
      controller,
      chatId,
      text: "",
      attachments: [],
      action: request.action ?? "chat",
      source,
      userText: message,
      shouldAutoLearn: false,
      modelSettings: settings,
      completionEmitted: false,
      completionMessageSaved: false,
      postCompletionTask: null,
      permissionMode,
      fullAccessExpiresAt,
      seq: 0
    });

    this.emitRunEvent(runId, chatId, {
      type: "request.query",
      status: "running",
      message: "已收到请求。",
      data: {
        agentKey: ZENMIND_ASSISTANT_AGENT_KEY,
        action: request.action ?? "chat",
        permissionMode
      }
    });
    this.emitRunEvent(runId, chatId, {
      type: "chat.start",
      status: "running",
      message: "已进入桌面单智能体会话。",
      data: {
        agentKey: ZENMIND_ASSISTANT_AGENT_KEY
      }
    });
    this.emitRunEvent(runId, chatId, {
      type: "run.start",
      status: "running",
      message: request.action && request.action !== "chat" ? "已开始处理页面任务。" : "已开始生成。",
      data: {
        action: request.action ?? "chat",
        hasPageContext: Boolean(request.pageContext),
        attachmentCount: request.attachments?.filter((attachment) => !attachment.hidden).length ?? 0
      }
    });

    void this.executeRun({
      runId,
      chatId,
      request: effectiveRequest,
      userMessageId: userMessage.id,
      userText: message,
      history,
      attachments: hydratedAttachments,
      settings,
      controller
    });

    return {
      ok: true,
      runId,
      chatId,
      message: "已开始生成。",
      permissionMode,
      fullAccessExpiresAt: fullAccessExpiresAt ? new Date(fullAccessExpiresAt).toISOString() : null,
      fullAccessRemainingMs: fullAccessExpiresAt ? Math.max(0, fullAccessExpiresAt - now) : 0
    };
  }

  stopRun(runId: string): AssistantStopRunResult {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return {
        ok: false,
        message: "该生成任务已结束。"
      };
    }
    activeRun.controller.abort();
    this.dismissAwaitingsForRun(runId, "运行已停止。");
    this.finishStoppedRun(runId, activeRun.chatId, "已停止生成。");
    return {
      ok: true,
      message: "已停止生成。"
    };
  }

  submitAwaiting(request: AssistantSubmitAwaitingRequest): AssistantSubmitAwaitingResult {
    const pending = this.pendingAwaitings.get(request.awaitingId);
    if (!pending) {
      return {
        ok: false,
        message: "该确认请求已结束或不存在。"
      };
    }
    if (request.runId && request.runId !== pending.runId) {
      return {
        ok: false,
        message: "该确认请求不属于当前运行任务。"
      };
    }
    if (request.chatId && request.chatId !== pending.chatId) {
      return {
        ok: false,
        message: "该确认请求不属于当前对话。"
      };
    }

    clearTimeout(pending.timer);
    this.pendingAwaitings.delete(request.awaitingId);
    const answer: AwaitingAnswer = {
      action: request.action,
      params: Array.isArray(request.params) ? request.params : [],
      reason: typeof request.reason === "string" ? request.reason : ""
    };
    const answerStatus =
      request.action === "submit" ? "answered" : request.action === "reject" ? "rejected" : "cancelled";
    this.emitRunEvent(pending.runId, pending.chatId, {
      type: "awaiting.answer",
      status: answerStatus,
      message: request.action === "submit" ? "用户已确认。" : answer.reason ? `用户已拒绝：${answer.reason}` : "用户已取消确认。",
      awaiting: pending.payload,
      awaitingId: request.awaitingId,
      mode: pending.payload.mode,
      timestamp: Date.now(),
      data: {
        awaitingId: request.awaitingId,
        runId: pending.runId,
        chatId: pending.chatId,
        status: answerStatus,
        action: request.action,
        params: answer.params,
        reason: answer.reason
      }
    });
    pending.resolve(answer);
    return {
      ok: true,
      message: "已提交确认。"
    };
  }

  private emitRunEvent(
    runId: string,
    chatId: string,
    input: Omit<AssistantRunEvent, "id" | "seq" | "runId" | "chatId" | "createdAt">
  ) {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return null;
    }
    activeRun.seq += 1;
    const event: AssistantRunEvent = {
      id: `evt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      seq: activeRun.seq,
      runId,
      chatId,
      createdAt: new Date().toISOString(),
      source: activeRun.source,
      ...input
    };
    appendAssistantEvent(this.app, event);
    this.emitEvent(event);
    return event;
  }

  private async requestAwaiting(
    runId: string,
    chatId: string,
    input: Omit<AssistantAwaitingPayload, "awaitingId" | "runId" | "chatId">
  ) {
    const awaitingId = `await_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const timeoutMs = input.timeoutMs ?? DEFAULT_AWAITING_TIMEOUT_MS;
    const payload: AssistantAwaitingPayload = {
      ...input,
      awaitingId,
      runId,
      chatId,
      createdAt: Date.now(),
      timeout: timeoutMs,
      timeoutMs
    };
    return new Promise<AwaitingAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAwaitings.delete(awaitingId);
        this.emitRunEvent(runId, chatId, {
          type: "awaiting.answer",
          status: "timeout",
          message: "确认已超时。",
          awaiting: payload,
          awaitingId,
          mode: payload.mode,
          timestamp: Date.now(),
          data: {
            awaitingId,
            runId,
            chatId,
            status: "timeout",
            action: "dismiss",
            reason: "timeout"
          }
        });
        resolve({ action: "dismiss", params: [], reason: "timeout" });
      }, timeoutMs);
      this.pendingAwaitings.set(awaitingId, {
        runId,
        chatId,
        payload,
        resolve,
        timer
      });
      this.emitRunEvent(runId, chatId, {
        type: "awaiting.ask",
        status: "waiting",
        message: payload.title,
        toolName: payload.toolName,
        action: payload.mode,
        awaiting: payload,
        awaitingId,
        mode: payload.mode,
        viewportType: payload.viewportKey ? "builtin" : undefined,
        viewportKey: payload.viewportKey,
        timeout: timeoutMs,
        timeoutMs,
        timestamp: Date.now(),
        questions: payload.questions,
        approvals: payload.approvals,
        forms: payload.forms,
        data: payload
      });
    });
  }

  private dismissAwaitingsForRun(runId: string, reason: string) {
    for (const [awaitingId, pending] of this.pendingAwaitings) {
      if (pending.runId !== runId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingAwaitings.delete(awaitingId);
      pending.resolve({ action: "dismiss", params: [], reason });
    }
  }

  private finishStoppedRun(runId: string, chatId: string, message: string) {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return;
    }
    if (activeRun.text.trim()) {
      appendAssistantMessage(this.app, chatId, createAssistantMessage("assistant", activeRun.text, runId, activeRun.attachments));
    }
    this.emitRunEvent(runId, chatId, {
      type: "run.stopped",
      status: "stopped",
      message
    });
    this.emitRunEvent(runId, chatId, {
      type: "done",
      status: "stopped",
      message: "运行已结束。"
    });
    this.activeRuns.delete(runId);
  }

  private getMemoryRootDir() {
    return this.app.getPath("userData");
  }

  private emitMemoryReferenceEvent(runId: string, chatId: string, snapshot: AssistantMemorySnapshot) {
    if (snapshot.references.length === 0) {
      return;
    }
    this.emitRunEvent(runId, chatId, {
      type: "memory.reference",
      status: "ok",
      action: "recall",
      message: `已引用 ${snapshot.references.length} 条本地记忆。`,
      data: {
        references: snapshot.references
      }
    });
  }

  private emitMemoryUpsertEvents(
    runId: string,
    chatId: string,
    result: AssistantMemoryUpsertResult,
    source: "explicit" | "auto"
  ) {
    if (result.stored.length > 0) {
      this.emitRunEvent(runId, chatId, {
        type: "memory.stored",
        status: "ok",
        action: "store",
        message: `已通过${source === "explicit" ? "显式偏好提取" : "自动学习"}保存 ${result.stored.length} 条本地记忆。`,
        data: {
          source,
          stored: result.stored
        }
      });
    }
    if (result.skipped.length > 0) {
      this.emitRunEvent(runId, chatId, {
        type: "memory.skipped",
        status: "ok",
        action: "store",
        message: `${source === "explicit" ? "显式偏好提取" : "自动学习"}跳过 ${result.skipped.length} 条低价值记忆。`,
        data: {
          source,
          skipped: result.skipped
        }
      });
    }
  }

  private prepareRunMemory(runId: string, chatId: string, userText: string, action: AssistantStartRunRequest["action"]) {
    const rootDir = this.getMemoryRootDir();
    const settings = getAssistantMemorySettingsFromRoot(rootDir);
    if (action === "chat" && settings.autoLearn) {
      try {
        const explicitResult = upsertExplicitUserMemoryFromRoot(rootDir, userText, {
          chatId,
          runId
        });
        this.emitMemoryUpsertEvents(runId, chatId, explicitResult, "explicit");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitRunEvent(runId, chatId, {
          type: "memory.skipped",
          status: "error",
          action: "store",
          message: `显式偏好提取失败：${message}`,
          error: message,
          data: {
            source: "explicit"
          }
        });
      }
    }

    try {
      const snapshot = readAssistantMemorySnapshotFromRoot(rootDir, {
        query: userText,
        chatId
      });
      this.emitMemoryReferenceEvent(runId, chatId, snapshot);
      return {
        settings,
        memory: snapshot.content
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitRunEvent(runId, chatId, {
        type: "memory.skipped",
        status: "error",
        action: "recall",
        message: `记忆召回失败：${message}`,
        error: message,
        data: {
          source: "recall"
        }
      });
      return {
        settings,
        memory: ""
      };
    }
  }

  private async learnMemoriesFromSuccessfulRun(runId: string, chatId: string, assistantText: string) {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun?.shouldAutoLearn || activeRun.action !== "chat") {
      return;
    }
    const normalizedAssistantText = assistantText.trim();
    const normalizedUserText = activeRun.userText.trim();
    if (!normalizedAssistantText || !normalizedUserText) {
      return;
    }

    const rootDir = this.getMemoryRootDir();
    const settings = getAssistantMemorySettingsFromRoot(rootDir);
    if (!settings.autoLearn) {
      return;
    }

    try {
      const response = await completeOpenAIChatCompletion({
        settings: activeRun.modelSettings,
        signal: activeRun.controller.signal,
        toolChoice: "none",
        messages: [
          {
            role: "system",
            content: MEMORY_EXTRACTION_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: [
              "<用户消息>",
              normalizedUserText,
              "</用户消息>",
              "",
              "<助手回复>",
              normalizedAssistantText,
              "</助手回复>"
            ].join("\n")
          }
        ]
      });
      const memories = parseLearnedMemoryCandidates(response.content);
      if (memories.length === 0) {
        return;
      }
      const result = upsertAssistantMemoryItemsFromRoot(rootDir, memories, {
        chatId,
        runId
      });
      this.emitMemoryUpsertEvents(runId, chatId, result, "auto");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitRunEvent(runId, chatId, {
        type: "memory.skipped",
        status: "error",
        action: "store",
        message: `自动学习失败：${message}`,
        error: message,
        data: {
          source: "auto"
        }
      });
    }
  }

  private async finalizeSuccessfulRun(runId: string, chatId: string, text?: string) {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun || activeRun.completionEmitted) {
      return;
    }
    if (typeof text === "string" && text.length > 0) {
      this.emitAssistantDelta(runId, chatId, text);
    }
    const finalText = activeRun.text;
    if (!activeRun.completionMessageSaved && (finalText.trim() || activeRun.attachments.length > 0)) {
      appendAssistantMessage(this.app, chatId, createAssistantMessage("assistant", finalText, runId, activeRun.attachments));
      activeRun.completionMessageSaved = true;
    }
    activeRun.completionEmitted = true;
    this.emitRunEvent(runId, chatId, {
      type: "run.complete",
      status: "ok",
      message: "生成完成。"
    });
    this.emitRunEvent(runId, chatId, {
      type: "done",
      status: "ok",
      message: "运行已结束。"
    });
    if (!activeRun.postCompletionTask && activeRun.shouldAutoLearn) {
      activeRun.postCompletionTask = this.learnMemoriesFromSuccessfulRun(runId, chatId, finalText);
    }
  }

  private async executeRun({
    runId,
    chatId,
    request,
    userMessageId,
    userText,
    history,
    attachments,
    settings,
    controller
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    userMessageId: string;
    userText: string;
    history: AssistantChatMessage[];
    attachments: AssistantAttachment[];
    settings: ReturnType<typeof readAssistantSettings>;
    controller: AbortController;
  }) {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return;
    }

    try {
      const memoryContext = this.prepareRunMemory(runId, chatId, userText, request.action ?? "chat");
      const currentRun = this.activeRuns.get(runId);
      if (currentRun) {
        currentRun.shouldAutoLearn = request.action === "chat" && memoryContext.settings.autoLearn;
      }
      const refreshedAttachmentContext = await refreshAssistantAttachmentsForRun(
        this.app,
        chatId,
        attachments
      );
      const visionPreparation = await this.prepareVisionAttachments({
        runId,
        chatId,
        attachments: refreshedAttachmentContext.attachments,
        settings,
        signal: controller.signal
      });
      const preparedAttachments = visionPreparation.attachments;
      if (refreshedAttachmentContext.changed || visionPreparation.changed) {
        updateAssistantMessageAttachments(this.app, chatId, userMessageId, preparedAttachments);
      }
      const messages = buildAssistantMessages({
        history,
        message: userText,
        action: request.action ?? "chat",
        pageContext: request.pageContext ?? null,
        attachments: preparedAttachments,
        memory: memoryContext.memory
      });

      if (this.shouldExecuteDirectHumanInLoop(request, userText)) {
        await this.executeDirectHumanInLoop({
          runId,
          chatId,
          request,
          userText,
          messages,
          settings,
          controller
        });
        return;
      }

      if (this.shouldExecuteDirectAutofill(request, userText)) {
        await this.executeDirectAutofill({ runId, chatId, request, userText, controller });
        return;
      }

      if (this.shouldExecuteDirectPageAgent(request, userText)) {
        await this.executeDirectPageAgent({ runId, chatId, request, userText, controller });
        return;
      }

      const browserTaskIntent = extractBrowserTaskIntent(userText);
      if (browserTaskIntent && this.canExecuteDirectBrowserTask(request, browserTaskIntent)) {
        await this.executeDirectBrowserTask({ runId, chatId, request, intent: browserTaskIntent, controller });
        return;
      }

      const browserIntent = extractBrowserIntent(userText);
      if (this.canExecuteDirectBrowserIntent(request, browserIntent)) {
        if (browserIntent?.action === "click") {
          await this.executeBrowserClick({ runId, chatId, request, target: browserIntent.target });
          return;
        }
        if (browserIntent?.action === "input") {
          await this.executeBrowserInput({
            runId,
            chatId,
            request,
            value: browserIntent.value,
            submit: browserIntent.submit,
            summarizeAfterSubmit: browserIntent.summarizeAfterSubmit,
            settings,
            controller
          });
          return;
        }
      }

      const toolRoutingText = this.buildToolRoutingText(userText, history);
      if (this.shouldUseAgentTools(toolRoutingText, request)) {
        await this.executeBrowserToolLoop({
          runId,
          chatId,
          request,
          messages,
          settings,
          controller,
          desktopOnlyTools: this.shouldUseDesktopOnlyTools(toolRoutingText, request)
        });
        return;
      }

      if (browserIntent?.action === "click") {
        await this.executeBrowserClick({ runId, chatId, request, target: browserIntent.target });
        return;
      }
      if (browserIntent?.action === "input" && !this.shouldAnswerMissingBrowserQueryFromContext(request, userText, browserIntent)) {
        await this.executeBrowserInput({
          runId,
          chatId,
          request,
          value: browserIntent.value,
          submit: browserIntent.submit,
          summarizeAfterSubmit: browserIntent.summarizeAfterSubmit,
          settings,
          controller
        });
        return;
      }

      let streamedText = "";
      await streamOpenAIChatCompletion({
        settings,
        messages,
        signal: controller.signal,
        onDelta: (delta) => {
          streamedText += delta;
        }
      });

      const pseudo = extractPseudoToolCallsFromText(streamedText, request);
      if (pseudo.hasOperatorModeRequest && pseudo.toolCalls.length === 0) {
        await this.completeWithAssistantText(runId, chatId, operatorModePseudoFallbackMessage());
        return;
      }
      if (pseudo.toolCalls.length > 0) {
        await this.executePseudoToolCalls({
          runId,
          chatId,
          request,
          messages,
          settings,
          controller,
          pseudo
        });
        return;
      }

      if (streamedText) {
        this.emitAssistantDelta(runId, chatId, streamedText);
      }

      await this.finishAssistantRun(runId, chatId);
    } catch (error) {
      if (controller.signal.aborted) {
        this.finishStoppedRun(runId, chatId, "已停止生成。");
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const activeRun = this.activeRuns.get(runId);
      if (!activeRun?.text.trim()) {
        appendAssistantMessage(this.app, chatId, createAssistantMessage("assistant", `生成失败：${errorMessage}`, runId));
      }
      this.emitRunEvent(runId, chatId, {
        type: "run.error",
        status: "error",
        message: `生成失败：${errorMessage}`,
        error: errorMessage
      });
      this.emitRunEvent(runId, chatId, {
        type: "done",
        status: "error",
        message: "运行已结束。"
      });
    } finally {
      this.dismissAwaitingsForRun(runId, "运行已结束。");
      const finalRun = this.activeRuns.get(runId);
      if (finalRun?.postCompletionTask) {
        await finalRun.postCompletionTask;
      }
      this.activeRuns.delete(runId);
    }
  }

  private async completeWithAssistantText(runId: string, chatId: string, text: string) {
    await this.finalizeSuccessfulRun(runId, chatId, text);
  }

  private emitAssistantDelta(runId: string, chatId: string, text: string) {
    const currentRun = this.activeRuns.get(runId);
    if (!currentRun) {
      return;
    }
    currentRun.text += text;
    this.emitRunEvent(runId, chatId, {
      type: "content.delta",
      status: "running",
      delta: text
    });
  }

  private async finishAssistantRun(runId: string, chatId: string) {
    await this.finalizeSuccessfulRun(runId, chatId);
  }

  private shouldUseAgentTools(userText: string, request: AssistantStartRunRequest) {
    if (request.action !== "chat") {
      return false;
    }
    if (wantsDirectAnswer(userText) || isPageContextOnlyRequest(userText)) {
      return false;
    }
    if (HUMAN_IN_LOOP_PATTERN.test(userText) || DESKTOP_ACTION_PATTERN.test(userText)) {
      return true;
    }
    if (this.shouldKeepAttachmentQuestionLocal(request, userText)) {
      return false;
    }
    const hasBrowserTooling = Boolean(
      this.browserUse?.observePage ||
      this.browserUse?.listSurfaces ||
      this.browserUse?.executeAgentTask ||
      this.browserUse?.click ||
      this.browserUse?.fillFields ||
      this.browserUse?.autofillForm ||
      this.browserUse?.submit
    );
    if (!hasBrowserTooling || !BROWSER_ACTION_PATTERN.test(userText)) {
      return false;
    }
    const canResolveBrowserTarget = hasBrowserTarget(request) || Boolean(this.browserUse?.listSurfaces || this.browserUse?.activateSurface);
    if (!canResolveBrowserTarget) {
      return false;
    }
    const browserIntent = extractBrowserIntent(userText);
    if (browserIntent?.action === "click" && isPotentiallySensitiveClickTarget(browserIntent.target)) {
      return false;
    }
    return true;
  }

  private buildToolRoutingText(userText: string, history: AssistantChatMessage[]) {
    const recent = history.slice(-4).map((message) => message.content).join("\n");
    if (!recent) {
      return userText;
    }
    const officeFollowUp = /(word|excel|pdf|ppt|docx|xlsx|pptx|文档|表格|幻灯片|演示|生成|创建)/iu.test(recent) &&
      !EXPLICIT_WEB_SURFACE_PATTERN.test(userText);
    return officeFollowUp ? `${recent}\n${userText}` : userText;
  }

  private shouldUseDesktopOnlyTools(userText: string, request: AssistantStartRunRequest) {
    return Boolean(
      this.shouldKeepAttachmentQuestionLocal(request, userText) ||
      (DESKTOP_ACTION_PATTERN.test(userText) && !EXPLICIT_WEB_SURFACE_PATTERN.test(userText))
    );
  }

  private shouldKeepAttachmentQuestionLocal(request: AssistantStartRunRequest, userText: string) {
    const hasAttachments = Array.isArray(request.attachments) &&
      request.attachments.some((attachment) => attachment.kind !== "artifact" && !attachment.hidden);
    return Boolean(
      hasAttachments &&
      ATTACHMENT_CONTEXT_PATTERN.test(userText) &&
      !EXPLICIT_WEB_SURFACE_PATTERN.test(userText)
    );
  }

  private shouldAnswerMissingBrowserQueryFromContext(
    request: AssistantStartRunRequest,
    userText: string,
    browserIntent: ReturnType<typeof extractBrowserIntent>
  ) {
    return Boolean(
      request.action === "chat" &&
      browserIntent?.action === "input" &&
      browserIntent.submit &&
      isWebQueryRequest(userText) &&
      !hasBrowserTarget(request)
    );
  }

  private shouldExecuteDirectHumanInLoop(request: AssistantStartRunRequest, userText: string) {
    return request.action === "chat" && HUMAN_IN_LOOP_PATTERN.test(userText);
  }

  private canExecuteDirectBrowserIntent(
    request: AssistantStartRunRequest,
    browserIntent: ReturnType<typeof extractBrowserIntent>
  ) {
    if (request.action !== "chat" || !browserIntent || !this.browserUse) {
      return false;
    }
    const webContentsId = request.pageContext?.browserTarget?.webContentsId;
    if (!webContentsId) {
      return false;
    }
    if (browserIntent.action === "click") {
      if (isPotentiallySensitiveClickTarget(browserIntent.target)) {
        return false;
      }
      return Boolean(this.browserUse.clickElementByText);
    }
    return browserIntent.submit
      ? Boolean(this.browserUse.fillBestInputAndSubmit)
      : Boolean(this.browserUse.fillBestInput);
  }

  private shouldExecuteDirectAutofill(request: AssistantStartRunRequest, userText: string) {
    const webContentsId = request.pageContext?.browserTarget?.webContentsId;
    return Boolean(
      request.action === "chat" &&
      webContentsId &&
      this.browserUse?.autofillForm &&
      BROWSER_FORM_FILL_PATTERN.test(userText)
    );
  }

  private shouldExecuteDirectPageAgent(request: AssistantStartRunRequest, userText: string) {
    return Boolean(
      request.action === "chat" &&
      request.pageContext?.browserTarget?.webContentsId &&
      this.browserUse?.executeAgentTask &&
      EXPLICIT_PAGE_AGENT_PATTERN.test(userText) &&
      BROWSER_ACTION_PATTERN.test(userText)
    );
  }

  private canExecuteDirectBrowserTask(request: AssistantStartRunRequest, intent: BrowserTaskIntent) {
    if (request.action !== "chat") {
      return false;
    }
    if (intent.kind === "service_control") {
      return Boolean(this.dependencies.services?.control);
    }
    if (intent.kind === "open_url" || intent.kind === "navigate_current") {
      if (/快照|snapshot|cdp/i.test(request.message || "")) {
        return Boolean(
          request.pageContext?.browserTarget?.webContentsId &&
          this.browserUse?.navigateUrl &&
          this.browserUse?.createRuntimeSnapshot
        );
      }
      return Boolean(
        this.dependencies.openExternalUrl ||
        this.browserUse?.openUrl ||
        (request.pageContext?.browserTarget?.webContentsId && this.browserUse?.navigateUrl)
      );
    }
    return Boolean(
      this.browserUse?.fillBestInputAndSubmit &&
      (request.pageContext?.browserTarget?.webContentsId || this.browserUse.openUrl || intent.kind === "extract")
    );
  }

  private websiteMatchesCurrentTarget(request: AssistantStartRunRequest, website: BrowserTaskWebsite) {
    const currentUrl = request.pageContext?.browserTarget?.currentUrl || request.pageContext?.url || "";
    try {
      const current = new URL(currentUrl);
      const target = new URL(website.url);
      return current.hostname.replace(/^www\./u, "") === target.hostname.replace(/^www\./u, "");
    } catch {
      return false;
    }
  }

  private webContentsIdFromBrowserResult(result: BrowserToolResult) {
    const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? result.data as { surface?: { webContentsId?: unknown } }
      : {};
    return typeof data.surface?.webContentsId === "number" ? data.surface.webContentsId : null;
  }

  private emitDirectToolResult(runId: string, chatId: string, toolName: string, result: BrowserToolResult) {
    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: browserToolStatus(result),
      toolName,
      action: result.action,
      target: result.target,
      message: browserToolResultMessage(result),
      error: result.error,
      data: compactBrowserToolResult(result)
    });
  }

  private async executeDirectBrowserTask({
    runId,
    chatId,
    request,
    intent,
    controller
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    intent: BrowserTaskIntent;
    controller: AbortController;
  }) {
    if (intent.kind === "service_control") {
      await this.executeDirectServiceControl({ runId, chatId, intent });
      return;
    }

    if (intent.kind === "open_url" || intent.kind === "navigate_current") {
      await this.executeDirectBrowserOpen({ runId, chatId, request, url: intent.url, label: intent.label });
      return;
    }

    let webContentsId = request.pageContext?.browserTarget?.webContentsId ?? null;
    const website = (intent.kind === "site_search" || intent.kind === "compound") ? intent.website : undefined;
    if (website && webContentsId && !this.websiteMatchesCurrentTarget(request, website) && this.browserUse?.navigateUrl) {
      this.emitRunEvent(runId, chatId, {
        type: "tool.start",
        status: "running",
        toolName: "browser_navigate",
        action: "navigate",
        target: website.url,
        message: `正在当前左侧网页打开${website.label}。`
      });
      const navigateResult = await this.browserUse.navigateUrl(webContentsId, { url: website.url, label: website.label });
      this.emitDirectToolResult(runId, chatId, "browser_navigate", navigateResult);
      if (!navigateResult.ok) {
        await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(navigateResult));
        return;
      }
    } else if (website && !webContentsId && this.browserUse?.openUrl) {
      this.emitRunEvent(runId, chatId, {
        type: "tool.start",
        status: "running",
        toolName: "open_url",
        action: "open_url",
        target: website.url,
        message: `正在打开${website.label}。`
      });
      const openResult = await this.browserUse.openUrl({ url: website.url, label: website.label });
      this.emitDirectToolResult(runId, chatId, "open_url", openResult);
      webContentsId = this.webContentsIdFromBrowserResult(openResult);
      if (!openResult.ok || !webContentsId) {
        await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(openResult));
        return;
      }
    }

    const query = (intent.kind === "site_search" || intent.kind === "compound") ? intent.query : undefined;
    if (query) {
      if (!webContentsId || !this.browserUse?.fillBestInputAndSubmit) {
        const result = this.missingBrowserTargetResult("input");
        this.emitDirectToolResult(runId, chatId, "browser_input", result);
        await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
        return;
      }
      this.emitRunEvent(runId, chatId, {
        type: "tool.start",
        status: "running",
        toolName: "browser_input",
        action: "input",
        target: query,
        message: `正在搜索“${query}”。`
      });
      const inputResult = await this.browserUse.fillBestInputAndSubmit(webContentsId, query);
      const normalizedInputResult: BrowserToolResult = {
        ok: inputResult.ok,
        action: inputResult.submitted ? "submit" : "fill",
        target: query,
        message: inputResult.message || `已在输入框输入“${query}”${inputResult.submitted ? "并提交" : ""}。`,
        data: inputResult
      };
      this.emitDirectToolResult(runId, chatId, "browser_input", normalizedInputResult);
      if (!normalizedInputResult.ok || controller.signal.aborted) {
        await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(normalizedInputResult));
        return;
      }
    }

    const extraction = intent.kind === "compound" || intent.kind === "extract"
      ? intent.extraction
      : query && /(告诉我|返回|结果|记过|发给我|总结|概括)/u.test(request.message)
        ? { kind: "search_results" as const, count: 5, itemLabel: "结果" }
        : undefined;
    if (extraction) {
      if (!webContentsId || !this.browserUse?.readPageContext) {
        const result = this.missingBrowserTargetResult("read_page");
        this.emitDirectToolResult(runId, chatId, "browser_read_page", result);
        await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
        return;
      }
      if (this.browserUse.extractPage) {
        const extracted = await this.browserUse.extractPage(webContentsId, extraction);
        if (extracted.ok && extracted.items.length > 0) {
          const lines = extracted.items.slice(0, extraction.count).map((item) => item.title);
          const message = `已完成搜索并读取到前 ${lines.length} 条${extraction.itemLabel}。`;
          this.emitDirectToolResult(runId, chatId, "browser_read_page", {
            ok: true,
            action: "read_page",
            message,
            data: extracted
          });
          await this.completeWithAssistantText(runId, chatId, `${message}\n${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`);
          return;
        }
      }
      const pageContext = await this.browserUse.readPageContext(webContentsId);
      const lines = pageContext ? extractBrowserResultLines(pageContext, extraction.count) : [];
      const result: BrowserToolResult = {
        ok: lines.length > 0,
        action: "read_page",
        title: pageContext?.title,
        message: lines.length > 0
          ? `已完成搜索并读取到前 ${lines.length} 条${extraction.itemLabel}。`
          : "已读取页面，但没有找到可提取的结果。",
        data: { lines, pageContext }
      };
      this.emitDirectToolResult(runId, chatId, "browser_read_page", result);
      const list = lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
      await this.completeWithAssistantText(runId, chatId, list ? `${result.message}\n${list}` : result.message || "没有读取到结果。");
      return;
    }

    await this.completeWithAssistantText(runId, chatId, query ? `已在输入框输入“${query}”并提交。` : "已完成浏览器操作。");
  }

  private async executeDirectBrowserOpen({
    runId,
    chatId,
    request,
    url,
    label
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    url: string;
    label: string;
  }) {
    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolName: "open_url",
      action: "open_url",
      target: url,
      message: `正在打开${label}。`
    });
    const webContentsId = request.pageContext?.browserTarget?.webContentsId ?? null;
    if (webContentsId && this.browserUse?.navigateUrl) {
      const navigationLabel = /example\.com/iu.test(url) ? "Example" : label;
      const result = await this.browserUse.navigateUrl(webContentsId, { url, label: navigationLabel });
      this.emitDirectToolResult(runId, chatId, "open_url", result);
      if (result.ok && /快照|snapshot|cdp/i.test(request.message || "") && this.browserUse.createRuntimeSnapshot) {
        const snapshot = await this.browserUse.createRuntimeSnapshot(webContentsId);
        this.emitRunEvent(runId, chatId, {
          type: "tool.result",
          status: "ok",
          toolName: "browser_snapshot",
          action: "snapshot",
          target: url,
          message: "已获取当前网页快照。",
          data: snapshot
        });
        await this.completeWithAssistantText(runId, chatId, `已在当前左侧 Chrome 页面访问 ${navigationLabel} 并获取快照。`);
        return;
      }
      await this.completeWithAssistantText(runId, chatId, result.ok ? `已在当前左侧网页打开${label}。` : browserToolCompletionMessage(result));
      return;
    }
    if (this.browserUse?.openUrl && /当前窗口|当前浏览器|浏览器|Chrome|chrome/u.test(request.message || "")) {
      const result = await this.browserUse.openUrl({ url, label });
      this.emitDirectToolResult(runId, chatId, "open_url", result);
      await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
      return;
    }
    if (!this.dependencies.openExternalUrl) {
      const result = this.missingBrowserTargetResult("open_url");
      this.emitDirectToolResult(runId, chatId, "open_url", result);
      await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
      return;
    }
    await this.dependencies.openExternalUrl(url);
    const result: BrowserToolResult = {
      ok: true,
      action: "open_url",
      target: url,
      url,
      message: `已打开${label}。`
    };
    this.emitDirectToolResult(runId, chatId, "open_url", result);
    await this.completeWithAssistantText(runId, chatId, result.message || `已打开${label}。`);
  }

  private async executeDirectServiceControl({
    runId,
    chatId,
    intent
  }: {
    runId: string;
    chatId: string;
    intent: Extract<BrowserTaskIntent, { kind: "service_control" }>;
  }) {
    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolName: "service_control",
      action: intent.operation,
      target: intent.serviceId,
      message: "正在控制 Desktop 托管服务。"
    });
    const result = await this.dependencies.services?.control?.(intent.serviceId, intent.operation);
    const toolResult: BrowserToolResult = {
      ok: Boolean(result?.ok),
      action: intent.operation,
      target: intent.serviceId,
      message: result?.message || "服务控制未完成。",
      error: result?.ok ? undefined : result?.message,
      data: result
    };
    this.emitDirectToolResult(runId, chatId, "service_control", toolResult);
    if (result?.verification) {
      const verified = result.verification.verified;
      this.emitRunEvent(runId, chatId, {
        type: "tool.result",
        status: verified ? "ok" : "error",
        toolName: "service_verify",
        action: "verify",
        target: intent.serviceId,
        message: verified ? "服务状态复查通过。" : "服务状态复查失败。",
        error: verified ? undefined : result.verification.issues?.join("；"),
        data: result.verification
      });
    }
    await this.completeWithAssistantText(runId, chatId, result?.message || "服务控制未完成。");
  }

  private async executeDirectHumanInLoop({
    runId,
    chatId,
    request,
    userText,
    messages,
    settings,
    controller
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    userText: string;
    messages: ReturnType<typeof buildAssistantMessages>;
    settings: ReturnType<typeof readAssistantSettings>;
    controller: AbortController;
  }) {
    const toolCallId = `direct_hitl_${Date.now().toString(36)}`;
    const questions = buildDirectHumanInLoopQuestions(userText);
    const args = {
      mode: "question",
      questions
    };

    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolCallId,
      toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
      action: AGW_ASK_USER_QUESTION_TOOL_NAME,
      message: browserToolStartMessage(AGW_ASK_USER_QUESTION_TOOL_NAME, args)
    });
    this.emitRunEvent(runId, chatId, {
      type: "tool.args",
      status: "running",
      toolCallId,
      toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
      action: AGW_ASK_USER_QUESTION_TOOL_NAME,
      data: args
    });

    if (controller.signal.aborted) {
      throw new Error("aborted");
    }
    const answer = await this.requestAwaiting(runId, chatId, {
      mode: "question",
      title: "Human-in-the-loop 采访",
      description: "请在弹窗中回答这些问题，提交后助手会继续处理。",
      toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
      questions
    });
    if (controller.signal.aborted) {
      throw new Error("aborted");
    }

    if (answer.action !== "submit") {
      const result = this.userCancelledToolResult(AGW_ASK_USER_QUESTION_TOOL_NAME, answer);
      this.emitRunEvent(runId, chatId, {
        type: "tool.result",
        status: "stopped",
        toolCallId,
        toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
        action: AGW_ASK_USER_QUESTION_TOOL_NAME,
        message: result.message,
        error: result.error,
        data: result
      });
      this.emitRunEvent(runId, chatId, {
        type: "tool.end",
        status: "stopped",
        toolCallId,
        toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
        action: AGW_ASK_USER_QUESTION_TOOL_NAME,
        message: result.message,
        error: result.error
      });
      await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
      return;
    }

    const answerPayload = buildAgwQuestionAnswerPayload(questions, answer.params);
    const result: BrowserToolResult = {
      ok: true,
      action: AGW_ASK_USER_QUESTION_TOOL_NAME,
      message: "用户已通过 AGW 弹窗提交信息。",
      data: answerPayload
    };
    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: "ok",
      toolCallId,
      toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
      action: AGW_ASK_USER_QUESTION_TOOL_NAME,
      message: result.message,
      data: answerPayload
    });
    this.emitRunEvent(runId, chatId, {
      type: "tool.end",
      status: "ok",
      toolCallId,
      toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
      action: AGW_ASK_USER_QUESTION_TOOL_NAME,
      message: result.message
    });
    await this.executeBrowserToolLoop({
      runId,
      chatId,
      request,
      messages,
      settings,
      controller,
      extraMessages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name: AGW_ASK_USER_QUESTION_TOOL_NAME,
                arguments: JSON.stringify(args)
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: toolCallId,
          name: AGW_ASK_USER_QUESTION_TOOL_NAME,
          content: this.stringifyToolResult({
            ...result,
            message: [
              result.message,
              "Human-in-the-loop 已完成，请基于 data.updatedInput.answers 继续完成原始用户目标；不要只回复已收到。"
            ].join(" ")
          })
        }
      ]
    });
  }

  private async executeDirectAutofill({
    runId,
    chatId,
    request,
    userText,
    controller
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    userText: string;
    controller: AbortController;
  }) {
    const webContentsId = request.pageContext?.browserTarget?.webContentsId;
    if (!webContentsId || !this.browserUse?.autofillForm) {
      return;
    }
    const submit = !/(不用提交|不要提交|别提交|不提交|无需提交|先别提交)/u.test(userText)
      && /(提交|保存|确认提交)/u.test(userText);
    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolName: "browser_autofill",
      action: "autofill",
      message: "正在自动填写表单。"
    });
    if (controller.signal.aborted) {
      throw new Error("aborted");
    }
    const result = await this.browserUse.autofillForm(webContentsId, {
      instruction: userText,
      skill: request.pageContext?.browserTarget?.browserSkill,
      submit
    });
    if (controller.signal.aborted) {
      throw new Error("aborted");
    }
    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: browserToolStatus(result),
      toolName: "browser_autofill",
      action: result.action,
      target: result.target,
      message: browserToolResultMessage(result),
      error: result.error,
      data: compactBrowserToolResult(result)
    });
    if (isBlockedBrowserResult(result)) {
      this.emitRunEvent(runId, chatId, {
        type: "awaiting.confirm",
        status: "blocked",
        toolName: "browser_autofill",
        action: result.action,
        target: result.target,
        message: result.message || "表单提交需要用户确认。"
      });
    }
    await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
  }

  private async executeDirectPageAgent({
    runId,
    chatId,
    request,
    userText,
    controller
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    userText: string;
    controller: AbortController;
  }) {
    const toolCallId = `direct_page_agent_${Date.now().toString(36)}`;
    const toolName = "browser_agent_execute";
    const task = userText.trim();
    const webContentsId = request.pageContext?.browserTarget?.webContentsId ?? null;
    const args = { task };

    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolCallId,
      toolName,
      action: toolName,
      target: task,
      message: browserToolStartMessage(toolName, args)
    });
    this.emitRunEvent(runId, chatId, {
      type: "tool.args",
      status: "running",
      toolCallId,
      toolName,
      action: toolName,
      target: task,
      data: args
    });

    const runAgent = (allowSensitive: boolean) => this.browserUse?.executeAgentTask?.(webContentsId ?? 0, {
      task,
      allowSensitive,
      systemInstruction: DIRECT_PAGE_AGENT_SYSTEM_INSTRUCTION,
      ...(pageAgentSearchRecoveryMaxSteps(task) ? { maxSteps: pageAgentSearchRecoveryMaxSteps(task) } : {})
    }, {
      signal: controller.signal,
      onEvent: (event) => {
        this.emitRunEvent(runId, chatId, {
          type: "tool.result",
          status: "running",
          toolCallId,
          toolName,
          action: `agent_execute.${event.type || "progress"}`,
          target: task,
          message: event.message || "PageAgent 进度已更新。",
          data: event
        });
      }
    });

    const runFullAccess = this.activeRuns.get(runId)?.permissionMode === "full_access";
    let result: BrowserToolResult;
    if (!this.browserUse?.executeAgentTask || !webContentsId) {
      result = this.missingBrowserTargetResult("agent_execute");
    } else if (isSensitiveBrowserAgentTask(task) && !runFullAccess) {
      const answer = await this.requestAwaiting(runId, chatId, {
        mode: "approval",
        title: "确认 PageAgent 敏感网页操作",
        description: "PageAgent 准备执行可能涉及提交、保存、登录、授权或删除的网页任务。",
        toolName,
        approval: {
          summary: task,
          risk: "会在当前网页中自动执行敏感操作，可能修改线上数据或账号状态。"
        }
      });
      result = answer.action === "submit"
        ? await runAgent(true) ?? this.missingBrowserTargetResult("agent_execute")
        : this.userCancelledToolResult("agent_execute", answer);
    } else {
      result = await runAgent(runFullAccess && isSensitiveBrowserAgentTask(task)) ?? this.missingBrowserTargetResult("agent_execute");
    }

    if (controller.signal.aborted) {
      throw new Error("aborted");
    }
    result = await this.recoverPageAgentSearchResult(result, task, webContentsId);
    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: browserToolStatus(result),
      toolCallId,
      toolName,
      action: result.action,
      target: result.target ?? task,
      message: browserToolResultMessage(result),
      error: result.error,
      data: compactBrowserToolResult(result)
    });
    this.emitRunEvent(runId, chatId, {
      type: "tool.end",
      status: browserToolStatus(result),
      toolCallId,
      toolName,
      action: result.action,
      target: result.target ?? task,
      message: browserToolResultMessage(result),
      error: result.error
    });
    await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
  }

  private async recoverPageAgentSearchResult(
    result: BrowserToolResult,
    task: string,
    webContentsId: number | null
  ): Promise<BrowserToolResult> {
    if (result.ok || result.action !== "agent_execute" || !webContentsId || !this.browserUse?.readPageContext) {
      return result;
    }
    const count = requestedSearchResultCount(task);
    if (!count || !/(搜索|查找|查询|检索|百度|google|bing|结果|标题)/iu.test(task)) {
      return result;
    }

    const pageContext = await this.browserUse.readPageContext(webContentsId).catch(() => null);
    if (!pageContext || !looksLikeSearchResultPage(pageContext)) {
      return result;
    }
    const titles = extractSearchResultTitles(pageContext, count);
    if (titles.length < count) {
      return result;
    }

    const finalText = [
      `PageAgent 已完成网页搜索，并从当前结果页读取到前 ${titles.length} 条标题：`,
      ...titles.map((title, index) => `${index + 1}. ${title}`)
    ].join("\n");
    const previousData = result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : {};
    return {
      ...result,
      ok: true,
      error: undefined,
      message: finalText,
      url: pageContext.url,
      title: pageContext.title,
      data: {
        ...previousData,
        success: true,
        recovered: true,
        recoveredFromError: result.error,
        finalText,
        titles,
        url: pageContext.url,
        title: pageContext.title,
        pageContext
      }
    };
  }

  private buildBrowserToolMessages(messages: OpenAIChatMessage[]) {
    const [first, ...rest] = messages;
    const toolPrompt = `${BROWSER_TOOL_SYSTEM_PROMPT}\n\n${DESKTOP_AGENT_SYSTEM_PROMPT}`;
    if (first?.role === "system" && typeof first.content === "string") {
      return [
        {
          ...first,
          content: `${first.content}\n\n${toolPrompt}`
        },
        ...rest
      ] satisfies OpenAIChatMessage[];
    }
    return [
      {
        role: "system",
        content: toolPrompt
      },
      ...messages
    ] satisfies OpenAIChatMessage[];
  }

  private async executeBrowserToolLoop({
    runId,
    chatId,
    request,
    messages,
    settings,
    controller,
    extraMessages = [],
    desktopOnlyTools = false
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    messages: ReturnType<typeof buildAssistantMessages>;
    settings: ReturnType<typeof readAssistantSettings>;
    controller: AbortController;
    extraMessages?: OpenAIChatMessage[];
    desktopOnlyTools?: boolean;
  }) {
    const loopMessages: OpenAIChatMessage[] = [
      ...this.buildBrowserToolMessages(messages),
      ...extraMessages
    ];
    const state: BrowserToolLoopState = {
      pageContext: request.pageContext ?? null,
      webContentsId: request.pageContext?.browserTarget?.webContentsId ?? null,
      userText: request.message,
      lastResult: null,
      runId,
      chatId,
      permissionMode: this.activeRuns.get(runId)?.permissionMode ?? "default",
      abortSignal: controller.signal,
      tasks: []
    };
    const repeatedToolCalls = new Map<string, number>();

    for (let step = 0; step < MAX_BROWSER_TOOL_STEPS; step += 1) {
      if (controller.signal.aborted) {
        throw new Error("aborted");
      }

      const completion = await completeOpenAIChatCompletion({
        settings,
        messages: loopMessages,
        tools: desktopOnlyTools ? DESKTOP_TOOL_DEFINITIONS : AGENT_TOOL_DEFINITIONS,
        signal: controller.signal
      });
      const pseudo = completion.tool_calls.length === 0
        ? extractPseudoToolCallsFromText(completion.content, request)
        : null;
      if (pseudo?.hasOperatorModeRequest && pseudo.toolCalls.length === 0) {
        await this.completeWithAssistantText(runId, chatId, operatorModePseudoFallbackMessage());
        return;
      }
      if (pseudo?.toolCalls.length) {
        completion.content = pseudo.visibleText;
        completion.tool_calls = pseudo.toolCalls;
      }

      if (completion.tool_calls.length === 0) {
        const hasArtifacts = (this.activeRuns.get(runId)?.attachments.length ?? 0) > 0;
        await this.completeWithAssistantText(
          runId,
          chatId,
          completion.content.trim() || (hasArtifacts ? "已生成以下产物。" : "已完成浏览器操作。")
        );
        return;
      }

      loopMessages.push({
        role: "assistant",
        content: completion.content || null,
        tool_calls: completion.tool_calls
      });

      for (const toolCall of completion.tool_calls) {
        const toolArgs = this.parseToolArgs(toolCall);
        const signature = `${toolCall.function.name}:${toolCall.function.arguments || "{}"}`;
        const repeatCount = (repeatedToolCalls.get(signature) ?? 0) + 1;
        repeatedToolCalls.set(signature, repeatCount);
        if (repeatCount >= 4) {
          this.emitRunEvent(runId, chatId, {
            type: "tool.result",
            status: "stopped",
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            action: toolCall.function.name,
            target: summarizeToolTarget(toolCall.function.name, toolArgs),
            message: "检测到模型重复同一个浏览器操作，已停止继续循环。"
          });
          await this.completeWithAssistantText(
            runId,
            chatId,
            state.lastResult
              ? `${browserToolCompletionMessage(state.lastResult)}\n\n我检测到模型在重复同一个浏览器操作，已停止继续循环。`
              : "我检测到模型在重复同一个浏览器操作，已停止继续循环。"
          );
          return;
        }

        this.emitRunEvent(runId, chatId, {
          type: "tool.start",
          status: "running",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          action: toolCall.function.name,
          target: summarizeToolTarget(toolCall.function.name, toolArgs),
          message: browserToolStartMessage(toolCall.function.name, toolArgs)
        });
        this.emitRunEvent(runId, chatId, {
          type: "tool.args",
          status: "running",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          action: toolCall.function.name,
          target: summarizeToolTarget(toolCall.function.name, toolArgs),
          data: toolArgs
        });
        const result = await this.executeBrowserTool(toolCall, state);
        if (controller.signal.aborted) {
          throw new Error("aborted");
        }
        state.lastResult = result;
        const compactResult = compactBrowserToolResult(result);
        this.emitRunEvent(runId, chatId, {
          type: "tool.result",
          status: browserToolStatus(result),
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          action: result.action,
          target: result.target ?? summarizeToolTarget(toolCall.function.name, toolArgs),
          message: browserToolResultMessage(result),
          error: result.error,
          data: compactResult
        });
        if (isBlockedBrowserResult(result)) {
          this.emitRunEvent(runId, chatId, {
            type: "awaiting.confirm",
            status: "blocked",
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            action: result.action,
            target: result.target ?? summarizeToolTarget(toolCall.function.name, toolArgs),
            message: result.message || "这个页面操作需要你确认后再继续。"
          });
        }
        this.emitRunEvent(runId, chatId, {
          type: "tool.end",
          status: browserToolStatus(result),
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          action: result.action,
          target: result.target ?? summarizeToolTarget(toolCall.function.name, toolArgs),
          message: browserToolResultMessage(result),
          error: result.error
        });
        loopMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: this.stringifyToolResult(result)
        });

        if (shouldAutoFinishBrowserAction(request.message, result)) {
          await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
          return;
        }
        if (result.error === "user_rejected" || result.error === "user_dismissed") {
          await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
          return;
        }
      }
    }

    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: "stopped",
      action: "browser_tool_loop",
      message: state.lastResult
        ? `${browserToolCompletionMessage(state.lastResult)} 浏览器操作步骤已达到上限。`
        : "浏览器操作步骤已达到上限。"
    });
    await this.completeWithAssistantText(
      runId,
      chatId,
      state.lastResult
        ? `${browserToolCompletionMessage(state.lastResult)}\n\n浏览器操作步骤已达到上限，我已停止继续自动操作。`
        : "浏览器操作步骤已达到上限。我已经停止继续自动操作，请确认当前页面状态后再继续。"
    );
  }

  private stringifyToolResult(result: BrowserToolResult) {
    const text = JSON.stringify(compactBrowserToolResult(result));
    if (text.length <= 12000) {
      return text;
    }
    return `${text.slice(0, 12000)}...[tool result truncated ${text.length - 12000} chars]`;
  }

  private async executePseudoToolCalls({
    runId,
    chatId,
    request,
    messages,
    settings,
    controller,
    pseudo
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    messages: ReturnType<typeof buildAssistantMessages>;
    settings: ReturnType<typeof readAssistantSettings>;
    controller: AbortController;
    pseudo: ReturnType<typeof extractPseudoToolCallsFromText>;
  }) {
    const state: BrowserToolLoopState = {
      pageContext: request.pageContext ?? null,
      webContentsId: request.pageContext?.browserTarget?.webContentsId ?? null,
      userText: request.message,
      lastResult: null,
      runId,
      chatId,
      permissionMode: this.activeRuns.get(runId)?.permissionMode ?? "default",
      abortSignal: controller.signal,
      tasks: []
    };
    const extraMessages: OpenAIChatMessage[] = [{
      role: "assistant",
      content: pseudo.visibleText || null,
      tool_calls: pseudo.toolCalls
    }];

    for (const toolCall of pseudo.toolCalls) {
      if (controller.signal.aborted) {
        throw new Error("aborted");
      }
      const toolArgs = this.parseToolArgs(toolCall);
      this.emitRunEvent(runId, chatId, {
        type: "tool.start",
        status: "running",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        action: toolCall.function.name,
        target: summarizeToolTarget(toolCall.function.name, toolArgs),
        message: browserToolStartMessage(toolCall.function.name, toolArgs)
      });
      this.emitRunEvent(runId, chatId, {
        type: "tool.args",
        status: "running",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        action: toolCall.function.name,
        target: summarizeToolTarget(toolCall.function.name, toolArgs),
        data: toolArgs
      });
      const result = await this.executeBrowserTool(toolCall, state);
      state.lastResult = result;
      const compactResult = compactBrowserToolResult(result);
      this.emitRunEvent(runId, chatId, {
        type: "tool.result",
        status: browserToolStatus(result),
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        action: result.action,
        target: result.target ?? summarizeToolTarget(toolCall.function.name, toolArgs),
        message: browserToolResultMessage(result),
        error: result.error,
        data: compactResult
      });
      this.emitRunEvent(runId, chatId, {
        type: "tool.end",
        status: browserToolStatus(result),
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        action: result.action,
        target: result.target ?? summarizeToolTarget(toolCall.function.name, toolArgs),
        message: browserToolResultMessage(result),
        error: result.error
      });
      extraMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: this.stringifyToolResult(result)
      });

      if (shouldAutoFinishBrowserAction(request.message, result)) {
        await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
        return;
      }
      if (result.error === "user_rejected" || result.error === "user_dismissed") {
        await this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
        return;
      }
    }

    await this.executeBrowserToolLoop({
      runId,
      chatId,
      request,
      messages,
      settings,
      controller,
      extraMessages,
      desktopOnlyTools: pseudo.toolCalls.every((toolCall) => toolCall.function.name.startsWith("desktop_"))
    });
  }

  private parseToolArgs(toolCall: OpenAIToolCall) {
    try {
      const parsed = JSON.parse(toolCall.function.arguments || "{}") as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private currentBrowserTarget(state: BrowserToolLoopState): number | null {
    return state.webContentsId ?? state.pageContext?.browserTarget?.webContentsId ?? null;
  }

  private missingBrowserTargetResult(action: string): BrowserToolResult {
    return {
      ok: false,
      action,
      error: "missing_browser_target",
      message: "当前没有可操作的网页目标。请先调用 browser_surfaces 并用 browser_activate_surface 激活一个侧边栏网页。"
    };
  }

  private async executeBrowserTool(toolCall: OpenAIToolCall, state: BrowserToolLoopState): Promise<BrowserToolResult> {
    const toolName = toolCall.function.name;
    const args = this.parseToolArgs(toolCall);

    switch (toolName) {
      case "browser_surfaces": {
        const surfaces = this.browserUse?.listSurfaces ? await this.browserUse.listSurfaces() : [];
        const activeTarget = state.pageContext?.browserTarget;
        const activeSurface = activeTarget
          ? {
            id: activeTarget.surfaceId ?? "current",
            label: activeTarget.surfaceLabel ?? state.pageContext?.title ?? "当前网页",
            url: activeTarget.currentUrl ?? state.pageContext?.url ?? "",
            currentUrl: state.pageContext?.url,
            title: state.pageContext?.title,
            active: true,
            webContentsId: activeTarget.webContentsId
          } satisfies BrowserSurface
          : null;
        const merged = activeSurface
          ? [
            activeSurface,
            ...surfaces.filter((surface) => surface.id !== activeSurface.id && surface.url !== activeSurface.url)
          ]
          : surfaces;
        return {
          ok: true,
          action: "surfaces",
          message: merged.length > 0 ? `找到 ${merged.length} 个浏览器入口。` : "没有找到可用的侧边栏网页入口。",
          data: {
            surfaces: merged
          }
        };
      }
      case "browser_activate_surface": {
        const target = typeof args.target === "string" ? args.target : "";
        if (!this.browserUse?.activateSurface) {
          return {
            ok: false,
            action: "activate_surface",
            target,
            error: "unsupported_tool",
            message: "当前版本没有配置侧边栏激活能力。"
          };
        }
        const result = await this.browserUse.activateSurface(target);
        const surface = result.data && typeof result.data === "object"
          ? (result.data as { surface?: BrowserSurface }).surface
          : undefined;
        if (surface?.webContentsId) {
          state.webContentsId = surface.webContentsId;
          state.pageContext = {
            url: surface.currentUrl || surface.url,
            title: surface.title || surface.label,
            selectedText: "",
            metaDescription: "",
            headings: [],
            bodyText: "",
            browserTarget: {
              kind: "webview",
              webContentsId: surface.webContentsId,
              surfaceId: surface.id,
              surfaceLabel: surface.label,
              currentUrl: surface.currentUrl || surface.url
            }
          };
        }
        return result;
      }
      case "browser_agent_execute": {
        if (!this.browserUse?.executeAgentTask) {
          return {
            ok: false,
            action: "agent_execute",
            error: "unsupported_tool",
            message: "当前版本没有配置 PageAgent 执行能力。"
          };
        }
        const task = maybeString(args.task) || state.userText;
        const target = maybeString(args.target);
        let webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId && target && this.browserUse.activateSurface) {
          const activation = await this.browserUse.activateSurface(target);
          const surface = activation.data && typeof activation.data === "object"
            ? (activation.data as { surface?: BrowserSurface }).surface
            : undefined;
          if (!activation.ok || !surface?.webContentsId) {
            return activation;
          }
          webContentsId = surface.webContentsId;
          state.webContentsId = surface.webContentsId;
          state.pageContext = {
            url: surface.currentUrl || surface.url,
            title: surface.title || surface.label,
            selectedText: "",
            metaDescription: "",
            headings: [],
            bodyText: "",
            browserTarget: {
              kind: "webview",
              webContentsId: surface.webContentsId,
              surfaceId: surface.id,
              surfaceLabel: surface.label,
              currentUrl: surface.currentUrl || surface.url
            }
          };
        }
        if (!webContentsId) {
          return this.missingBrowserTargetResult("agent_execute");
        }

        let allowSensitive = false;
        if (isSensitiveBrowserAgentTask(task, target) && !this.hasFullAccess(state)) {
          const answer = await this.requestAwaiting(state.runId, state.chatId, {
            mode: "approval",
            title: "确认 PageAgent 敏感网页操作",
            description: "PageAgent 准备执行可能涉及提交、保存、登录、授权或删除的网页任务。",
            toolName,
            approval: {
              summary: task,
              risk: "会在当前网页中自动执行敏感操作，可能修改线上数据或账号状态。"
            }
          });
          if (answer.action !== "submit") {
            return this.userCancelledToolResult("agent_execute", answer);
          }
          allowSensitive = true;
        } else if (this.hasFullAccess(state) && isSensitiveBrowserAgentTask(task, target)) {
          allowSensitive = true;
        }

        const result = await this.browserUse.executeAgentTask(
          webContentsId,
          {
            task,
            target,
            allowSensitive,
            ...(pageAgentSearchRecoveryMaxSteps(task) ? { maxSteps: pageAgentSearchRecoveryMaxSteps(task) } : {})
          },
          {
            signal: state.abortSignal,
            onEvent: (event) => {
              this.emitRunEvent(state.runId, state.chatId, {
                type: "tool.result",
                status: "running",
                toolCallId: toolCall.id,
                toolName,
                action: `agent_execute.${event.type || "progress"}`,
                target: target || task,
                message: event.message || "PageAgent 进度已更新。",
                data: event
              });
            }
          }
        );
        return this.recoverPageAgentSearchResult(result, task, webContentsId);
      }
      case "browser_observe": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.observePage) {
          return this.missingBrowserTargetResult("observe");
        }
        const observation = await this.browserUse.observePage(webContentsId);
        return {
          ok: true,
          action: "observe",
          url: observation.url,
          title: observation.title,
          message: `已观察当前页面：${observation.title || observation.url}`,
          data: observation
        };
      }
      case "browser_click": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.click) {
          return this.missingBrowserTargetResult("click");
        }
        const input: { elementRef?: string; target?: string; allowSensitive?: boolean } = {};
        const elementRef = maybeString(args.elementRef);
        const target = maybeString(args.target);
        if (elementRef) {
          input.elementRef = elementRef;
        }
        if (target) {
          input.target = target;
        }
        if (args.allowSensitive === true) {
          input.allowSensitive = true;
        }
        if (!elementRef && target && isGenericSearchSubmitTarget(target) && this.browserUse.submit) {
          return this.browserUse.submit(webContentsId, input);
        }
        return this.browserUse.click(webContentsId, input);
      }
      case "browser_fill": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.fillFields) {
          return this.missingBrowserTargetResult("fill");
        }
        const fields = Array.isArray(args.fields)
          ? args.fields
            .map((field): BrowserFieldInput | null => {
              if (!field || typeof field !== "object") {
                return null;
              }
              const candidate = field as Record<string, unknown>;
              if (typeof candidate.value !== "string") {
                return null;
              }
              const normalized: BrowserFieldInput = {
                value: candidate.value
              };
              const elementRef = maybeString(candidate.elementRef);
              const fieldName = maybeString(candidate.field);
              const label = maybeString(candidate.label);
              if (elementRef) {
                normalized.elementRef = elementRef;
              }
              if (fieldName) {
                normalized.field = fieldName;
              }
              if (label) {
                normalized.label = label;
              }
              return normalized;
            })
            .filter((field): field is BrowserFieldInput => Boolean(field))
          : [];
        if (fields.length === 0) {
          return {
            ok: false,
            action: "fill",
            error: "invalid_arguments",
            message: "browser_fill 需要 fields 数组。"
          };
        }
        return this.browserUse.fillFields(webContentsId, fields);
      }
      case "browser_autofill": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.autofillForm) {
          return this.missingBrowserTargetResult("autofill");
        }
        const instruction = maybeString(args.instruction) || state.userText;
        const injectedSkill = maybeString(args.skill) || state.pageContext?.browserTarget?.browserSkill;
        const submit = typeof args.submit === "boolean"
          ? args.submit
          : !/(不用提交|不要提交|别提交|不提交|无需提交|先别提交)/u.test(state.userText)
          && /(提交|保存|确认提交)/u.test(state.userText);
        const input: { instruction?: string; skill?: string; submit?: boolean } = {
          instruction,
          submit
        };
        if (injectedSkill) {
          input.skill = injectedSkill;
        }
        return this.browserUse.autofillForm(webContentsId, input);
      }
      case "browser_select": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.selectOption) {
          return this.missingBrowserTargetResult("select");
        }
        if (typeof args.value !== "string") {
          return {
            ok: false,
            action: "select",
            error: "invalid_arguments",
            message: "browser_select 需要 value。"
          };
        }
        const input: BrowserFieldInput = { value: args.value };
        const elementRef = maybeString(args.elementRef);
        const fieldName = maybeString(args.field);
        const label = maybeString(args.label);
        if (elementRef) {
          input.elementRef = elementRef;
        }
        if (fieldName) {
          input.field = fieldName;
        }
        if (label) {
          input.label = label;
        }
        return this.browserUse.selectOption(webContentsId, input);
      }
      case "browser_check": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.setChecked) {
          return this.missingBrowserTargetResult("check");
        }
        const input: { field?: string; label?: string; elementRef?: string; checked: boolean } = {
          checked: Boolean(args.checked)
        };
        const elementRef = maybeString(args.elementRef);
        const fieldName = maybeString(args.field);
        const label = maybeString(args.label);
        if (elementRef) {
          input.elementRef = elementRef;
        }
        if (fieldName) {
          input.field = fieldName;
        }
        if (label) {
          input.label = label;
        }
        return this.browserUse.setChecked(webContentsId, input);
      }
      case "browser_submit": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.submit) {
          return this.missingBrowserTargetResult("submit");
        }
        const input: { elementRef?: string; target?: string } = {};
        const elementRef = maybeString(args.elementRef);
        const target = maybeString(args.target);
        if (elementRef) {
          input.elementRef = elementRef;
        }
        if (target) {
          input.target = target;
        }
        return this.browserUse.submit(webContentsId, input);
      }
      case "browser_read": {
        const webContentsId = this.currentBrowserTarget(state);
        if (!webContentsId || !this.browserUse?.readPageContext) {
          return this.missingBrowserTargetResult("read");
        }
        const pageContext = await this.browserUse.readPageContext(webContentsId);
        state.pageContext = pageContext ?? state.pageContext;
        state.webContentsId = pageContext?.browserTarget?.webContentsId ?? state.webContentsId;
        return {
          ok: true,
          action: "read",
          url: pageContext?.url,
          title: pageContext?.title,
          message: "已读取当前页面内容。",
          data: pageContext
        };
      }
      case "desktop_list_files": {
        return this.wrapDesktopTool("list_files", () => {
          const result = listDesktopFiles(this.app, {
            path: maybeString(args.path),
            recursive: Boolean(args.recursive),
            maxEntries: maybeNumber(args.maxEntries)
          }, state.chatId);
          return {
            ok: true,
            action: "desktop_list_files",
            message: `已读取 ${result.entries.length} 个桌面条目。`,
            data: result
          };
        });
      }
      case "desktop_read_file": {
        return this.wrapDesktopTool("read_file", () => {
          const result = readDesktopFile(this.app, { path: maybeString(args.path) }, state.chatId);
          return {
            ok: true,
            action: "desktop_read_file",
            target: result.path,
            message: `已读取文件：${result.path}`,
            data: {
              ...result,
              content: compactToolText(result.content, 12000)
            }
          };
        });
      }
      case "desktop_read_document": {
        try {
          const result = await readDesktopDocument(this.app, {
            path: maybeString(args.path),
            attachmentId: maybeString(args.attachmentId),
            pages: maybeString(args.pages),
            sheet: maybeString(args.sheet),
            maxChars: maybeNumber(args.maxChars)
          }, state.chatId, { signal: state.abortSignal });
          return {
            ok: true,
            action: "desktop_read_document",
            target: result.path,
            message: result.error
              ? `已读取文档元信息，但有解析说明：${result.error}`
              : `已读取文档：${result.path}`,
            data: {
              ...result,
              content: compactToolText(result.content, 12000)
            }
          };
        } catch (error) {
          return {
            ok: false,
            action: "desktop_read_document",
            error: "desktop_tool_failed",
            message: error instanceof Error ? error.message : String(error)
          };
        }
      }
      case "desktop_write_file": {
        const answer = await this.requestApproval(state, {
          mode: "approval",
          title: "确认写入桌面文件",
          description: "助手准备在允许的桌面目录中写入文件。",
          toolName,
          approval: {
            summary: maybeString(args.path) || maybeString(args.filename) || "写入文件",
            risk: "会在本机文件系统中创建或覆盖文件。",
            paths: [maybeString(args.path) || maybeString(args.filename) || ""].filter(Boolean)
          }
        });
        if (answer.action !== "submit") {
          return this.userCancelledToolResult("desktop_write_file", answer);
        }
        return this.wrapDesktopTool("write_file", () => {
          const result = writeDesktopFile(this.app, {
            path: maybeString(args.path),
            filename: maybeString(args.filename),
            content: typeof args.content === "string" ? args.content : "",
            overwrite: Boolean(args.overwrite)
          }, state.chatId);
          const published = this.publishArtifactAttachmentForRun(state, {
            path: result.path,
            name: path.basename(result.path),
            mimeType: "",
            description: maybeString(args.filename) || maybeString(args.path) || "桌面文件",
            type: "file"
          });
          return {
            ok: true,
            action: "desktop_write_file",
            target: result.path,
            message: `已写入文件：${result.path}`,
            data: {
              ...result,
              artifact: published.artifacts[0] ?? null,
              artifacts: published.artifacts
            }
          };
        });
      }
      case "desktop_create_docx":
      case "desktop_create_pdf":
      case "desktop_create_xlsx":
      case "desktop_create_pptx": {
        return this.executeOfficeCreateTool(state, toolName, args);
      }
      case "desktop_plan_organize": {
        return this.wrapDesktopTool("plan_organize", () => {
          const result = planDesktopOrganize(this.app, { path: maybeString(args.path) }, state.chatId);
          return {
            ok: true,
            action: "desktop_plan_organize",
            target: result.root,
            message: result.moves.length > 0
              ? `整理预览已生成：将移动 ${result.moves.length} 个文件。`
              : "整理预览已生成：没有需要移动的文件。",
            data: result
          };
        });
      }
      case "desktop_move_files": {
        const moves = this.parseMoveOperations(args.moves);
        const answer = await this.requestApproval(state, {
          mode: "approval",
          title: "确认移动桌面文件",
          description: "助手准备按整理预览移动桌面文件。",
          toolName,
          approval: {
            summary: `移动 ${moves.length} 个文件`,
            risk: "会改变本机桌面文件位置。",
            paths: moves.flatMap((move) => [move.from, move.to]).slice(0, 12)
          }
        });
        if (answer.action !== "submit") {
          return this.userCancelledToolResult("desktop_move_files", answer);
        }
        return this.wrapDesktopTool("move_files", () => {
          const result = moveDesktopFiles(this.app, { moves }, state.chatId);
          return {
            ok: true,
            action: "desktop_move_files",
            message: `已移动 ${result.moved.length} 个文件。`,
            data: result
          };
        });
      }
      case "bash": {
        const command = maybeString(args.command) || "";
        const answer = await this.requestApproval(state, {
          mode: "approval",
          title: "确认执行宿主机命令",
          description: maybeString(args.description) || "助手准备在本机执行命令。",
          toolName,
          approval: {
            summary: maybeString(args.description) || command,
            risk: "宿主机命令可能读取或修改本机文件。",
            command,
            cwd: maybeString(args.cwd) || "Desktop"
          }
        });
        if (answer.action !== "submit") {
          return this.userCancelledToolResult("bash", answer);
        }
        const result = await runHostCommand(this.app, {
          command,
          cwd: maybeString(args.cwd),
          timeoutMs: maybeNumber(args.timeoutMs) ?? maybeNumber(args.timeout_ms)
        }, state.chatId);
        return {
          ok: result.ok,
          action: "bash",
          target: result.command,
          error: result.ok ? undefined : "host_command_failed",
          message: result.ok ? "宿主机命令执行完成。" : `宿主机命令退出码 ${result.exitCode}。`,
          data: result
        };
      }
      case "bash_sandbox": {
        return this.executeSandboxBash(state, args);
      }
      case "host_app_launch": {
        const decision = routeAssistantToolRequest({
          toolName,
          args,
          platform: process.platform,
          permissionMode: state.permissionMode
        });
        if (decision.denied) {
          return {
            ok: false,
            action: "host_app_launch",
            error: "host_app_denied",
            message: decision.message
          };
        }
        const command = maybeString(decision.args.command);
        if (!command) {
          return {
            ok: false,
            action: "host_app_launch",
            error: "missing_command",
            message: "没有解析到可启动的白名单本机应用。"
          };
        }
        const appName = maybeString(decision.args.appName) || maybeString(decision.args.app_name_or_path) || maybeString(decision.args.app) || command;
        const answer = await this.requestApproval(state, {
          mode: "approval",
          title: "确认启动本机应用",
          description: "助手准备启动一个白名单本机应用。",
          toolName: "host_app_launch",
          approval: {
            summary: appName,
            risk: "会在本机启动应用。",
            command
          }
        });
        if (answer.action !== "submit") {
          return this.userCancelledToolResult("host_app_launch", answer);
        }
        try {
          const result = await runHostCommand(this.app, {
            command,
            cwd: maybeString(args.cwd),
            timeoutMs: maybeNumber(args.timeoutMs) ?? maybeNumber(args.timeout_ms)
          }, state.chatId);
          return {
            ok: result.ok,
            action: "host_app_launch",
            target: appName,
            error: result.ok ? undefined : "host_app_launch_failed",
            message: result.ok ? `已启动应用：${appName}` : `启动应用失败：${appName}`,
            data: result
          };
        } catch (error) {
          return {
            ok: false,
            action: "host_app_launch",
            target: appName,
            error: "host_app_launch_failed",
            message: error instanceof Error ? error.message : String(error)
          };
        }
      }
      case AGW_ASK_USER_QUESTION_TOOL_NAME:
      case LEGACY_ASK_USER_QUESTION_TOOL_NAME:
      case CLAUDE_ASK_USER_QUESTION_TOOL_NAME: {
        const questions = normalizeAgwAwaitingQuestions(args.questions);
        const answer = await this.requestAwaiting(state.runId, state.chatId, {
          mode: "question",
          title: maybeString(args.title) || "需要你补充信息",
          description: maybeString(args.description),
          toolName: AGW_ASK_USER_QUESTION_TOOL_NAME,
          viewportKey: "confirm_dialog",
          questions
        });
        if (answer.action !== "submit") {
          return this.userCancelledToolResult(AGW_ASK_USER_QUESTION_TOOL_NAME, answer);
        }
        const answerPayload = buildAgwQuestionAnswerPayload(questions, answer.params);
        return {
          ok: true,
          action: AGW_ASK_USER_QUESTION_TOOL_NAME,
          message: "用户已通过 AGW 弹窗提交信息。",
          data: answerPayload
        };
      }
      case "artifact_publish": {
        const inputs = this.normalizeArtifactPublishInputs(args, toolCall.id);
        const published = this.publishArtifactAttachmentsForRun(state, inputs);
        return {
          ok: published.ok,
          action: "artifact_publish",
          target: inputs[0]?.path,
          error: published.ok ? undefined : "artifact_publish_failed",
          message: published.message,
          data: {
            artifacts: published.artifacts,
            errors: published.errors
          }
        };
      }
      case "plan_add_tasks": {
        const tasks = Array.isArray(args.tasks)
          ? args.tasks.map((task) => String(task ?? "").trim()).filter(Boolean)
          : [];
        state.tasks.push(...tasks.map((task) => ({ task, status: "pending" as const })));
        return {
          ok: true,
          action: "plan_add_tasks",
          message: `已添加 ${tasks.length} 个任务。`,
          data: { tasks: state.tasks }
        };
      }
      case "plan_update_task": {
        const index = Math.max(0, Math.floor(maybeNumber(args.index) ?? 0));
        const status = args.status === "in_progress" || args.status === "completed" ? args.status : "pending";
        if (state.tasks[index]) {
          state.tasks[index] = {
            task: maybeString(args.task) || state.tasks[index].task,
            status
          };
        }
        return {
          ok: true,
          action: "plan_update_task",
          message: `已更新任务 ${index + 1}。`,
          data: { tasks: state.tasks }
        };
      }
      default:
        return {
          ok: false,
          action: toolName,
          error: "unknown_tool",
          message: `未知浏览器工具：${toolName}`
        };
    }
  }

  private wrapDesktopTool(action: string, run: () => BrowserToolResult): BrowserToolResult {
    try {
      return run();
    } catch (error) {
      return {
        ok: false,
        action,
        error: "desktop_tool_failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async executeOfficeCreateTool(
    state: BrowserToolLoopState,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<BrowserToolResult> {
    const target = maybeString(args.path) || maybeString(args.filename) || maybeString(args.title) || toolName;
    const answer = await this.requestApproval(state, {
      mode: "approval",
      title: "确认生成桌面文档",
      description: "助手准备在允许的桌面目录中生成 Office/PDF 文件。",
      toolName,
      approval: {
        summary: target,
        risk: "会在本机文件系统中创建或覆盖文档文件。",
        paths: [maybeString(args.path) || maybeString(args.filename) || ""].filter(Boolean)
      }
    });
    if (answer.action !== "submit") {
      return this.userCancelledToolResult(toolName, answer);
    }

    try {
      let result: OfficeToolResult;
      let mimeType = "";
      let artifactType = "document";
      if (toolName === "desktop_create_docx") {
        result = await createDocxFile(this.app, this.buildDocxInput(args), state.chatId);
        mimeType = OFFICE_MIME_TYPES.docx;
      } else if (toolName === "desktop_create_pdf") {
        result = await createPdfFile(this.app, this.buildPdfInput(args), state.chatId, {
          renderPdf: this.dependencies.renderPdf
        });
        mimeType = OFFICE_MIME_TYPES.pdf;
      } else if (toolName === "desktop_create_xlsx") {
        result = await createXlsxFile(this.app, this.buildXlsxInput(args), state.chatId);
        mimeType = OFFICE_MIME_TYPES.xlsx;
        artifactType = "spreadsheet";
      } else {
        result = await createPptxFile(this.app, this.buildPptxInput(args), state.chatId);
        mimeType = OFFICE_MIME_TYPES.pptx;
        artifactType = "presentation";
      }

      const published = this.publishArtifactAttachmentForRun(state, {
        path: result.path,
        name: path.basename(result.path),
        mimeType,
        description: maybeString(args.title) || path.basename(result.path),
        type: artifactType
      });
      return {
        ok: true,
        action: toolName,
        target: result.path,
        message: `已生成文件：${result.path}`,
        data: {
          ...result,
          artifact: published.artifacts[0] ?? null,
          artifacts: published.artifacts
        }
      };
    } catch (error) {
      return {
        ok: false,
        action: toolName,
        error: "desktop_tool_failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private publishArtifactAttachmentForRun(
    state: BrowserToolLoopState,
    input: RunArtifactInput
  ) {
    return this.publishArtifactAttachmentsForRun(state, [input]);
  }

  private publishArtifactAttachmentsForRun(
    state: BrowserToolLoopState,
    inputs: RunArtifactInput[]
  ) {
    const result = createAssistantArtifactAttachmentsFromFiles(this.app, state.chatId, inputs, {
      fallbackArtifactId: `artifact_${state.runId}_${Date.now().toString(36)}`
    });
    const activeRun = this.activeRuns.get(state.runId);
    if (activeRun && result.attachments.length > 0) {
      activeRun.attachments.push(...result.attachments);
    }
    this.emitRunEvent(state.runId, state.chatId, {
      type: "artifact.publish",
      status: result.ok ? "ok" : "error",
      action: "artifact_publish",
      target: inputs[0]?.path || "",
      message: result.message,
      artifactCount: result.artifacts.length,
      artifacts: result.artifacts,
      data: {
        ...result,
        attachments: result.attachments
      }
    });
    return result;
  }

  private normalizeArtifactPublishInputs(args: Record<string, unknown>, fallbackArtifactId: string): RunArtifactInput[] {
    const rawArtifacts = Array.isArray(args.artifacts) ? args.artifacts : [];
    const normalized: RunArtifactInput[] = [];
    for (const [index, item] of rawArtifacts.entries()) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const candidate = item as Record<string, unknown>;
      const artifactPath = maybeString(candidate.path);
      if (!artifactPath) {
        continue;
      }
      normalized.push({
        artifactId: maybeString(candidate.artifactId) || (rawArtifacts.length === 1 ? fallbackArtifactId : `${fallbackArtifactId}_${index}`),
        path: artifactPath,
        name: maybeString(candidate.name) || path.basename(artifactPath),
        mimeType: maybeString(candidate.mimeType),
        description: maybeString(candidate.description),
        type: maybeString(candidate.type) || "file"
      });
    }
    if (normalized.length > 0) {
      return normalized;
    }
    const artifactPath = maybeString(args.path) || "";
    const title = maybeString(args.title) || "产物";
    return [{
      artifactId: fallbackArtifactId,
      path: artifactPath,
      name: path.basename(artifactPath) || title,
      mimeType: maybeString(args.mimeType),
      description: maybeString(args.description) || title,
      type: "file"
    }];
  }

  private buildDocxInput(args: Record<string, unknown>): DocxCreateInput {
    return {
      path: maybeString(args.path),
      filename: maybeString(args.filename),
      title: maybeString(args.title),
      content: typeof args.content === "string" ? args.content : "",
      contentFormat: args.contentFormat === "markdown" ? "markdown" : "plain",
      overwrite: Boolean(args.overwrite)
    };
  }

  private buildPdfInput(args: Record<string, unknown>): PdfCreateInput {
    return {
      path: maybeString(args.path),
      filename: maybeString(args.filename),
      title: maybeString(args.title),
      content: typeof args.content === "string" ? args.content : "",
      contentFormat: args.contentFormat === "html" || args.contentFormat === "markdown" ? args.contentFormat : "plain",
      overwrite: Boolean(args.overwrite)
    };
  }

  private buildXlsxInput(args: Record<string, unknown>): XlsxCreateInput {
    return {
      path: maybeString(args.path),
      filename: maybeString(args.filename),
      title: maybeString(args.title),
      sheets: Array.isArray(args.sheets) ? args.sheets as XlsxCreateInput["sheets"] : undefined,
      content: typeof args.content === "string" ? args.content : "",
      overwrite: Boolean(args.overwrite)
    };
  }

  private buildPptxInput(args: Record<string, unknown>): PptxCreateInput {
    return {
      path: maybeString(args.path),
      filename: maybeString(args.filename),
      title: maybeString(args.title),
      slides: Array.isArray(args.slides) ? args.slides as PptxCreateInput["slides"] : undefined,
      content: typeof args.content === "string" ? args.content : "",
      overwrite: Boolean(args.overwrite)
    };
  }

  private userCancelledToolResult(action: string, answer: AwaitingAnswer): BrowserToolResult {
    return {
      ok: false,
      action,
      error: answer.action === "reject" ? "user_rejected" : "user_dismissed",
      message: answer.action === "reject"
        ? `用户已拒绝：${answer.reason || "未填写理由"}`
        : "用户已取消确认。"
    };
  }

  private parseMoveOperations(value: unknown): DesktopMoveOperation[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item): DesktopMoveOperation | null => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const candidate = item as Record<string, unknown>;
        const from = maybeString(candidate.from);
        const to = maybeString(candidate.to);
        return from && to ? { from, to } : null;
      })
      .filter((item): item is DesktopMoveOperation => Boolean(item));
  }

  private async executeSandboxBash(state: BrowserToolLoopState, args: Record<string, unknown>): Promise<BrowserToolResult> {
    const command = maybeString(args.command) || "";
    if (!command) {
      return {
        ok: false,
        action: "bash_sandbox",
        error: "missing_command",
        message: "bash_sandbox 需要 command。"
      };
    }
    const resolved = await this.dependencies.resolveContainerHub?.();
    if (!resolved || resolved.unavailableReason || !resolved.baseURL?.trim()) {
      return {
        ok: false,
        action: "bash_sandbox",
        error: "container_hub_unavailable",
        message: resolved?.unavailableReason || "Container Hub 未运行或未配置，沙箱命令暂不可用。"
      };
    }

    const environmentName = maybeString(args.environmentName)
      || resolved.defaultEnvironmentName
      || DEFAULT_SANDBOX_ENVIRONMENT;
    const client = new ContainerHubClient({
      baseURL: resolved.baseURL,
      authToken: resolved.authToken,
      timeoutMs: maybeNumber(args.timeoutMs) ?? maybeNumber(args.timeout_ms) ?? resolved.timeoutMs,
      defaultEnvironmentName: environmentName
    });
    const workspace = getAssistantWorkspacePath(this.app, state.chatId);
    const sessionId = buildContainerHubRunSessionId(state.runId);
    let created = false;
    try {
      await client.getRuntimeInfo();
      await client.createSession({
        sessionId,
        environmentName,
        cwd: "/workspace",
        mounts: [{
          source: workspace,
          destination: "/workspace",
          read_only: false
        }],
        labels: {
          runId: state.runId,
          chatId: state.chatId,
          agentKey: ZENMIND_ASSISTANT_AGENT_KEY
        }
      });
      created = true;
      const result = await client.executeSession({
        sessionId,
        command,
        cwd: maybeString(args.cwd) || "/workspace",
        timeoutMs: maybeNumber(args.timeoutMs) ?? maybeNumber(args.timeout_ms)
      });
      return {
        ok: result.ok,
        action: "bash_sandbox",
        target: command,
        error: result.ok ? undefined : "sandbox_command_failed",
        message: result.ok ? "沙箱命令执行完成。" : `沙箱命令退出码 ${result.exitCode}。`,
        data: result
      };
    } catch (error) {
      return {
        ok: false,
        action: "bash_sandbox",
        target: command,
        error: "sandbox_execute_failed",
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (created) {
        void client.stopSession(sessionId).catch(() => undefined);
      }
    }
  }

  private async executeBrowserClick({
    runId,
    chatId,
    request,
    target
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    target: string;
  }) {
    if (isPotentiallySensitiveClickTarget(target)) {
      this.emitRunEvent(runId, chatId, {
        type: "awaiting.confirm",
        status: "blocked",
        toolName: "browser_click",
        action: "click",
        target,
        message: `「${target}」需要用户确认后再操作。`
      });
      await this.completeWithAssistantText(
        runId,
        chatId,
        `“${target}”可能涉及提交、确认、删除、支付或保存等敏感操作。为避免误操作，当前版本不会自动点击这类按钮。`
      );
      return;
    }

    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolName: "browser_click",
      action: "click",
      target,
      message: `正在点击「${target}」。`
    });

    const webContentsId = request.pageContext?.browserTarget?.webContentsId;
    if (!this.browserUse || !webContentsId) {
      this.emitRunEvent(runId, chatId, {
        type: "tool.result",
        status: "error",
        toolName: "browser_click",
        action: "click",
        target,
        error: "missing_browser_target",
        message: "当前页面没有可操作的浏览器目标。"
      });
      await this.completeWithAssistantText(
        runId,
        chatId,
        "当前页面没有可操作的浏览器目标。请先切到一个网页标签页，再让我点击页面里的按钮或入口。"
      );
      return;
    }

    if (isGenericSearchSubmitTarget(target) && this.browserUse.submit) {
      const result = await this.browserUse.submit(webContentsId, { target });
      this.emitRunEvent(runId, chatId, {
        type: "tool.result",
        status: result.ok ? "ok" : "error",
        toolName: "browser_submit",
        action: "submit",
        target: result.target || target,
        message: result.message || (result.ok ? `已提交「${target}」。` : `当前网页没有找到可提交的“${target}”。`),
        data: result
      });
      await this.completeWithAssistantText(
        runId,
        chatId,
        result.message || (result.ok ? `已提交“${target}”。` : `当前网页没有找到可提交的“${target}”。`)
      );
      return;
    }

    const result = await this.browserUse.clickElementByText(webContentsId, target);
    if (result.ok) {
      this.emitRunEvent(runId, chatId, {
        type: "tool.result",
        status: "ok",
        toolName: "browser_click",
        action: "click",
        target: result.matchedText || target,
        message: result.matchedText && result.matchedText !== target
          ? `已点击「${result.matchedText}」。`
          : `已点击「${target}」。`,
        data: result
      });
      await this.completeWithAssistantText(
        runId,
        chatId,
        result.matchedText && result.matchedText !== target
          ? `已点击“${result.matchedText}”。`
          : `已点击“${target}”。`
      );
      return;
    }

    const candidates = result.candidates?.length
      ? `\n\n当前可见的候选项包括：${result.candidates.join("、")}`
      : "";
    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: "error",
      toolName: "browser_click",
      action: "click",
      target,
      message: result.message || `当前网页没有找到可点击的“${target}”。`,
      data: result
    });
    await this.completeWithAssistantText(
      runId,
      chatId,
      `${result.message || `当前网页没有找到可点击的“${target}”。`}${candidates}`
    );
  }

  private async executeBrowserInput({
    runId,
    chatId,
    request,
    value,
    submit,
    summarizeAfterSubmit,
    settings,
    controller
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    value: string;
    submit: boolean;
    summarizeAfterSubmit: boolean;
    settings: ReturnType<typeof readAssistantSettings>;
    controller: AbortController;
  }) {
    const webContentsId = request.pageContext?.browserTarget?.webContentsId;
    if (!this.browserUse || !webContentsId) {
      this.emitRunEvent(runId, chatId, {
        type: "tool.result",
        status: "error",
        toolName: submit ? "browser_submit" : "browser_fill",
        action: submit ? "input_submit" : "input",
        target: value,
        error: "missing_browser_target",
        message: "当前页面没有可操作的浏览器目标。"
      });
      await this.completeWithAssistantText(
        runId,
        chatId,
        "当前页面没有可操作的浏览器目标。请先切到一个网页标签页，再让我输入或搜索。"
      );
      return;
    }

    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolName: submit ? "browser_submit" : "browser_fill",
      action: submit ? "input_submit" : "input",
      target: value,
      message: submit ? `正在输入「${value}」并提交。` : `正在输入「${value}」。`
    });
    const inputResult = submit
      ? await this.browserUse.fillBestInputAndSubmit(webContentsId, value)
      : await this.browserUse.fillBestInput(webContentsId, value);
    if (controller.signal.aborted) {
      throw new Error("aborted");
    }
    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: inputResult.ok ? "ok" : "error",
      toolName: submit ? "browser_submit" : "browser_fill",
      action: submit ? "input_submit" : "input",
      target: inputResult.ok ? inputResult.inputLabel : value,
      message: inputResult.ok
        ? (inputResult.submitted ? `已输入「${value}」并提交。` : `已输入「${value}」。`)
        : (inputResult.message || "当前页面没有找到可输入的文本框。"),
      data: inputResult
    });
    if (!inputResult.ok) {
      await this.completeWithAssistantText(runId, chatId, inputResult.message || "当前页面没有找到可输入的文本框。");
      return;
    }

    if (!summarizeAfterSubmit) {
      await this.completeWithAssistantText(
        runId,
        chatId,
        inputResult.submitted
          ? `已在输入框输入“${value}”并提交。`
          : `已在输入框输入“${value}”。`
      );
      return;
    }

    this.emitAssistantDelta(runId, chatId, `已在输入框输入“${value}”并提交搜索，正在读取结果页并总结...\n\n`);
    this.emitRunEvent(runId, chatId, {
      type: "tool.start",
      status: "running",
      toolName: "browser_read",
      action: "read",
      message: "正在读取页面结果。"
    });
    const pageContext = await this.browserUse.readPageContext(webContentsId);
    if (controller.signal.aborted) {
      throw new Error("aborted");
    }
    this.emitRunEvent(runId, chatId, {
      type: "tool.result",
      status: pageContext?.bodyText.trim() ? "ok" : "error",
      toolName: "browser_read",
      action: "read",
      target: pageContext?.title || pageContext?.url,
      message: pageContext?.bodyText.trim() ? "已读取当前页面内容。" : "没有读取到可总结的页面文本。",
      data: pageContext
    });
    if (!pageContext?.bodyText.trim()) {
      await this.completeWithAssistantText(
        runId,
        chatId,
        "搜索后没有读取到可总结的页面文本。请确认页面已经加载完成，或再让我总结当前页面。"
      );
      return;
    }

    const summaryMessages = buildAssistantMessages({
      history: [],
      message: `请总结当前页面中和“${value}”有关的重点内容。`,
      action: "summarize_page",
      pageContext
    });
    await streamOpenAIChatCompletion({
      settings,
      messages: summaryMessages,
      signal: controller.signal,
      onDelta: (delta) => {
        this.emitAssistantDelta(runId, chatId, delta);
      }
    });
    await this.finishAssistantRun(runId, chatId);
  }
}
