import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AssistantAwaitingPayload,
  AssistantAwaitingQuestion,
  AssistantEvent,
  AssistantPageContext,
  AssistantRunEvent,
  AssistantRunEventStatus,
  AssistantSubmitAwaitingRequest,
  AssistantSubmitAwaitingResult,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  AssistantStopRunResult,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceCorrectionResult,
  AssistantVoiceTranscriptionRequest,
  AssistantVoiceTranscriptionResult
} from "../../shared/contracts";
import {
  appendAssistantEvent,
  appendAssistantMessage,
  createAssistantMessage,
  getAssistantChat
} from "./chat-store";
import { hydrateAssistantAttachmentsForChat } from "./attachment-store";
import { loadAgentPlatformMinimaxSettings, loadAgentPlatformVoiceAsrSettings } from "./agent-platform-config";
import { readAssistantSettings } from "./settings-store";
import { convertAudioBufferToWavBuffer } from "./audio-conversion";
import { buildAssistantMessages, type OpenAIChatMessage, type OpenAIToolCall } from "./prompt-builder";
import {
  completeOpenAIChatCompletion,
  streamOpenAIChatCompletion,
  transcribeOpenAIChatAudio,
  transcribeOpenAIAudio,
  type OpenAIToolDefinition
} from "./model-provider";
import {
  extractBrowserIntent,
  isPotentiallySensitiveClickTarget,
  normalizeBrowserText
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
  runHostCommand,
  writeDesktopFile,
  type DesktopMoveOperation
} from "./desktop-tools";
import {
  buildContainerHubRunSessionId,
  ContainerHubClient,
  getAssistantWorkspacePath,
  type ContainerHubConfig
} from "./container-hub";

type AssistantBrowserUseTool = {
  listSurfaces?: () => Promise<BrowserSurface[]>;
  activateSurface?: (target: string) => Promise<BrowserToolResult>;
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
};

const MAX_BROWSER_TOOL_STEPS = 16;
const DEFAULT_AWAITING_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SANDBOX_ENVIRONMENT = "shell";
const VOICE_CORRECTION_TIMEOUT_MS = 20000;
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 60000;
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

const BROWSER_ACTION_PATTERN =
  /(浏览器|左边网页|左侧网页|当前网页|网页里|侧边栏|页面流程|打开|进入|点击|点开|填写|填表|填好|补全|完善|随便填|输入|搜索|搜一下|查一下|查询|查找|检索|筛选|过滤|翻页|上一页|下一页|勾选|取消勾选|选择|下拉|提交|表单|读取.*(?:网页|页面|结果)|总结.*结果)/u;
const WEB_QUERY_PATTERN =
  /(搜索|搜一下|查一下|查询|查找|检索|筛选|过滤|翻页|上一页|下一页|读取.*(?:网页|页面|结果)|总结.*结果)/u;
const PAGE_CONTEXT_ONLY_PATTERN =
  /(?:(?:当前|这个|这页|左边|左侧)?(?:页面|网页)|这条内容|这篇文章|选中文本|当前内容).*(?:讲|说|是什么|有哪些|总结|概括|分析|提炼|说明|内容|重点|待办|风险)|(?:总结|概括|分析|提炼|说明).*(?:(?:当前|这个|这页|左边|左侧)?(?:页面|网页)|这条内容|这篇文章|选中文本|当前内容)/u;
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
  /(桌面|文件|目录|列出|读取|写入|保存|创建|生成|整理|移动|归档|html|贪吃蛇|命令|终端|bash|shell|沙箱|sandbox|container)/iu;

const DESKTOP_AGENT_SYSTEM_PROMPT = [
  "你是 Desktop 单智能体 desktop-xiaozhai，可以在 ZenMind Desktop 内通过工具完成受限桌面任务。",
  "如果用户要列出、读取、整理、生成或保存桌面文件，必须调用 desktop_* 工具，不要假装已经看到了文件。",
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
          description: { type: "string" }
        },
        required: ["title", "path"],
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

const AGENT_TOOL_DEFINITIONS = [...BROWSER_TOOL_DEFINITIONS, ...DESKTOP_TOOL_DEFINITIONS];

type BrowserToolLoopState = {
  pageContext: AssistantPageContext | null;
  webContentsId: number | null;
  userText: string;
  lastResult: BrowserToolResult | null;
  runId: string;
  chatId: string;
  abortSignal: AbortSignal;
  tasks: Array<{ task: string; status: "pending" | "in_progress" | "completed" }>;
};

type ContainerHubResolverResult = ContainerHubConfig & {
  unavailableReason?: string;
};

type AssistantRuntimeDependencies = {
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

function isAskUserQuestionToolName(toolName: string) {
  return (
    toolName === AGW_ASK_USER_QUESTION_TOOL_NAME ||
    toolName === LEGACY_ASK_USER_QUESTION_TOOL_NAME ||
    toolName === CLAUDE_ASK_USER_QUESTION_TOOL_NAME
  );
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

type ActiveRun = {
  controller: AbortController;
  chatId: string;
  text: string;
  seq: number;
};

export class AssistantRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingAwaitings = new Map<string, PendingAwaiting>();

  constructor(
    private readonly app: App,
    private readonly emitEvent: (event: AssistantEvent) => void,
    private readonly browserUse?: AssistantBrowserUseTool,
    private readonly dependencies: AssistantRuntimeDependencies = {}
  ) {}

  async correctVoiceText(request: AssistantVoiceCorrectionRequest): Promise<AssistantVoiceCorrectionResult> {
    const text = request.text.trim();
    if (!text) {
      return {
        ok: false,
        text: "",
        message: "没有可纠正的语音文本。"
      };
    }

    const settings = loadAgentPlatformMinimaxSettings(this.app) ?? readAssistantSettings(this.app);
    if (!settings.apiKey.trim() || !settings.baseURL.trim() || !settings.model.trim()) {
      return {
        ok: false,
        text,
        message: "请先在设置中配置助手模型。"
      };
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
      return {
        ok: true,
        text: corrected,
        message: corrected === text ? "语音文本已确认。" : "语音文本已纠正。"
      };
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
      if (voiceSettings) {
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
          message: "语音识别完成。"
        };
      }

      const settings = loadAgentPlatformMinimaxSettings(this.app) ?? readAssistantSettings(this.app);
      if (settings.apiKey.trim() && settings.baseURL.trim()) {
        const text = await transcribeOpenAIAudio({
          settings,
          audio,
          mimeType: request.mimeType,
          signal: controller.signal
        });
        return {
          ok: true,
          text,
          message: "语音识别完成。"
        };
      }
    } catch (error) {
      cloudSpeechFailure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    return {
      ok: false,
      text: "",
      message: cloudSpeechFailure
        ? `语音识别失败：${cloudSpeechFailure}`
        : "请先配置支持语音识别的 agent-platform provider。当前优先使用百炼 qwen3-asr-flash。"
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
    if (!settings.apiKey.trim() || !settings.baseURL.trim() || !settings.model.trim()) {
      return {
        ok: false,
        runId: "",
        chatId: request.chatId ?? "",
        message: "请先在设置中配置助手模型。"
      };
    }

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

    this.activeRuns.set(runId, {
      controller,
      chatId,
      text: "",
      seq: 0
    });

    this.emitRunEvent(runId, chatId, {
      type: "request.query",
      status: "running",
      message: "已收到请求。",
      data: {
        agentKey: "desktop-xiaozhai",
        action: request.action ?? "chat"
      }
    });
    this.emitRunEvent(runId, chatId, {
      type: "chat.start",
      status: "running",
      message: "已进入桌面单智能体会话。",
      data: {
        agentKey: "desktop-xiaozhai"
      }
    });
    this.emitRunEvent(runId, chatId, {
      type: "run.start",
      status: "running",
      message: request.action && request.action !== "chat" ? "已开始处理页面任务。" : "已开始生成。",
      data: {
        action: request.action ?? "chat",
        hasPageContext: Boolean(request.pageContext),
        attachmentCount: request.attachments?.length ?? 0
      }
    });

    const messages = buildAssistantMessages({
      history,
      message,
      action: request.action ?? "chat",
      pageContext: request.pageContext ?? null,
      attachments: hydratedAttachments
    });

    void this.executeRun({
      runId,
      chatId,
      request,
      userText: message,
      messages,
      settings,
      controller
    });

    return {
      ok: true,
      runId,
      chatId,
      message: "已开始生成。"
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
      appendAssistantMessage(this.app, chatId, createAssistantMessage("assistant", activeRun.text, runId));
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

  private async executeRun({
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
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return;
    }

    try {
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

      if (this.shouldUseAgentTools(userText, request)) {
        await this.executeBrowserToolLoop({
          runId,
          chatId,
          request,
          messages,
          settings,
          controller
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

      await streamOpenAIChatCompletion({
        settings,
        messages,
        signal: controller.signal,
        onDelta: (delta) => {
          const currentRun = this.activeRuns.get(runId);
          if (!currentRun) {
            return;
          }
          currentRun.text += delta;
          this.emitRunEvent(runId, chatId, {
            type: "content.delta",
            delta,
            status: "running"
          });
        }
      });

      this.finishAssistantRun(runId, chatId);
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
      this.activeRuns.delete(runId);
    }
  }

  private completeWithAssistantText(runId: string, chatId: string, text: string) {
    if (!this.activeRuns.has(runId)) {
      return;
    }
    this.emitAssistantDelta(runId, chatId, text);
    appendAssistantMessage(this.app, chatId, createAssistantMessage("assistant", text, runId));
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
    this.activeRuns.delete(runId);
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

  private finishAssistantRun(runId: string, chatId: string) {
    const finalRun = this.activeRuns.get(runId);
    if (finalRun?.text.trim()) {
      appendAssistantMessage(this.app, chatId, createAssistantMessage("assistant", finalRun.text, runId));
    }
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
    this.activeRuns.delete(runId);
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
    const hasBrowserTooling = Boolean(this.browserUse?.observePage || this.browserUse?.listSurfaces || this.browserUse?.executeAgentTask);
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
      this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
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
    this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
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

    let result: BrowserToolResult;
    if (!this.browserUse?.executeAgentTask || !webContentsId) {
      result = this.missingBrowserTargetResult("agent_execute");
    } else if (isSensitiveBrowserAgentTask(task)) {
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
      result = await runAgent(false) ?? this.missingBrowserTargetResult("agent_execute");
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
    this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
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
    extraMessages = []
  }: {
    runId: string;
    chatId: string;
    request: AssistantStartRunRequest;
    messages: ReturnType<typeof buildAssistantMessages>;
    settings: ReturnType<typeof readAssistantSettings>;
    controller: AbortController;
    extraMessages?: OpenAIChatMessage[];
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
        tools: AGENT_TOOL_DEFINITIONS,
        signal: controller.signal
      });

      if (completion.tool_calls.length === 0) {
        this.completeWithAssistantText(
          runId,
          chatId,
          completion.content.trim() || "已完成浏览器操作。"
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
          this.completeWithAssistantText(
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
          this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
          return;
        }
        if (result.error === "user_rejected" || result.error === "user_dismissed") {
          this.completeWithAssistantText(runId, chatId, browserToolCompletionMessage(result));
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
    this.completeWithAssistantText(
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
        if (isSensitiveBrowserAgentTask(task, target)) {
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
        const input: { elementRef?: string; target?: string } = {};
        const elementRef = maybeString(args.elementRef);
        const target = maybeString(args.target);
        if (elementRef) {
          input.elementRef = elementRef;
        }
        if (target) {
          input.target = target;
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
      case "desktop_write_file": {
        const answer = await this.requestAwaiting(state.runId, state.chatId, {
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
          this.emitRunEvent(state.runId, state.chatId, {
            type: "artifact.publish",
            status: "ok",
            action: "artifact_publish",
            target: result.path,
            message: `已生成文件：${result.path}`,
            data: {
              title: maybeString(args.filename) || maybeString(args.path) || "桌面文件",
              path: result.path
            }
          });
          return {
            ok: true,
            action: "desktop_write_file",
            target: result.path,
            message: `已写入文件：${result.path}`,
            data: result
          };
        });
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
        const answer = await this.requestAwaiting(state.runId, state.chatId, {
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
        const answer = await this.requestAwaiting(state.runId, state.chatId, {
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
        const data = {
          title: maybeString(args.title) || "产物",
          path: maybeString(args.path) || "",
          mimeType: maybeString(args.mimeType) || "",
          description: maybeString(args.description) || ""
        };
        this.emitRunEvent(state.runId, state.chatId, {
          type: "artifact.publish",
          status: "ok",
          action: "artifact_publish",
          target: data.path,
          message: `已发布产物：${data.title}`,
          data
        });
        return {
          ok: true,
          action: "artifact_publish",
          target: data.path,
          message: `已发布产物：${data.title}`,
          data
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
          agentKey: "desktop-xiaozhai"
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
      this.completeWithAssistantText(
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
      this.completeWithAssistantText(
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
      this.completeWithAssistantText(
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
      this.completeWithAssistantText(
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
    this.completeWithAssistantText(
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
      this.completeWithAssistantText(
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
      this.completeWithAssistantText(runId, chatId, inputResult.message || "当前页面没有找到可输入的文本框。");
      return;
    }

    if (!summarizeAfterSubmit) {
      this.completeWithAssistantText(
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
      this.completeWithAssistantText(
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
    this.finishAssistantRun(runId, chatId);
  }
}
