import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getAssistantSettingsFromRoot,
  readAssistantSettingsFromRoot,
  saveAssistantSettingsToRoot
} = require("../dist-electron/main/assistant/settings-store.js");
const {
  loadAgentPlatformMinimaxSettings,
  loadAgentPlatformProviderSettings
} = require("../dist-electron/main/assistant/agent-platform-config.js");
const {
  __testInternals: chatStoreInternals,
  appendAssistantEventToRoot,
  appendAssistantMessageToRoot,
  createAssistantMessage,
  deleteAssistantChatFromRoot,
  getAssistantChatFromRoot,
  listAssistantChatsFromRoot
} = require("../dist-electron/main/assistant/chat-store.js");
const {
  __testInternals: promptBuilderInternals,
  buildAssistantMessages,
  normalizeAttachments,
  normalizePageContext
} = require("../dist-electron/main/assistant/prompt-builder.js");
const {
  createAssistantAttachmentFromPastedImage,
  createAssistantAttachmentsFromFiles,
  hydrateAssistantAttachmentsForChat
} = require("../dist-electron/main/assistant/attachment-store.js");
const {
  chooseBestBrowserElement,
  extractBrowserClickIntent,
  extractBrowserInputIntent,
  isPotentiallySensitiveClickTarget
} = require("../dist-electron/main/assistant/browser-intent.js");
const { parseOpenAISSEChunk } = require("../dist-electron/main/assistant/sse-parser.js");
const {
  createThinkTagFilter,
  normalizeModelHTTPErrorMessage,
  normalizeOpenAIAudioTranscriptionsURL,
  normalizeOpenAIBaseURL,
  stripThinkTags
} = require("../dist-electron/main/assistant/model-provider.js");
const { AssistantRuntime } = require("../dist-electron/main/assistant/runtime.js");
const {
  __testInternals: desktopToolInternals,
  listDesktopFiles,
  moveDesktopFiles,
  planDesktopOrganize,
  readDesktopFile,
  writeDesktopFile
} = require("../dist-electron/main/assistant/desktop-tools.js");
const {
  ContainerHubClient,
  buildContainerHubRunSessionId
} = require("../dist-electron/main/assistant/container-hub.js");
const { PageAgentLLMProxy } = require("../dist-electron/main/assistant/page-agent-proxy.js");
const {
  resolvePageAgentBridgePath
} = require("../dist-electron/main/assistant/page-agent-bridge.js");

function isTerminalEvent(event) {
  return ["done", "error", "run.complete", "run.error", "run.stopped", "stopped"].includes(event.type);
}

function lastRunTerminalEvent(events) {
  return events.filter((event) => event.type === "run.complete" || event.type === "run.error" || event.type === "run.stopped").at(-1);
}

function visibleContent(events) {
  return events
    .filter((event) => event.type === "delta" || event.type === "content.delta")
    .map((event) => event.delta)
    .join("");
}

function encryptProviderAPIKey(envPart, plaintext) {
  const key = crypto
    .createHash("sha256")
    .update(`zenmind-provider:${envPart.trim()}`)
    .digest();
  const nonce = Buffer.from("0123456789ab");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `AES(${Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url")})`;
}

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-assistant-test-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function makeApp(root) {
  return {
    getPath(name) {
      if (name === "desktop") {
        return path.join(root, "Desktop");
      }
      assert.equal(name, "userData");
      return root;
    }
  };
}

test("assistant settings masks api key in public reads", (t) => {
  const root = makeTempRoot(t);
  const settings = saveAssistantSettingsToRoot(root, {
    baseURL: "https://example.com/v1/",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  assert.equal(settings.configured, true);
  assert.equal(settings.apiKeyConfigured, true);
  assert.equal(Object.hasOwn(settings, "apiKey"), false);
  assert.equal(readAssistantSettingsFromRoot(root).apiKey, "sk-secret");

  const publicSettings = getAssistantSettingsFromRoot(root);
  assert.deepEqual(publicSettings, settings);
});

test("assistant prompt truncates page context before model request", () => {
  const normalized = normalizePageContext({
    url: "https://example.com",
    title: "Example",
    selectedText: "s".repeat(9000),
    metaDescription: "meta",
    headings: ["h1"],
    bodyText: "b".repeat(45000)
  });

  assert.ok(normalized.selectedText.length < 8300);
  assert.ok(normalized.bodyText.length < 40350);
  assert.match(normalized.bodyText, /已截断/);

  const messages = buildAssistantMessages({
    history: [],
    message: "总结一下",
    action: "summarize_page",
    pageContext: normalized
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages.at(-1).content, /当前页面上下文/);
});

test("assistant prompt injects runtime context for non-page questions", () => {
  const messages = buildAssistantMessages({
    history: [],
    message: "现在几点了",
    action: "chat",
    runtimeContext: {
      localDateTime: "2026/04/30 星期四 20:30:00",
      isoTime: "2026-04-30T12:30:00.000Z",
      timeZone: "Asia/Shanghai",
      platform: "darwin"
    },
    pageContext: {
      url: "https://example.com/control",
      title: "ZenMind 控制中心",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "服务状态和配置信息"
    }
  });

  assert.match(messages[0].content, /运行上下文/);
  assert.match(messages[0].content, /不要因为页面内容没有时间显示而拒答/);
  assert.match(messages.at(-1).content, /<运行上下文>/);
  assert.match(messages.at(-1).content, /2026\/04\/30 星期四 20:30:00/);
  assert.match(messages.at(-1).content, /Asia\/Shanghai/);
  assert.match(messages.at(-1).content, /左侧网页目标：未检测到可操作网页目标/);
});

test("assistant prompt budgets long chat history for long-running conversations", () => {
  const history = Array.from({ length: 30 }, (_, index) => createAssistantMessage(
    index % 2 === 0 ? "user" : "assistant",
    `第${index}轮 ${"长内容".repeat(1200)}`
  ));
  const messages = buildAssistantMessages({
    history,
    message: "继续",
    action: "chat",
    pageContext: {
      url: "https://example.com",
      title: "Long page",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "页面内容".repeat(8000)
    }
  });
  const historyMessages = messages.slice(1, -1);
  const historyTextLength = historyMessages.reduce((sum, item) => {
    return sum + (typeof item.content === "string" ? item.content.length : 0);
  }, 0);

  assert.ok(historyMessages.length <= promptBuilderInternals.HISTORY_LIMIT);
  assert.ok(historyTextLength <= promptBuilderInternals.MAX_HISTORY_TOTAL_LENGTH + promptBuilderInternals.MAX_HISTORY_MESSAGE_LENGTH);
  assert.ok(historyMessages.every((item) => typeof item.content === "string" && item.content.length <= promptBuilderInternals.MAX_HISTORY_MESSAGE_LENGTH + 80));
  assert.ok(String(messages.at(-1).content).length < 13000);
});

test("assistant prompt injects attachment text context", () => {
  const normalized = normalizeAttachments([
    {
      id: "att_1",
      name: "report.md",
      mimeType: "text/markdown",
      sizeBytes: 20,
      text: "附件正文",
      truncated: false
    }
  ]);
  assert.equal(normalized[0].text, "附件正文");

  const messages = buildAssistantMessages({
    history: [],
    message: "结合网页总结",
    action: "chat",
    pageContext: null,
    attachments: normalized
  });
  assert.match(messages.at(-1).content, /附件上下文/);
  assert.match(messages.at(-1).content, /report\.md/);
  assert.match(messages.at(-1).content, /附件正文/);
});

test("assistant prompt sends image attachments as OpenAI-compatible content parts", () => {
  const dataUrl = "data:image/png;base64,AAECAwQ=";
  const messages = buildAssistantMessages({
    history: [],
    message: "识别这张图片",
    action: "chat",
    pageContext: null,
    attachments: [
      {
        id: "att_img",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 5,
        text: "",
        dataUrl
      }
    ]
  });
  const userMessage = messages.at(-1);
  assert.equal(Array.isArray(userMessage.content), true);
  assert.match(userMessage.content[0].text, /附件上下文/);
  assert.deepEqual(userMessage.content[1], {
    type: "image_url",
    image_url: {
      url: dataUrl
    }
  });
});

test("assistant SSE parser reads OpenAI deltas and done frame", () => {
  const first = parseOpenAISSEChunk("", 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
  assert.deepEqual(first.deltas, ["你"]);
  assert.equal(first.done, false);

  const second = parseOpenAISSEChunk(
    "",
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'
  );
  assert.deepEqual(second.deltas, ["好"]);
  assert.equal(second.done, true);
});

test("assistant model provider normalizes common MiniMax console URLs", () => {
  assert.equal(
    normalizeOpenAIBaseURL("https://platform.minimaxi.com"),
    "https://api.minimax.io/v1/chat/completions"
  );
  assert.equal(
    normalizeOpenAIBaseURL("https://api.minimaxi.com"),
    "https://api.minimaxi.com/v1/chat/completions"
  );
});

test("assistant model provider converts unauthorized JSON into a readable auth error", () => {
  const message = normalizeModelHTTPErrorMessage(
    401,
    JSON.stringify({
      type: "error",
      error: {
        type: "authorized_error",
        message: "invalid api key (2049)"
      },
      http_code: "401",
      request_id: "req_secret"
    })
  );

  assert.match(message, /API Key 无效或已过期/);
  assert.match(message, /provider 配置/);
  assert.doesNotMatch(message, /MiniMax 配置/);
  assert.doesNotMatch(message, /request_id|req_secret|authorized_error/);
});

test("page-agent bridge asset is built into the main-process output", () => {
  const bridgePath = resolvePageAgentBridgePath();
  assert.equal(path.basename(bridgePath), "page-agent-bridge.iife.js");
  assert.equal(path.isAbsolute(bridgePath), true);
  assert.equal(fs.existsSync(bridgePath), true);
});

test("page-agent LLM proxy validates run tokens and keeps provider api key server-side", async (t) => {
  let upstreamRequestCount = 0;
  const upstream = http.createServer((request, response) => {
    upstreamRequestCount += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer sk-secret");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.match(body, /demo-model/);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "AgentOutput",
                    arguments: "{}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const address = upstream.address();
  const upstreamBaseURL = `http://127.0.0.1:${address.port}/v1`;
  const proxy = new PageAgentLLMProxy();
  t.after(() => proxy.close());
  const session = await proxy.register({
    baseURL: upstreamBaseURL,
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const preflight = await fetch(`${session.baseURL}/chat/completions`, {
    method: "OPTIONS",
    headers: {
      origin: "https://www.baidu.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
      "access-control-request-private-network": "true"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers") || "", /authorization/);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  assert.equal(upstreamRequestCount, 0);

  const unauthorized = await fetch(`${session.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(upstreamRequestCount, 0);

  const authorized = await fetch(`${session.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`
    },
    body: JSON.stringify({ model: "demo-model" })
  });
  assert.equal(authorized.status, 200);
  assert.equal(upstreamRequestCount, 1);

  proxy.revoke(session.token);
  const revoked = await fetch(`${session.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`
    },
    body: "{}"
  });
  assert.equal(revoked.status, 401);
  assert.equal(upstreamRequestCount, 1);
});

test("assistant model provider hides streamed think tags", () => {
  const filter = createThinkTagFilter();
  assert.equal(filter("你好"), "你好");
  assert.equal(filter("<thi"), "");
  assert.equal(filter("nk>这段不显示"), "");
  assert.equal(filter("也不显示</thi"), "");
  assert.equal(filter("nk>OK"), "OK");
});

test("assistant model provider hides non-streamed think tags", () => {
  assert.equal(stripThinkTags("<think>内部推理</think>\n\n我是 ZenMind。"), "我是 ZenMind。");
});

test("assistant browser intent extracts click target and guards sensitive clicks", () => {
  assert.deepEqual(extractBrowserClickIntent("请帮我点击客户请求申请"), {
    action: "click",
    target: "客户请求申请"
  });
  assert.equal(extractBrowserClickIntent("这个页面有哪些内容"), null);
  assert.equal(isPotentiallySensitiveClickTarget("客户需求申请"), false);
  assert.equal(isPotentiallySensitiveClickTarget("确认提交"), true);
});

test("assistant browser intent extracts input, submit, and summarize chains", () => {
  assert.deepEqual(extractBrowserInputIntent("在输入框输入孙杨，然后总结页面内容"), {
    action: "input",
    value: "孙杨",
    submit: true,
    summarizeAfterSubmit: true
  });
  assert.deepEqual(extractBrowserInputIntent("搜索孙杨，然后总结结果"), {
    action: "input",
    value: "孙杨",
    submit: true,
    summarizeAfterSubmit: true
  });
  assert.deepEqual(extractBrowserInputIntent("在左边网页查一下孙杨"), {
    action: "input",
    value: "孙杨",
    submit: true,
    summarizeAfterSubmit: false
  });
  assert.deepEqual(extractBrowserInputIntent("在搜索框输入孙杨"), {
    action: "input",
    value: "孙杨",
    submit: false,
    summarizeAfterSubmit: false
  });
  assert.deepEqual(extractBrowserInputIntent("请在输入框输入电影，然后按下搜索"), {
    action: "input",
    value: "电影",
    submit: true,
    summarizeAfterSubmit: false
  });
  assert.deepEqual(extractBrowserInputIntent("请在百度输入相爱然后搜索"), {
    action: "input",
    value: "相爱",
    submit: true,
    summarizeAfterSubmit: false
  });
  assert.equal(extractBrowserInputIntent("请帮我填写好右侧的表单，不用提交，信息随便填"), null);
});

test("assistant browser intent fuzzy matches visible page elements", () => {
  const match = chooseBestBrowserElement([
    {
      index: 0,
      text: "会议室预约",
      tagName: "DIV",
      role: "",
      ariaLabel: "",
      x: 120,
      y: 80,
      width: 120,
      height: 40,
      interactive: true
    },
    {
      index: 1,
      text: "客户需求申请",
      tagName: "DIV",
      role: "",
      ariaLabel: "",
      x: 160,
      y: 120,
      width: 140,
      height: 48,
      interactive: true
    }
  ], "客户请求申请");

  assert.equal(match?.candidate.text, "客户需求申请");
});

test("assistant imports MiniMax settings from agent-platform registries", (t) => {
  const root = makeTempRoot(t);
  const registries = path.join(root, "zenmind-env", "registries");
  fs.mkdirSync(path.join(root, "Desktop", "agent-platform"), { recursive: true });
  fs.mkdirSync(path.join(registries, "providers"), { recursive: true });
  fs.mkdirSync(path.join(registries, "models"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Desktop", "agent-platform", ".env"),
    `REGISTRIES_DIR=${registries}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(registries, "providers", "minimax.yml"),
    [
      "key: minimax",
      "baseUrl: https://api.minimaxi.com",
      "apiKey: sk-test",
      "defaultModel: minimax-m2_7-openai",
      "protocols:",
      "  OPENAI:",
      "    endpointPath: /v1/chat/completions",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(registries, "models", "minimax-m2_7-openai.yml"),
    ["key: minimax-m2_7-openai", "provider: minimax", "protocol: OPENAI", "modelId: MiniMax-M2.7", ""].join("\n"),
    "utf8"
  );

  const settings = loadAgentPlatformMinimaxSettings(makeApp(root));
  assert.equal(settings.baseURL, "https://api.minimaxi.com/v1");
  assert.equal(settings.model, "MiniMax-M2.7");
  assert.equal(settings.apiKey, "sk-test");
});

test("assistant decrypts AES MiniMax provider keys with agent-platform key part", (t) => {
  const root = makeTempRoot(t);
  const registries = path.join(root, "zenmind-env", "registries");
  fs.mkdirSync(path.join(root, "Desktop", "agent-platform"), { recursive: true });
  fs.mkdirSync(path.join(registries, "providers"), { recursive: true });
  fs.mkdirSync(path.join(registries, "models"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Desktop", "agent-platform", ".env"),
    `REGISTRIES_DIR=${registries}\nPROVIDER_APIKEY_KEY_PART=0.1.0\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(registries, "providers", "minimax.yml"),
    [
      "key: minimax",
      "baseUrl: https://api.minimaxi.com",
      `apiKey: ${encryptProviderAPIKey("0.1.0", "sk-decrypted")}`,
      "defaultModel: minimax-m2_7-openai",
      "protocols:",
      "  OPENAI:",
      "    endpointPath: /v1/chat/completions",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(registries, "models", "minimax-m2_7-openai.yml"),
    ["key: minimax-m2_7-openai", "provider: minimax", "protocol: OPENAI", "modelId: MiniMax-M2.7", ""].join("\n"),
    "utf8"
  );

  const settings = loadAgentPlatformMinimaxSettings(makeApp(root));
  assert.equal(settings.baseURL, "https://api.minimaxi.com/v1");
  assert.equal(settings.model, "MiniMax-M2.7");
  assert.equal(settings.apiKey, "sk-decrypted");
});

test("assistant imports provider settings from the preferred hidden runtime registry", (t) => {
  const root = makeTempRoot(t);
  const registries = path.join(root, ".zenmind", "registries");
  fs.mkdirSync(path.join(registries, "providers"), { recursive: true });
  fs.writeFileSync(
    path.join(registries, "providers", "bailian.yml"),
    [
      "key: bailian",
      "baseUrl: https://dashscope.aliyuncs.com/compatible-mode",
      "apiKey: sk-bailian",
      "defaultModel: qwen3.5-plus",
      ""
    ].join("\n"),
    "utf8"
  );

  const settings = loadAgentPlatformProviderSettings(makeApp(root), "bailian", {
    modelId: "qwen3-asr-flash"
  });
  assert.equal(settings.baseURL, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(settings.model, "qwen3-asr-flash");
  assert.equal(settings.apiKey, "sk-bailian");
});

test("assistant can fall back to Desktop minimax.yml provider config", (t) => {
  const root = makeTempRoot(t);
  fs.mkdirSync(path.join(root, "Desktop", "agent-platform"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Desktop", "agent-platform", ".env"),
    [
      "REGISTRIES_DIR=/missing/registries",
      "PROVIDER_APIKEY_KEY_PART=0.1.0",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "Desktop", "minimax.yml"),
    [
      "key: minimax",
      "baseUrl: https://api.minimaxi.com",
      `apiKey: ${encryptProviderAPIKey("0.1.0", "sk-desktop-minimax")}`,
      "defaultModel: minimax-m2_7-openai",
      "protocols:",
      "  OPENAI:",
      "    endpointPath: /v1/chat/completions",
      ""
    ].join("\n"),
    "utf8"
  );

  const settings = loadAgentPlatformMinimaxSettings(makeApp(root));
  assert.equal(settings.baseURL, "https://api.minimaxi.com/v1");
  assert.equal(settings.model, "MiniMax-M2.7");
  assert.equal(settings.apiKey, "sk-desktop-minimax");
});

test("assistant chat store writes index, chat detail, and delete", (t) => {
  const root = makeTempRoot(t);
  const first = appendAssistantMessageToRoot(root, null, createAssistantMessage("user", "帮我总结当前页面"));
  appendAssistantMessageToRoot(root, first.summary.id, createAssistantMessage("assistant", "好的"));

  const list = listAssistantChatsFromRoot(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].messageCount, 2);

  const detail = getAssistantChatFromRoot(root, first.summary.id);
  assert.equal(detail.messages.length, 2);
  assert.deepEqual(detail.events, []);

  const event = appendAssistantEventToRoot(root, {
    id: "evt_1",
    seq: 1,
    runId: "run_1",
    chatId: first.summary.id,
    type: "run.start",
    status: "running",
    createdAt: new Date().toISOString(),
    message: "已开始生成。"
  });
  const eventPath = chatStoreInternals.getEventsPath(root, first.summary.id);
  assert.equal(eventPath, path.join(root, "chats", first.summary.id, "events.jsonl"));
  assert.equal(fs.existsSync(eventPath), true);
  assert.deepEqual(getAssistantChatFromRoot(root, first.summary.id).events, [event]);

  deleteAssistantChatFromRoot(root, first.summary.id);
  assert.equal(listAssistantChatsFromRoot(root).length, 0);
  assert.equal(getAssistantChatFromRoot(root, first.summary.id), null);
  assert.equal(fs.existsSync(eventPath), false);
});

test("assistant attachment store saves files under chat id directory", (t) => {
  const root = makeTempRoot(t);
  const source = path.join(root, "source.md");
  fs.writeFileSync(source, "# 标题\n附件正文", "utf8");

  const result = createAssistantAttachmentsFromFiles(makeApp(root), null, [source]);
  assert.equal(result.ok, true);
  assert.equal(result.attachments.length, 1);
  assert.match(result.attachments[0].text, /附件正文/);
  appendAssistantMessageToRoot(
    path.join(root, "assistant"),
    result.chatId,
    createAssistantMessage("user", "请看附件", "run_attachment", result.attachments)
  );

  const attachmentDir = path.join(root, "assistant", "chats", result.chatId, "attachments");
  assert.equal(fs.existsSync(attachmentDir), true);
  assert.ok(fs.readdirSync(attachmentDir).some((name) => name.endsWith("_source.md")));
  assert.equal(fs.existsSync(path.join(root, "assistant", "chats", result.chatId, "chat.json")), true);

  const detail = getAssistantChatFromRoot(path.join(root, "assistant"), result.chatId);
  assert.equal(detail.messages[0].attachments.length, 1);
  assert.equal(detail.messages[0].attachments[0].name, "source.md");
  assert.match(detail.messages[0].attachments[0].text, /附件正文/);
  assert.equal(Object.hasOwn(detail.messages[0].attachments[0], "dataUrl"), false);
});

test("assistant chat history restores legacy stored attachments on read", (t) => {
  const root = makeTempRoot(t);
  const source = path.join(root, "legacy-source.md");
  fs.writeFileSync(source, "旧附件正文", "utf8");

  const result = createAssistantAttachmentsFromFiles(makeApp(root), null, [source]);
  appendAssistantMessageToRoot(
    path.join(root, "assistant"),
    result.chatId,
    createAssistantMessage("user", "历史里应该看到附件", "run_legacy")
  );

  const detail = getAssistantChatFromRoot(path.join(root, "assistant"), result.chatId);
  assert.equal(detail.messages[0].attachments.length, 1);
  assert.equal(detail.messages[0].attachments[0].name, "legacy-source.md");
  assert.match(detail.messages[0].attachments[0].text, /旧附件正文/);
});

test("assistant attachment store saves pasted images under chat id directory", (t) => {
  const root = makeTempRoot(t);
  const result = createAssistantAttachmentFromPastedImage(makeApp(root), null, {
    name: "clip.png",
    mimeType: "image/png",
    data: new Uint8Array([137, 80, 78, 71]).buffer
  });

  assert.equal(result.ok, true);
  assert.equal(result.attachments.length, 1);
  assert.match(result.attachments[0].dataUrl, /^data:image\/png;base64,/);

  const attachmentDir = path.join(root, "assistant", "chats", result.chatId, "attachments");
  assert.equal(fs.existsSync(attachmentDir), true);
  assert.ok(fs.readdirSync(attachmentDir).some((name) => name.endsWith("_clip.png")));
  assert.equal(fs.existsSync(path.join(root, "assistant", "chats", result.chatId, "chat.json")), true);

  const historyAttachment = { ...result.attachments[0] };
  delete historyAttachment.dataUrl;
  const hydrated = hydrateAssistantAttachmentsForChat(makeApp(root), result.chatId, [historyAttachment]);
  assert.match(hydrated[0].dataUrl, /^data:image\/png;base64,/);
});

test("assistant runtime keeps ordinary chat out of browser tool mode", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, true);
    assert.equal(Object.hasOwn(payload, "tools"), false);
    return new Response('data: {"choices":[{"delta":{"content":"<think>内部推理</think>我是 ZenMind。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async observePage() {
      throw new Error("ordinary chat should not observe the browser");
    },
    async clickElementByText() {
      throw new Error("legacy click should not be used");
    },
    async fillBestInput() {
      throw new Error("legacy fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("legacy search should not be used");
    }
  };
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "你是谁",
    action: "chat",
    pageContext: {
      url: "https://example.com",
      title: "Example",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "页面内容",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(visibleContent(events), "我是 ZenMind。");
  assert.ok(events.every((event) => event.type !== "tool.start" && event.type !== "tool.result"));
});

test("assistant runtime answers current time questions without browser tool mode", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, true);
    assert.equal(Object.hasOwn(payload, "tools"), false);
    assert.match(JSON.stringify(payload.messages), /<运行上下文>/);
    assert.match(JSON.stringify(payload.messages), /本地时间/);
    return new Response('data: {"choices":[{"delta":{"content":"现在是本地时间。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async observePage() {
      throw new Error("time question should not observe the browser");
    },
    async fillBestInputAndSubmit() {
      throw new Error("time question should not search the browser");
    },
    async clickElementByText() {
      throw new Error("time question should not click the browser");
    },
    async fillBestInput() {
      throw new Error("time question should not fill the browser");
    }
  };
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "现在几点了",
    action: "chat",
    pageContext: {
      url: "https://example.com/control",
      title: "ZenMind 控制中心",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "服务状态和配置信息",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(visibleContent(events), "现在是本地时间。");
  assert.ok(events.every((event) => event.type !== "tool.start" && event.type !== "tool.result"));
});

test("assistant runtime keeps page-only questions in chat mode", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, true);
    assert.equal(Object.hasOwn(payload, "tools"), false);
    assert.match(JSON.stringify(payload.messages), /页面正文/);
    assert.match(JSON.stringify(payload.messages), /客户需求列表/);
    return new Response('data: {"choices":[{"delta":{"content":"这个页面是客户需求列表。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async observePage() {
      throw new Error("page-only question should not observe the browser");
    },
    async executeAgentTask() {
      throw new Error("page-only question should not use PageAgent");
    },
    async clickElementByText() {
      throw new Error("page-only question should not click the browser");
    },
    async fillBestInput() {
      throw new Error("page-only question should not fill the browser");
    },
    async fillBestInputAndSubmit() {
      throw new Error("page-only question should not search the browser");
    }
  };
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "这个页面讲了什么",
    action: "chat",
    pageContext: {
      url: "https://example.com/customers",
      title: "客户需求",
      selectedText: "",
      metaDescription: "",
      headings: ["客户需求"],
      bodyText: "客户需求列表，包含待跟进事项。",
      browserTarget: {
        kind: "webview",
        webContentsId: 8
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(visibleContent(events), "这个页面是客户需求列表。");
  assert.ok(events.every((event) => event.type !== "tool.start" && event.type !== "tool.result"));
});

test("assistant runtime runs left-web query through current webview search", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("direct left-web query should not call the model");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "搜索框"
      };
    },
    async observePage() {
      throw new Error("direct left-web query should not enter tool chooser");
    },
    async fillBestInput() {
      throw new Error("left-web query should submit search");
    },
    async clickElementByText() {
      throw new Error("left-web query should not click");
    }
  };
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "在左边网页查一下孙杨",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "百度首页",
      browserTarget: {
        kind: "webview",
        webContentsId: 9
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.deepEqual(calls, [["fillBestInputAndSubmit", 9, "孙杨"]]);
  assert.match(visibleContent(events), /已在输入框输入“孙杨”并提交/);
});

test("assistant runtime falls back to page context when web query has no browser target", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, true);
    assert.equal(Object.hasOwn(payload, "tools"), false);
    const transcript = JSON.stringify(payload.messages);
    assert.match(transcript, /左侧网页目标：未检测到可操作网页目标/);
    assert.match(transcript, /查一下孙杨/);
    return new Response('data: {"choices":[{"delta":{"content":"当前页面无法直接完成外部查询。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async fillBestInputAndSubmit() {
      throw new Error("missing web query should not attempt direct browser search");
    },
    async observePage() {
      throw new Error("missing web query should not enter browser tool mode");
    },
    async clickElementByText() {
      throw new Error("missing web query should not click");
    },
    async fillBestInput() {
      throw new Error("missing web query should not fill");
    }
  };
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "查一下孙杨",
    action: "chat",
    pageContext: {
      url: "zenmind://control-center",
      title: "ZenMind 控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["服务状态"],
      bodyText: "这里是服务状态页面，没有网页搜索框。"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(visibleContent(events), "当前页面无法直接完成外部查询。");
  assert.ok(events.every((event) => event.type !== "tool.start" && event.type !== "tool.result"));
});

test("assistant runtime routes explicit human-in-loop requests through AGW awaiting tool", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let fetchCount = 0;
  let submitted = false;
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    fetchCount += 1;
    assert.equal(submitted, true);
    const payload = JSON.parse(String(init?.body || "{}"));
    requests.push(payload);
    assert.equal(payload.stream, false);
    assert.ok(Array.isArray(payload.tools));
    assert.ok(payload.tools.some((tool) => tool.function?.name === "_ask_user_question_"));
    const transcript = JSON.stringify(payload.messages);
    assert.match(transcript, /按文件类型/);
    assert.match(transcript, /没有/);
    assert.match(transcript, /继续完成原始用户目标/);
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "我会按文件类型整理桌面，不删除文件。"
          }
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let runtime;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (event.type === "awaiting.ask") {
      assert.equal(event.awaitingId, event.awaiting.awaitingId);
      assert.equal(event.mode, "question");
      assert.equal(event.questions.length, 2);
      assert.equal(event.questions[0].question, "我希望按什么维度整理桌面文件？");
      assert.equal(event.questions[1].question, "有没有需要删除的文件？");
      setImmediate(() => {
        submitted = true;
        const result = runtime.submitAwaiting({
          awaitingId: event.awaitingId,
          runId: event.runId,
          action: "submit",
          params: [
            {
              id: "q1",
              answers: ["按文件类型"]
            },
            {
              id: "q2",
              answer: "没有"
            }
          ]
        });
        assert.equal(result.ok, true);
      });
    }
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  });

  const start = runtime.startRun({
    message: "请调用 human in the loop 采访我，弹窗问我两个问题：1. 我希望按什么维度整理桌面文件？2. 有没有需要删除的文件？",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(fetchCount, 1);
  assert.equal(requests.length, 1);
  assert.ok(events.some((event) => event.type === "awaiting.ask" && event.toolName === "_ask_user_question_"));
  assert.ok(events.some((event) => event.type === "awaiting.answer" && event.status === "answered"));
  assert.equal(visibleContent(events), "我会按文件类型整理桌面，不删除文件。");
});

test("assistant voice correction preserves mixed Chinese and English text without chat side effects", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    requests.push(payload);
    assert.equal(payload.stream, false);
    assert.equal(payload.model, "demo-model");
    assert.equal(payload.messages[0].role, "system");
    assert.match(payload.messages[0].content, /中文加英文混合/u);
    assert.match(payload.messages[0].content, /不要把英文翻译成中文/u);
    assert.match(payload.messages[1].content, /locale: zh-CN-mixed-en/u);
    const input = payload.messages[1].content;
    const content = input.includes("please help me check github actions")
      ? "please help me check GitHub Actions"
      : "帮我看一下 OpenAI 的 API Key 设置";
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content
          }
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const runtime = new AssistantRuntime(makeApp(root), (event) => events.push(event));

  const mixedResult = await runtime.correctVoiceText({
    text: "帮我看一下 open ai 的 api key 设置",
    locale: "zh-CN-mixed-en"
  });
  assert.equal(mixedResult.ok, true);
  assert.equal(mixedResult.text, "帮我看一下 OpenAI 的 API Key 设置");

  const englishResult = await runtime.correctVoiceText({
    text: "please help me check github actions",
    locale: "zh-CN-mixed-en"
  });
  assert.equal(englishResult.ok, true);
  assert.equal(englishResult.text, "please help me check GitHub Actions");

  assert.equal(requests.length, 2);
  assert.deepEqual(events, []);
  assert.equal(fs.existsSync(path.join(root, "assistant", "chats")), false);
});

test("assistant voice correction keeps ASR text when model correction fails", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: "temporarily unavailable"
    }
  }), {
    status: 500,
    headers: { "content-type": "application/json" }
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const runtime = new AssistantRuntime(makeApp(root), (event) => events.push(event));
  const result = await runtime.correctVoiceText({
    text: "帮我看一下 open ai",
    locale: "zh-CN-mixed-en"
  });

  assert.equal(result.ok, false);
  assert.equal(result.text, "帮我看一下 open ai");
  assert.match(result.message, /已保留原文/u);
  assert.deepEqual(events, []);
});

test("assistant model provider derives audio transcription endpoint from chat endpoint", () => {
  assert.equal(
    normalizeOpenAIAudioTranscriptionsURL("https://api.openai.com/v1"),
    "https://api.openai.com/v1/audio/transcriptions"
  );
  assert.equal(
    normalizeOpenAIAudioTranscriptionsURL("https://example.com/v1/chat/completions"),
    "https://example.com/v1/audio/transcriptions"
  );
});

test("assistant voice transcription sends recorded audio without chat side effects", async (t) => {
  const root = makeTempRoot(t);
  const providerDir = path.join(root, "Desktop", "zenmind-env", "registries", "providers");
  fs.mkdirSync(providerDir, { recursive: true });
  fs.writeFileSync(path.join(providerDir, "bailian.yml"), [
    "key: bailian",
    "baseUrl: https://dashscope.aliyuncs.com/compatible-mode",
    "apiKey: sk-bailian",
    "defaultModel: qwen3.5-plus",
    ""
  ].join("\n"), "utf8");

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    assert.equal(String(url), "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer sk-bailian");
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.model, "qwen3-asr-flash");
    assert.equal(payload.stream, false);
    assert.equal(payload.asr_options.enable_itn, true);
    assert.equal(payload.messages[1].content[0].type, "input_audio");
    assert.equal(
      String(payload.messages[1].content[0].input_audio.data).startsWith("data:audio/wav;base64,"),
      true
    );
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "帮我检查 GitHub Actions"
          }
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const runtime = new AssistantRuntime(makeApp(root), (event) => events.push(event));
  const result = await runtime.transcribeVoiceAudio({
    mimeType: "audio/wav",
    data: new Uint8Array([1, 2, 3, 4]).buffer,
    locale: "zh-CN-mixed-en"
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "帮我检查 GitHub Actions");
  assert.equal(requests.length, 1);
  assert.deepEqual(events, []);
  assert.equal(fs.existsSync(path.join(root, "assistant", "chats")), false);
});

test("assistant runtime stopRun aborts active request", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (_url, init) => {
    init.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const runtime = new AssistantRuntime(makeApp(root), (event) => events.push(event));
  const start = runtime.startRun({
    message: "你好",
    action: "chat"
  });
  assert.equal(start.ok, true);

  const stop = runtime.stopRun(start.runId);
  assert.equal(stop.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(aborted, true);
  assert.deepEqual(events.map((event) => event.type), ["request.query", "chat.start", "run.start", "run.stopped", "done"]);
  assert.equal(lastRunTerminalEvent(getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId).events).type, "run.stopped");
});

test("assistant runtime persists readable model errors without raw provider JSON", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: "error",
    error: {
      type: "authorized_error",
      message: "invalid api key (2049)"
    },
    http_code: "401",
    request_id: "req_secret"
  }), { status: 401, headers: { "content-type": "application/json" } });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  });

  const start = runtime.startRun({
    message: "你好",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  const terminalEvent = lastRunTerminalEvent(events);
  assert.equal(terminalEvent.type, "run.error");
  assert.match(terminalEvent.error, /API Key 无效或已过期/);
  assert.doesNotMatch(terminalEvent.error, /req_secret|authorized_error/);

  const detail = getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId);
  assert.match(detail.messages.at(-1).content, /API Key 无效或已过期/);
  assert.doesNotMatch(detail.messages.at(-1).content, /req_secret|authorized_error/);
  assert.match(lastRunTerminalEvent(detail.events).message, /生成失败/);
});

test("assistant runtime records sensitive browser clicks as confirmation events", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, {
    async clickElementByText() {
      throw new Error("sensitive click should be blocked before browser action");
    },
    async fillBestInput() {
      throw new Error("fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("search should not be used");
    },
    async readPageContext() {
      throw new Error("read should not be used");
    }
  });

  const start = runtime.startRun({
    message: "请点击确认提交",
    action: "chat",
    pageContext: {
      url: "https://example.com/form",
      title: "审批表单",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "确认提交",
      browserTarget: {
        kind: "webview",
        webContentsId: 8
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.deepEqual(events.map((event) => event.type), [
    "request.query",
    "chat.start",
    "run.start",
    "awaiting.confirm",
    "content.delta",
    "run.complete",
    "done"
  ]);
  assert.equal(events.find((event) => event.type === "awaiting.confirm").status, "blocked");
  assert.match(visibleContent(events), /敏感操作/);
  assert.equal(
    getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId)
      .events.some((event) => event.type === "awaiting.confirm"),
    true
  );
});

test("assistant runtime runs browser input search before summarizing page", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"总结完成"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async clickElementByText() {
      throw new Error("click should not be used");
    },
    async fillBestInput() {
      throw new Error("fill without submit should not be used");
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "搜索框"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.baidu.com/s?wd=%E5%AD%99%E6%9D%A8",
        title: "孙杨_百度搜索",
        selectedText: "",
        metaDescription: "",
        headings: [],
        bodyText: "孙杨 百度搜索结果 页面内容",
        browserTarget: {
          kind: "webview",
          webContentsId
        }
      };
    }
  };

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "在输入框输入孙杨，然后总结页面内容",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "百度首页",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);

  assert.deepEqual(calls, [
    ["fillBestInputAndSubmit", 7, "孙杨"],
    ["readPageContext", 7]
  ]);
  assert.match(visibleContent(events), /总结完成/);
});

test("assistant runtime executes current page input search without model tool loop", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("model should not be called for current page search");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async listSurfaces() {
      throw new Error("surface activation should not be used for current page search");
    },
    async observePage() {
      throw new Error("browser tool loop should not observe for current page search");
    },
    async clickElementByText() {
      throw new Error("click should not be used");
    },
    async fillBestInput() {
      throw new Error("fill without submit should not be used");
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "百度搜索框"
      };
    },
    async readPageContext() {
      throw new Error("read should not be used without a summarize request");
    }
  };

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "请在百度输入相爱然后搜索",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下，你就知道",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "百度首页",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);

  assert.deepEqual(calls, [["fillBestInputAndSubmit", 7, "相爱"]]);
  assert.match(visibleContent(events), /已在输入框输入“相爱”并提交/);
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
});

test("assistant runtime routes explicit PageAgent requests to agent execution before direct search", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("model tool chooser should not be called for explicit PageAgent requests");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async executeAgentTask(webContentsId, input) {
      calls.push(["executeAgentTask", webContentsId, input]);
      return {
        ok: true,
        action: "agent_execute",
        target: input.task,
        message: "PageAgent 已完成：前3条结果已读取。",
        data: {
          success: true,
          finalText: "前3条结果已读取。",
          history: [],
          url: "https://www.baidu.com/s?wd=%E7%9B%B8%E7%88%B1",
          title: "相爱_百度搜索"
        }
      };
    },
    async fillBestInputAndSubmit() {
      throw new Error("explicit PageAgent request should not use direct search");
    },
    async fillBestInput() {
      throw new Error("explicit PageAgent request should not use direct fill");
    },
    async clickElementByText() {
      throw new Error("click should not be used");
    },
    async readPageContext() {
      throw new Error("read should not be used");
    }
  };

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "请用 PageAgent 连续操作当前百度网页：关键词是相爱，完成查找并读取结果页前3条标题，最后告诉我。",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下，你就知道",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "百度首页",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "executeAgentTask");
  assert.equal(calls[0][1], 7);
  assert.equal(calls[0][2].task, "请用 PageAgent 连续操作当前百度网页：关键词是相爱，完成查找并读取结果页前3条标题，最后告诉我。");
  assert.equal(calls[0][2].allowSensitive, false);
  assert.match(calls[0][2].systemInstruction, /不要点击麦克风、相机、图片上传/);
  assert.match(calls[0][2].systemInstruction, /不要把输入框下方的联想词/);
  assert.match(visibleContent(events), /PageAgent 已完成/);
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_agent_execute"));
});

test("assistant runtime recovers PageAgent search titles after max-step failure", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("model tool chooser should not be called for explicit PageAgent requests");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async executeAgentTask(webContentsId, input) {
      calls.push(["executeAgentTask", webContentsId, input]);
      return {
        ok: false,
        action: "agent_execute",
        target: input.task,
        error: "page_agent_failed",
        message: "PageAgent 未完成：Step count exceeded maximum limit",
        data: {
          success: false,
          finalText: "Step count exceeded maximum limit",
          history: [],
          url: "https://www.baidu.com/s?wd=%E7%9B%B8%E7%88%B1",
          title: "相爱_百度搜索"
        }
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.baidu.com/s?wd=%E7%9B%B8%E7%88%B1",
        title: "相爱_百度搜索",
        selectedText: "",
        metaDescription: "",
        headings: [
          "百度热搜",
          "相爱(1986年张学友发行... - 百度百科",
          "相爱，汉语词语，百度百科",
          "上条「百度AI」内容，你觉得满意吗？",
          "相爱 - 智能分身实时回复",
          "相爱_词语_成语_百度汉语"
        ],
        bodyText: "相爱 搜索结果",
        browserTarget: {
          kind: "webview",
          webContentsId
        }
      };
    }
  };

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "请用 PageAgent 自动操作当前百度页面：搜索相爱并读取前3条网页搜索结果标题。",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下，你就知道",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "百度首页",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);

  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ["executeAgentTask", 7],
    ["readPageContext", 7]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /PageAgent 已完成网页搜索/);
  assert.match(visibleText, /1\. 相爱\(1986年张学友发行/);
  assert.match(visibleText, /2\. 相爱，汉语词语，百度百科/);
  assert.match(visibleText, /3\. 相爱 - 智能分身实时回复/);
  assert.doesNotMatch(visibleText, /Step count exceeded/);
  const finalToolEvent = events
    .filter((event) => event.type === "tool.result" && event.toolName === "browser_agent_execute" && event.action === "agent_execute")
    .at(-1);
  assert.equal(finalToolEvent?.status, "ok");
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
});

test("assistant runtime lets model drive variable browser instructions through tools", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const toolResponses = [
    { id: "tool_surfaces", name: "browser_surfaces", arguments: "{}" },
    { id: "tool_activate", name: "browser_activate_surface", arguments: JSON.stringify({ target: "百度" }) },
    { id: "tool_observe", name: "browser_observe", arguments: "{}" },
    {
      id: "tool_fill",
      name: "browser_fill",
      arguments: JSON.stringify({
        fields: [
          {
            label: "搜索框",
            value: "今日热点"
          }
        ]
      })
    },
    { id: "tool_submit", name: "browser_submit", arguments: JSON.stringify({ target: "百度一下" }) },
    { id: "tool_read", name: "browser_read", arguments: "{}" }
  ];
  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    assert.ok(Array.isArray(payload.tools), "browser tool loop should pass tool definitions");

    const nextTool = toolResponses[fetchIndex++];
    if (nextTool) {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: nextTool.id,
                  type: "function",
                  function: {
                    name: nextTool.name,
                    arguments: nextTool.arguments
                  }
                }
              ]
            }
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "已在百度搜索“今日热点”。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async listSurfaces() {
      calls.push(["listSurfaces"]);
      return [
        {
          id: "custom-baidu",
          label: "百度",
          url: "https://www.baidu.com/"
        }
      ];
    },
    async activateSurface(target) {
      calls.push(["activateSurface", target]);
      return {
        ok: true,
        action: "activate_surface",
        target,
        message: "已打开「百度」。",
        data: {
          surface: {
            id: "custom-baidu",
            label: "百度",
            url: "https://www.baidu.com/",
            currentUrl: "https://www.baidu.com/",
            webContentsId: 77
          }
        }
      };
    },
    async observePage(webContentsId) {
      calls.push(["observePage", webContentsId]);
      return {
        ok: true,
        action: "observe",
        url: "https://www.baidu.com/",
        title: "百度一下",
        bodyText: "百度首页",
        elements: [
          {
            index: 0,
            elementRef: "{\"selector\":\"#su\",\"text\":\"百度一下\"}",
            kind: "button",
            text: "百度一下",
            tagName: "BUTTON",
            role: "",
            ariaLabel: "",
            x: 500,
            y: 40,
            width: 120,
            height: 44,
            interactive: true,
            unsafe: false
          }
        ],
        fields: [
          {
            index: 0,
            elementRef: "{\"selector\":\"#kw\",\"label\":\"搜索框\"}",
            label: "搜索框",
            tagName: "INPUT",
            type: "search",
            role: "",
            value: "",
            placeholder: "",
            checked: false,
            options: [],
            x: 120,
            y: 40,
            width: 400,
            height: 44
          }
        ]
      };
    },
    async fillFields(webContentsId, fields) {
      calls.push(["fillFields", webContentsId, fields]);
      return {
        ok: true,
        action: "fill",
        message: "已填写 1 个字段。"
      };
    },
    async submit(webContentsId, input) {
      calls.push(["submit", webContentsId, input]);
      return {
        ok: true,
        action: "submit",
        target: input.target,
        message: "已提交搜索。"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
        title: "今日热点_百度搜索",
        selectedText: "",
        metaDescription: "",
        headings: [],
        bodyText: "今日热点 搜索结果",
        browserTarget: {
          kind: "webview",
          webContentsId
        }
      };
    },
    async clickElementByText() {
      throw new Error("legacy click should not be used");
    },
    async fillBestInput() {
      throw new Error("legacy fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("legacy search should not be used");
    }
  };

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "帮我在百度里面搜索今日热点",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);

  assert.deepEqual(calls, [
    ["listSurfaces"],
    ["activateSurface", "百度"],
    ["observePage", 77],
    ["fillFields", 77, [{ label: "搜索框", value: "今日热点" }]],
    ["submit", 77, { target: "百度一下" }],
    ["readPageContext", 77]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /今日热点/);
  assert.doesNotMatch(visibleText, /里面搜索今日热点/);
  assert.equal(events[0].type, "request.query");
  assert.equal(events[2].type, "run.start");
  assert.ok(events.some((event) => event.type === "tool.start" && event.toolName === "browser_observe"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_fill"));
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
  assert.ok(
    getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId)
      .events.some((event) => event.type === "tool.result" && event.toolName === "browser_fill")
  );
});

test("assistant runtime exposes PageAgent browser execution as a right-dock tool", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    assert.ok(payload.tools.some((tool) => tool.function?.name === "browser_agent_execute"));
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tool_page_agent",
                type: "function",
                function: {
                  name: "browser_agent_execute",
                  arguments: JSON.stringify({
                    task: "连续查看页面并完成普通搜索",
                    target: "当前页"
                  })
                }
              }
            ]
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async executeAgentTask(webContentsId, input, options) {
      calls.push(["executeAgentTask", webContentsId, input]);
      options.onEvent({
        type: "activity",
        message: "PageAgent 正在点击搜索按钮。",
        data: { tool: "click" }
      });
      return {
        ok: true,
        action: "agent_execute",
        target: input.target,
        message: "PageAgent 已完成普通搜索。",
        data: {
          success: true,
          finalText: "PageAgent 已完成普通搜索。",
          history: [],
          url: "https://example.com/search",
          title: "Search"
        }
      };
    },
    async clickElementByText() {
      throw new Error("legacy click should not be used");
    },
    async fillBestInput() {
      throw new Error("legacy fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("legacy search should not be used");
    },
    async readPageContext() {
      throw new Error("legacy read should not be used");
    }
  };

  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "帮我用浏览器连续操作当前网页完成搜索",
    action: "chat",
    pageContext: {
      url: "https://example.com",
      title: "Example",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "搜索页面",
      browserTarget: {
        kind: "webview",
        webContentsId: 33
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.deepEqual(calls, [
    ["executeAgentTask", 33, {
      task: "连续查看页面并完成普通搜索",
      target: "当前页",
      allowSensitive: false
    }]
  ]);
  assert.match(visibleContent(events), /PageAgent 已完成普通搜索/);
  assert.ok(events.some((event) => event.type === "tool.result" && event.action === "agent_execute.activity"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_agent_execute"));
});

test("assistant runtime requires confirmation before PageAgent sensitive browser tasks", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "tool_page_agent_sensitive",
              type: "function",
              function: {
                name: "browser_agent_execute",
                arguments: JSON.stringify({
                  task: "点击确认提交并保存表单",
                  allowSensitive: true
                })
              }
            }
          ]
        }
      }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async executeAgentTask(webContentsId, input) {
      calls.push(["executeAgentTask", webContentsId, input]);
      return {
        ok: true,
        action: "agent_execute",
        message: "PageAgent 已提交表单。",
        data: {
          success: true,
          finalText: "PageAgent 已提交表单。",
          history: []
        }
      };
    },
    async clickElementByText() {
      throw new Error("legacy click should not be used");
    },
    async fillBestInput() {
      throw new Error("legacy fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("legacy search should not be used");
    },
    async readPageContext() {
      throw new Error("legacy read should not be used");
    }
  };

  const events = [];
  let runtime;
  let answered = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (event.type === "awaiting.ask" && !answered) {
      answered = true;
      setImmediate(() => {
        runtime.submitAwaiting({
          awaitingId: event.awaiting.awaitingId,
          action: "submit",
          params: [],
          reason: ""
        });
      });
    }
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);

  const start = runtime.startRun({
    message: "请用浏览器点击确认提交并保存表单",
    action: "chat",
    pageContext: {
      url: "https://example.com/form",
      title: "Form",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "确认提交 保存",
      browserTarget: {
        kind: "webview",
        webContentsId: 44
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(answered, true);
  assert.deepEqual(calls, [
    ["executeAgentTask", 44, {
      task: "点击确认提交并保存表单",
      target: undefined,
      allowSensitive: true
    }]
  ]);
  assert.ok(events.some((event) => event.type === "awaiting.ask" && event.toolName === "browser_agent_execute"));
  assert.match(visibleContent(events), /PageAgent 已提交表单/);
});

test("assistant runtime treats generic search clicks as submit actions", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const toolResponses = [
    { id: "tool_observe", name: "browser_observe", arguments: "{}" },
    {
      id: "tool_fill",
      name: "browser_fill",
      arguments: JSON.stringify({
        fields: [{ label: "搜索框", value: "电影" }]
      })
    },
    { id: "tool_click", name: "browser_click", arguments: JSON.stringify({ target: "搜索" }) }
  ];
  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);

    const nextTool = toolResponses[fetchIndex++];
    if (nextTool) {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: nextTool.id,
                  type: "function",
                  function: {
                    name: nextTool.name,
                    arguments: nextTool.arguments
                  }
                }
              ]
            }
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "已搜索电影。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async observePage(webContentsId) {
      calls.push(["observePage", webContentsId]);
      return {
        ok: true,
        action: "observe",
        url: "https://www.baidu.com/",
        title: "百度一下",
        bodyText: "百度首页",
        elements: [],
        fields: []
      };
    },
    async fillFields(webContentsId, fields) {
      calls.push(["fillFields", webContentsId, fields]);
      return { ok: true, action: "fill", message: "已填写 1 个字段。" };
    },
    async submit(webContentsId, input) {
      calls.push(["submit", webContentsId, input]);
      return { ok: true, action: "submit", target: input.target, message: "已提交搜索。" };
    },
    async click() {
      throw new Error("generic search click should be routed to submit");
    },
    async clickElementByText() {
      throw new Error("legacy click should not be used");
    },
    async fillBestInput() {
      throw new Error("legacy fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("legacy search should not be used");
    }
  };

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "请用浏览器工具按页面流程处理电影这个关键词",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "百度首页",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);

  assert.deepEqual(calls, [
    ["observePage", 7],
    ["fillFields", 7, [{ label: "搜索框", value: "电影" }]],
    ["submit", 7, { target: "搜索" }]
  ]);
  assert.match(visibleContent(events), /电影/);
});

test("assistant runtime auto-completes form autofill without exhausting browser steps", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    fetchCount += 1;
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    assert.ok(payload.tools.some((tool) => tool.function?.name === "browser_autofill"));

    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tool_autofill",
                type: "function",
                function: {
                  name: "browser_autofill",
                  arguments: JSON.stringify({
                    instruction: "网页表单自动处理",
                    submit: false
                  })
                }
              }
            ]
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async observePage() {
      throw new Error("autofill should not require separate observe mock");
    },
    async autofillForm(webContentsId, input) {
      calls.push(["autofillForm", webContentsId, input]);
      return {
        ok: true,
        action: "autofill",
        message: "已填写 5 个字段。 未提交表单。"
      };
    },
    async clickElementByText() {
      throw new Error("legacy click should not be used");
    },
    async fillBestInput() {
      throw new Error("legacy fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("legacy search should not be used");
    }
  };

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "网页表单自动处理",
    action: "chat",
    pageContext: {
      url: "https://example.com/form",
      title: "权限申请",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "权限申请表单",
      browserTarget: {
        kind: "webview",
        webContentsId: 9
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.equal(fetchCount, 1);
  assert.deepEqual(calls, [
    ["autofillForm", 9, {
      instruction: "网页表单自动处理",
      submit: false
    }]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /已填写 5 个字段/);
  assert.doesNotMatch(visibleText, /步骤已达到上限/);
});

test("assistant runtime directly autofills casual form requests on current page", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("casual form autofill should not call the model first");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async autofillForm(webContentsId, input) {
      calls.push(["autofillForm", webContentsId, input]);
      return {
        ok: true,
        action: "autofill",
        message: "已填写 4 个字段。 未提交表单。"
      };
    },
    async clickElementByText() {
      throw new Error("legacy click should not be used");
    },
    async fillBestInput() {
      throw new Error("legacy fill should not be used");
    },
    async fillBestInputAndSubmit() {
      throw new Error("legacy search should not be used");
    }
  };

  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, browserUse);
  const start = runtime.startRun({
    message: "请帮我填写好右侧的表单，不用提交，信息随便填",
    action: "chat",
    pageContext: {
      url: "https://example.com/form",
      title: "权限申请",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "权限申请表单",
      browserTarget: {
        kind: "webview",
        webContentsId: 12,
        browserSkill: "岗位名称=客户经理"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.deepEqual(calls, [
    ["autofillForm", 12, {
      instruction: "请帮我填写好右侧的表单，不用提交，信息随便填",
      skill: "岗位名称=客户经理",
      submit: false
    }]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /已填写 4 个字段/);
  assert.doesNotMatch(visibleText, /步骤已达到上限/);
  assert.ok(events.some((event) => event.type === "tool.start" && event.toolName === "browser_autofill"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_autofill"));
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
});

test("desktop tools list, read, write, and preview organize only allowed Desktop paths", (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, "notes.txt"), "hello", "utf8");
  fs.writeFileSync(path.join(desktop, "photo.png"), "png", "utf8");

  const listed = listDesktopFiles(app, {}, null);
  assert.deepEqual(listed.entries.map((entry) => entry.name).sort(), ["notes.txt", "photo.png"]);

  const read = readDesktopFile(app, { path: "notes.txt" }, null);
  assert.equal(read.content, "hello");

  const written = writeDesktopFile(app, {
    filename: "game.html",
    content: "<!doctype html><title>Snake</title>"
  }, null);
  assert.equal(fs.existsSync(written.path), true);

  const plan = planDesktopOrganize(app, {}, null);
  assert.ok(plan.moves.some((move) => move.to.endsWith(path.join("Images", "photo.png"))));

  assert.throws(
    () => desktopToolInternals.resolveDesktopToolPath(app, path.join(root, "outside.txt"), null),
    /允许范围/
  );
});

test("desktop move tool applies organize plan with conflict-safe destinations", (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(path.join(desktop, "Images"), { recursive: true });
  fs.writeFileSync(path.join(desktop, "photo.png"), "new", "utf8");
  fs.writeFileSync(path.join(desktop, "Images", "photo.png"), "old", "utf8");

  const plan = planDesktopOrganize(app, {}, null);
  const result = moveDesktopFiles(app, { moves: plan.moves }, null);

  assert.equal(result.moved.length, 1);
  assert.equal(fs.existsSync(path.join(desktop, "Images", "photo 1.png")), true);
  assert.equal(fs.readFileSync(path.join(desktop, "Images", "photo 1.png"), "utf8"), "new");
});

test("assistant runtime waits for HITL before writing Desktop files", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    assert.ok(payload.tools.some((tool) => tool.function?.name === "desktop_write_file"));
    fetchIndex += 1;
    if (fetchIndex === 1) {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "tool_write",
                  type: "function",
                  function: {
                    name: "desktop_write_file",
                    arguments: JSON.stringify({
                      filename: "snake.html",
                      content: "<!doctype html><title>Snake</title>",
                      overwrite: false
                    })
                  }
                }
              ]
            }
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "已生成 snake.html。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let runtime;
  const done = new Promise((resolve) => {
    runtime = new AssistantRuntime(app, (event) => {
      events.push(event);
      if (event.type === "awaiting.ask") {
        const result = runtime.submitAwaiting({
          awaitingId: event.awaiting.awaitingId,
          action: "submit",
          params: []
        });
        assert.equal(result.ok, true);
      }
      if (event.type === "run.complete") {
        resolve();
      }
    });
  });

  const start = runtime.startRun({
    message: "生成一个贪吃蛇 HTML 到桌面",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(fs.existsSync(path.join(root, "Desktop", "snake.html")), true);
  assert.ok(events.some((event) => event.type === "awaiting.ask" && event.awaiting?.mode === "approval"));
  assert.ok(events.some((event) => event.type === "awaiting.answer"));
  assert.ok(events.some((event) => event.type === "artifact.publish"));
});

test("container hub client creates, executes, and stops a run session", async (t) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      calls.push([req.method, req.url, body ? JSON.parse(body) : null]);
      if (req.url === "/api/runtime-info") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ engine: "docker" }));
        return;
      }
      if (req.url === "/api/sessions/create") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ session_id: "run-demo", environment_name: "shell", cwd: "/workspace" }));
        return;
      }
      if (req.url === "/api/sessions/run-demo/execute") {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("hello sandbox");
        return;
      }
      if (req.url === "/api/sessions/run-demo/stop") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ session_id: "run-demo", status: "stopped" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;
  const client = new ContainerHubClient({ baseURL, timeoutMs: 3000 });
  assert.deepEqual(await client.getRuntimeInfo(), { ok: true, engine: "docker" });
  const session = await client.createSession({
    sessionId: "run-demo",
    environmentName: "shell",
    mounts: [{ source: "/tmp/workspace", destination: "/workspace", read_only: false }]
  });
  assert.equal(session.sessionId, "run-demo");
  const result = await client.executeSession({
    sessionId: "run-demo",
    command: "echo hello"
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "hello sandbox");
  await client.stopSession("run-demo");
  assert.equal(calls.at(-1)[1], "/api/sessions/run-demo/stop");
  assert.match(buildContainerHubRunSessionId("RUN_x y"), /^run-run_x-y/);
});
