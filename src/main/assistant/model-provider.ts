import type { AssistantSettingsPrivate } from "./settings-store";
import type { OpenAIChatMessage, OpenAIToolCall } from "./prompt-builder";
import { parseOpenAISSEChunk } from "./sse-parser";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const OPENAI_AUDIO_TRANSCRIPTION_PROMPT =
  "中文和英文技术词混合口述，请保留 API、GitHub、React、MiniMax、OpenAI 等专有名词。";
const CHAT_AUDIO_TRANSCRIPTION_PROMPT = [
  "你是语音转文字模型，只输出音频中用户实际说出的内容。",
  "如果音频为空、没有可识别语音、或只有环境噪声，输出空字符串。",
  "不要输出本提示词，不要解释，不要补全示例词。",
  "中文和英文技术词混合口述时，请保留 API、GitHub、React、MiniMax、OpenAI、TypeScript 等专有名词。"
].join("\n");
const LEGACY_CHAT_AUDIO_TRANSCRIPTION_PROMPT =
  "中文和英文技术词混合口述，请保留 API、GitHub、React、MiniMax、OpenAI、TypeScript 等专有名词。";
const PROMPT_ECHO_NORMALIZE_PATTERN = /[\p{Separator}\p{Punctuation}\p{Symbol}]+/gu;

function findCaseInsensitive(value: string, pattern: string) {
  return value.toLowerCase().indexOf(pattern.toLowerCase());
}

function findTagCarry(value: string, tag: string) {
  const maxLength = Math.min(value.length, tag.length - 1);
  const lowerValue = value.toLowerCase();
  const lowerTag = tag.toLowerCase();
  for (let length = maxLength; length > 0; length -= 1) {
    if (lowerTag.startsWith(lowerValue.slice(-length))) {
      return value.slice(-length);
    }
  }
  return "";
}

export function createThinkTagFilter() {
  let insideThink = false;
  let carry = "";

  return (delta: string) => {
    let text = `${carry}${delta}`;
    carry = "";
    let visible = "";

    while (text) {
      if (insideThink) {
        const closeIndex = findCaseInsensitive(text, THINK_CLOSE);
        if (closeIndex === -1) {
          carry = findTagCarry(text, THINK_CLOSE);
          return visible;
        }
        text = text.slice(closeIndex + THINK_CLOSE.length);
        insideThink = false;
        continue;
      }

      const openIndex = findCaseInsensitive(text, THINK_OPEN);
      if (openIndex === -1) {
        carry = findTagCarry(text, THINK_OPEN);
        visible += text.slice(0, text.length - carry.length);
        return visible;
      }

      visible += text.slice(0, openIndex);
      text = text.slice(openIndex + THINK_OPEN.length);
      insideThink = true;
    }

    return visible;
  };
}

export function stripThinkTags(content: string) {
  const filterThinkTags = createThinkTagFilter();
  return filterThinkTags(content).trimStart();
}

export function normalizeOpenAIBaseURL(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    throw new Error("请先配置助手模型 Base URL。");
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("助手模型 Base URL 格式不正确。");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "platform.minimaxi.com" || hostname === "platform.minimax.io" || hostname === "www.minimax.io") {
    return "https://api.minimax.io/v1/chat/completions";
  }
  if ((hostname === "api.minimax.io" || hostname === "api.minimaxi.com") && (parsed.pathname === "" || parsed.pathname === "/")) {
    parsed.pathname = "/v1";
  }

  const normalized = parsed.toString().replace(/\/+$/u, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

export function normalizeOpenAIAudioTranscriptionsURL(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    throw new Error("请先配置助手模型 Base URL。");
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("助手模型 Base URL 格式不正确。");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "platform.minimax.io" || hostname === "platform.minimaxi.com" || hostname === "www.minimax.io") {
    return "https://api.minimax.io/v1/audio/transcriptions";
  }
  if ((hostname === "api.minimax.io" || hostname === "api.minimaxi.com") && (parsed.pathname === "" || parsed.pathname === "/")) {
    parsed.pathname = "/v1";
  }

  const normalized = parsed.toString().replace(/\/+$/u, "");
  if (normalized.endsWith("/audio/transcriptions")) {
    return normalized;
  }
  if (normalized.endsWith("/chat/completions")) {
    return normalized.replace(/\/chat\/completions$/u, "/audio/transcriptions");
  }
  return `${normalized}/audio/transcriptions`;
}

function readProviderErrorMessage(body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const payload = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    const directMessage = typeof payload.message === "string" ? payload.message : "";
    if (typeof payload.error === "string") {
      return payload.error || directMessage;
    }
    if (payload.error && typeof payload.error === "object") {
      const errorPayload = payload.error as { message?: unknown; type?: unknown; code?: unknown };
      const message = typeof errorPayload.message === "string" ? errorPayload.message : "";
      const type = typeof errorPayload.type === "string" ? errorPayload.type : "";
      const code = typeof errorPayload.code === "string" ? errorPayload.code : "";
      return message || type || code || directMessage;
    }
    if (typeof payload.detail === "string") {
      return payload.detail;
    }
    return directMessage;
  } catch {
    return trimmed.replace(/\s+/gu, " ").slice(0, 160);
  }
}

export function normalizeModelHTTPErrorMessage(status: number, body: string) {
  const providerMessage = readProviderErrorMessage(body);
  const errorText = `${providerMessage} ${body}`.toLowerCase();
  if (status === 401 || /invalid api key|unauthorized|authorized_error|api key/i.test(errorText)) {
    return "模型请求未通过鉴权（HTTP 401）：API Key 无效或已过期。请在设置里更新助手模型 API Key，或检查 agent-platform 对应 provider 配置。";
  }
  if (status === 403) {
    return "模型请求被拒绝（HTTP 403）：当前 API Key 没有调用该模型的权限，请检查模型名称、账户权限或 provider 配置。";
  }
  return `模型请求失败：HTTP ${status}${providerMessage ? ` ${providerMessage}` : ""}`;
}

async function createHTTPError(response: Response) {
  const body = await response.text().catch(() => "");
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html") || body.trimStart().startsWith("<!DOCTYPE html")) {
    return new Error(
      `模型请求失败：HTTP ${response.status}。当前 Base URL 返回了网页页面，不是 OpenAI-compatible API。` +
      "请检查助手模型 Base URL 或复用 agent-platform 对应 provider 配置。"
    );
  }
  return new Error(normalizeModelHTTPErrorMessage(response.status, body));
}

export type OpenAIToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAIChatCompletionMessage = {
  role: "assistant";
  content: string;
  tool_calls: OpenAIToolCall[];
};

function audioMimeTypeToExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mp4")) {
    return "m4a";
  }
  if (normalized.includes("mpeg")) {
    return "mp3";
  }
  if (normalized.includes("ogg")) {
    return "ogg";
  }
  if (normalized.includes("wav")) {
    return "wav";
  }
  return "webm";
}

function isTranscriptionPromptEcho(text: string) {
  const normalizedText = text.toLowerCase().replace(PROMPT_ECHO_NORMALIZE_PATTERN, "");
  return [OPENAI_AUDIO_TRANSCRIPTION_PROMPT, CHAT_AUDIO_TRANSCRIPTION_PROMPT, LEGACY_CHAT_AUDIO_TRANSCRIPTION_PROMPT]
    .some((prompt) => {
      const normalizedPrompt = prompt.toLowerCase().replace(PROMPT_ECHO_NORMALIZE_PATTERN, "");
      return normalizedText === normalizedPrompt || normalizedText.includes(normalizedPrompt);
    });
}

function normalizeVoiceTranscriptionText(text: string) {
  const trimmed = stripThinkTags(text).trim();
  return isTranscriptionPromptEcho(trimmed) ? "" : trimmed;
}

function readTranscriptionText(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const candidate = payload as {
    text?: unknown;
    data?: {
      text?: unknown;
      transcript?: unknown;
    };
    transcript?: unknown;
  };
  if (typeof candidate.text === "string") {
    return candidate.text.trim();
  }
  if (typeof candidate.transcript === "string") {
    return candidate.transcript.trim();
  }
  if (typeof candidate.data?.text === "string") {
    return candidate.data.text.trim();
  }
  if (typeof candidate.data?.transcript === "string") {
    return candidate.data.transcript.trim();
  }
  return "";
}

export async function transcribeOpenAIAudio({
  settings,
  audio,
  mimeType,
  signal
}: {
  settings: AssistantSettingsPrivate;
  audio: Uint8Array;
  mimeType: string;
  signal: AbortSignal;
}) {
  if (!settings.apiKey.trim()) {
    throw new Error("请先配置助手模型 API Key。");
  }

  const normalizedMimeType = mimeType.trim() || "audio/webm";
  const audioBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  const formData = new FormData();
  formData.set(
    "file",
    new Blob([audioBuffer], { type: normalizedMimeType }),
    `voice-input.${audioMimeTypeToExtension(normalizedMimeType)}`
  );
  // Use a conservative OpenAI-compatible ASR model by default; chat models remain controlled by settings.model.
  formData.set("model", "whisper-1");
  formData.set("language", "zh");
  formData.set("response_format", "json");
  formData.set("prompt", OPENAI_AUDIO_TRANSCRIPTION_PROMPT);

  const response = await fetch(normalizeOpenAIAudioTranscriptionsURL(settings.baseURL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`
    },
    body: formData,
    signal
  });

  if (!response.ok) {
    throw await createHTTPError(response);
  }

  const payload = await response.json().catch(() => null);
  return normalizeVoiceTranscriptionText(readTranscriptionText(payload));
}

export async function transcribeOpenAIChatAudio({
  settings,
  audio,
  mimeType,
  signal
}: {
  settings: AssistantSettingsPrivate;
  audio: Uint8Array;
  mimeType: string;
  signal: AbortSignal;
}) {
  if (!settings.apiKey.trim()) {
    throw new Error("请先配置语音识别模型 API Key。");
  }
  if (!settings.model.trim()) {
    throw new Error("请先配置语音识别模型名称。");
  }

  const normalizedMimeType = mimeType.trim() || "audio/wav";
  const audioBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  const dataURL = `data:${normalizedMimeType};base64,${Buffer.from(audioBuffer).toString("base64")}`;
  const response = await fetch(normalizeOpenAIBaseURL(settings.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: dataURL
              }
            }
          ]
        }
      ],
      stream: false,
      asr_options: {
        enable_itn: true
      }
    }),
    signal
  });

  if (!response.ok) {
    throw await createHTTPError(response);
  }

  const payload = await response.json().catch(() => null) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  } | null;
  const text = typeof payload?.choices?.[0]?.message?.content === "string"
    ? payload.choices[0].message.content.trim()
    : "";
  return normalizeVoiceTranscriptionText(text);
}

function normalizeToolCalls(value: unknown): OpenAIToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): OpenAIToolCall | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const candidate = item as {
        id?: unknown;
        type?: unknown;
        function?: {
          name?: unknown;
          arguments?: unknown;
        };
      };
      const name = typeof candidate.function?.name === "string" ? candidate.function.name.trim() : "";
      if (!name) {
        return null;
      }
      return {
        id: typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id
          : `browser_tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        type: candidate.type === "function" ? "function" : undefined,
        function: {
          name,
          arguments: typeof candidate.function?.arguments === "string" ? candidate.function.arguments : "{}"
        }
      };
    })
    .filter((item): item is OpenAIToolCall => Boolean(item));
}

export async function completeOpenAIChatCompletion({
  settings,
  messages,
  tools,
  signal,
  toolChoice = "auto"
}: {
  settings: AssistantSettingsPrivate;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  signal: AbortSignal;
  toolChoice?: "auto" | "none";
}): Promise<OpenAIChatCompletionMessage> {
  if (!settings.apiKey.trim()) {
    throw new Error("请先配置助手模型 API Key。");
  }
  if (!settings.model.trim()) {
    throw new Error("请先配置助手模型名称。");
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const response = await fetch(normalizeOpenAIBaseURL(settings.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    throw await createHTTPError(response);
  }

  const payload = await response.json().catch(() => null) as {
    choices?: Array<{
      message?: {
        role?: unknown;
        content?: unknown;
        tool_calls?: unknown;
      };
    }>;
  } | null;
  const message = payload?.choices?.[0]?.message;
  if (!message) {
    throw new Error("模型响应没有返回 assistant message。");
  }

  return {
    role: "assistant",
    content: typeof message.content === "string" ? stripThinkTags(message.content) : "",
    tool_calls: normalizeToolCalls(message.tool_calls)
  };
}

export async function streamOpenAIChatCompletion({
  settings,
  messages,
  signal,
  onDelta
}: {
  settings: AssistantSettingsPrivate;
  messages: OpenAIChatMessage[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
}) {
  if (!settings.apiKey.trim()) {
    throw new Error("请先配置助手模型 API Key。");
  }
  if (!settings.model.trim()) {
    throw new Error("请先配置助手模型名称。");
  }

  const response = await fetch(normalizeOpenAIBaseURL(settings.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true
    }),
    signal
  });

  if (!response.ok) {
    throw await createHTTPError(response);
  }

  if (!response.body) {
    throw new Error("模型响应没有返回流式内容。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const filterThinkTags = createThinkTagFilter();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const parsed = parseOpenAISSEChunk(buffer, decoder.decode(value, { stream: true }));
    buffer = parsed.buffer;
    for (const delta of parsed.deltas) {
      const visibleDelta = filterThinkTags(delta);
      if (visibleDelta) {
        onDelta(visibleDelta);
      }
    }
    if (parsed.done) {
      break;
    }
  }

  const finalText = decoder.decode();
  if (finalText) {
    const parsed = parseOpenAISSEChunk(buffer, finalText);
    for (const delta of parsed.deltas) {
      const visibleDelta = filterThinkTags(delta);
      if (visibleDelta) {
        onDelta(visibleDelta);
      }
    }
  }
}
