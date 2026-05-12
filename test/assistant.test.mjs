import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const {
  getAssistantSettingsFromRoot,
  readAssistantSettingsFromRoot,
  saveAssistantSettingsToRoot
} = require("../dist-electron/main/assistant/settings-store.js");
const {
  getAssistantMemoryPathFromRoot,
  readAssistantMemoryFromRoot,
  readAssistantMemorySnapshotFromRoot,
  saveAssistantMemoryToRoot,
  getAssistantMemoryStorageFromRoot,
  getAssistantMemorySettingsFromRoot,
  saveAssistantMemorySettingsToRoot,
  listAssistantMemoryItemsFromRoot,
  upsertAssistantMemoryItemsFromRoot,
  deleteAssistantMemoryItemFromRoot,
  clearAssistantMemoryItemsFromRoot,
  getAssistantMemoryStatsFromRoot,
  getAssistantMemorySummaryFromRoot,
  upsertExplicitUserMemoryFromRoot
} = require("../dist-electron/main/assistant/memory-store.js");
const {
  getAgentPlatformSettingsPublic,
  loadAgentPlatformMinimaxSettings,
  loadAgentPlatformProviderSettings,
  loadAgentPlatformVoiceAsrSettings
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
  extractBrowserTaskIntent,
  extractBrowserClickIntent,
  extractBrowserInputIntent,
  isPotentiallySensitiveClickTarget
} = require("../dist-electron/main/assistant/browser-intent.js");
const {
  BrowserRuntime,
  __testInternals: browserRuntimeInternals
} = require("../dist-electron/main/assistant/browser-runtime.js");
const { parseOpenAISSEChunk } = require("../dist-electron/main/assistant/sse-parser.js");
const {
  createThinkTagFilter,
  normalizeModelHTTPErrorMessage,
  normalizeOpenAIAudioTranscriptionsURL,
  normalizeOpenAIBaseURL,
  stripThinkTags
} = require("../dist-electron/main/assistant/model-provider.js");
const {
  canDescribeImageWithVision,
  describeImageWithVision
} = require("../dist-electron/main/assistant/vision-provider.js");
const { AssistantRuntime } = require("../dist-electron/main/assistant/runtime.js");
const {
  __testInternals: desktopToolInternals,
  deleteDesktopFiles,
  listHostStartupItems,
  listDesktopFiles,
  moveDesktopFiles,
  planDesktopOrganize,
  readDesktopFile,
  removeHostStartupItems,
  readDesktopDocument,
  writeDesktopFile
} = require("../dist-electron/main/assistant/desktop-tools.js");
const {
  __testInternals: capabilityBrokerInternals,
  routeAssistantToolRequest
} = require("../dist-electron/main/assistant/capability-broker.js");
const {
  ContainerHubClient,
  buildContainerHubRunSessionId
} = require("../dist-electron/main/assistant/container-hub.js");

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

async function waitForCondition(assertion, timeoutMs = 1000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError) {
    throw lastError;
  }
  return assertion();
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
      if (name === "home") {
        return root;
      }
      assert.equal(name, "userData");
      return root;
    }
  };
}

function writeAgentPlatformMinimaxProvider(root, { apiKey = "sk-secret", modelId = "demo-model" } = {}) {
  const registries = path.join(root, "Desktop", "zenmind-env", "registries");
  fs.mkdirSync(path.join(registries, "providers"), { recursive: true });
  fs.mkdirSync(path.join(registries, "models"), { recursive: true });
  fs.writeFileSync(
    path.join(registries, "providers", "minimax.yml"),
    [
      "key: minimax",
      "baseUrl: https://example.com",
      `apiKey: ${apiKey}`,
      "defaultModel: demo-model",
      "protocols:",
      "  OPENAI:",
      "    endpointPath: /v1/chat/completions",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(registries, "models", "demo-model.yml"),
    ["key: demo-model", "provider: minimax", "protocol: OPENAI", `modelId: ${modelId}`, ""].join("\n"),
    "utf8"
  );
}

function makePdfBuffer(text) {
  const escaped = String(text).replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
}

async function writeDocxFixture(filePath, text) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writePptxFixture(filePath, text) {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writeXlsxFixture(filePath, text) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["标题", "内容"]);
  sheet.addRow(["示例", text]);
  await workbook.xlsx.writeFile(filePath);
}

async function writeZipFixture(filePath, text) {
  const zip = new JSZip();
  zip.file("notes/readme.md", `# Readme\n${text}`);
  zip.file("nested/archive.zip", Buffer.from("nested zip skipped"));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

test("assistant settings never persists local api keys", (t) => {
  const root = makeTempRoot(t);
  const settings = saveAssistantSettingsToRoot(root, {
    baseURL: "https://example.com/v1/",
    model: "demo-model",
    apiKey: "sk-secret",
    voiceCorrectionEnabled: false
  });

  assert.equal(settings.configured, false);
  assert.equal(settings.apiKeyConfigured, false);
  assert.equal(Object.hasOwn(settings, "apiKey"), false);
  assert.equal(readAssistantSettingsFromRoot(root).apiKey, "");

  const publicSettings = getAssistantSettingsFromRoot(root);
  assert.deepEqual(publicSettings, settings);

  const stored = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
  assert.deepEqual(stored, { voiceCorrectionEnabled: false });
  assert.equal(JSON.stringify(stored).includes("sk-secret"), false);
});

test("assistant settings migrates legacy plaintext api keys out of local settings", (t) => {
  const root = makeTempRoot(t);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-legacy",
    voiceCorrectionEnabled: false
  }, null, 2));

  const privateSettings = readAssistantSettingsFromRoot(root);
  assert.equal(privateSettings.apiKey, "");
  assert.equal(privateSettings.baseURL, "");
  assert.equal(privateSettings.model, "");
  assert.equal(privateSettings.voiceCorrectionEnabled, false);

  const stored = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
  assert.deepEqual(stored, { voiceCorrectionEnabled: false });
  assert.equal(JSON.stringify(stored).includes("sk-legacy"), false);
});

test("assistant settings persist the voice correction toggle", (t) => {
  const root = makeTempRoot(t);

  const defaults = getAssistantSettingsFromRoot(root);
  assert.equal(defaults.voiceCorrectionEnabled, true);

  const updated = saveAssistantSettingsToRoot(root, {
    voiceCorrectionEnabled: false
  });
  assert.equal(updated.voiceCorrectionEnabled, false);
  assert.equal(readAssistantSettingsFromRoot(root).voiceCorrectionEnabled, false);
  assert.equal(getAssistantSettingsFromRoot(root).voiceCorrectionEnabled, false);
});

test("assistant image attachments allow a 10MB visual context budget", () => {
  const attachmentStore = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "attachment-store.ts"),
    "utf8"
  );
  const desktopTools = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "desktop-tools.ts"),
    "utf8"
  );

  assert.match(attachmentStore, /MAX_ATTACHMENT_IMAGE_CONTEXT_BYTES = 10 \* 1024 \* 1024/);
  assert.match(attachmentStore, /formatAttachmentSizeLimit\(MAX_ATTACHMENT_IMAGE_CONTEXT_BYTES\)/);
  assert.match(desktopTools, /MAX_DOCUMENT_IMAGE_CONTEXT_BYTES = 10 \* 1024 \* 1024/);
  assert.match(desktopTools, /formatDesktopSizeLimit\(MAX_DOCUMENT_IMAGE_CONTEXT_BYTES\)/);
  assert.doesNotMatch(attachmentStore, /超过 5MB/);
  assert.doesNotMatch(desktopTools, /超过 5MB/);
});

test("assistant chat store recovers from corrupt index chat and event files", (t) => {
  const root = makeTempRoot(t);
  const first = appendAssistantMessageToRoot(root, null, createAssistantMessage("user", "你好"));
  const chatId = first.summary.id;
  const chatsRoot = path.join(root, "chats");
  const indexPath = path.join(chatsRoot, "index.json");
  const chatPath = path.join(chatsRoot, chatId, "chat.json");
  const eventsPath = path.join(chatsRoot, chatId, "events.jsonl");

  fs.writeFileSync(indexPath, "{broken", "utf8");
  assert.deepEqual(listAssistantChatsFromRoot(root), []);
  assert.ok(fs.readdirSync(chatsRoot).some((fileName) => fileName.startsWith("index.json.corrupt-")));

  fs.writeFileSync(chatPath, "{broken", "utf8");
  assert.equal(getAssistantChatFromRoot(root, chatId), null);
  assert.ok(fs.readdirSync(path.dirname(chatPath)).some((fileName) => fileName.startsWith("chat.json.corrupt-")));

  appendAssistantEventToRoot(root, {
    id: "evt_good",
    seq: 1,
    runId: "run_1",
    chatId,
    type: "run.start",
    createdAt: new Date().toISOString()
  });
  fs.appendFileSync(eventsPath, "{broken\n", "utf8");
  assert.deepEqual(chatStoreInternals.readAssistantEventsFromRoot(root, chatId), []);
  assert.ok(fs.readdirSync(path.dirname(eventsPath)).some((fileName) => fileName.startsWith("events.jsonl.corrupt-")));
});

test("assistant attachment import reports progress and enforces total batch size", async (t) => {
  const root = makeTempRoot(t);
  const source = path.join(root, "notes.md");
  fs.writeFileSync(source, "# 标题\n附件正文", "utf8");
  const progress = [];
  const result = await createAssistantAttachmentsFromFiles(makeApp(root), null, [source], {
    taskId: "task_progress",
    useWorker: false,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.ok, true);
  assert.equal(result.taskId, "task_progress");
  assert.ok(progress.some((event) => event.phase === "copying"));
  assert.ok(progress.some((event) => event.phase === "extracting"));
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(progress.at(-1).done, true);

  const largePath = path.join(root, "large.bin");
  const fd = fs.openSync(largePath, "w");
  try {
    fs.ftruncateSync(fd, 65 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  const oversizedProgress = [];
  const oversized = await createAssistantAttachmentsFromFiles(makeApp(root), null, [largePath], {
    taskId: "task_large",
    useWorker: false,
    onProgress: (event) => oversizedProgress.push(event)
  });

  assert.equal(oversized.ok, false);
  assert.equal(oversized.attachments.length, 0);
  assert.match(oversized.message, /附件总大小超过 64MB/);
  assert.equal(oversizedProgress.at(-1).phase, "error");
  assert.equal(oversizedProgress.at(-1).done, true);
});

test("assistant memory store reads local side assistant memory", (t) => {
  const root = makeTempRoot(t);
  assert.equal(readAssistantMemoryFromRoot(root), "");

  saveAssistantMemoryToRoot(root, "用户偏好：先给结论。");

  assert.equal(
    getAssistantMemoryPathFromRoot(root),
    path.join(root, "assistant", "memory", "zenmind-memory.md")
  );
  assert.equal(readAssistantMemoryFromRoot(root), "用户偏好：先给结论。");
});

test("assistant memory storage exposes local file paths", (t) => {
  const root = makeTempRoot(t);
  const storage = getAssistantMemoryStorageFromRoot(root);

  assert.equal(storage.recordsPath, path.join(root, "assistant", "memory", "records.json"));
  assert.equal(storage.staticPath, path.join(root, "assistant", "memory", "zenmind-memory.md"));
  assert.equal(storage.auditPath, path.join(root, "assistant", "memory", "audit.jsonl"));
});

test("assistant runtime memory stores, merges, deletes, and reports stats", (t) => {
  const root = makeTempRoot(t);

  assert.deepEqual(listAssistantMemoryItemsFromRoot(root), []);
  assert.deepEqual(getAssistantMemorySettingsFromRoot(root), {
    enabled: true,
    autoLearn: true,
    maxItems: 5,
    maxChars: 4000
  });

  const first = upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "回答偏好",
    summary: "用户偏好：回答先给结论，再给行动项。",
    category: "preference",
    tags: ["reply"],
    importance: 9,
    confidence: 0.86
  }], {
    chatId: "chat_memory",
    runId: "run_memory"
  });
  assert.equal(first.stored.length, 1);
  assert.equal(first.skipped.length, 0);

  const duplicate = upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "回答偏好",
    summary: "用户偏好：回答先给结论，再给行动项。",
    category: "preference",
    tags: ["reply", "style"],
    importance: 7,
    confidence: 0.7
  }], {
    chatId: "chat_memory",
    runId: "run_memory_2"
  });
  assert.equal(duplicate.stored.length, 1);

  const items = listAssistantMemoryItemsFromRoot(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "fact");
  assert.equal(items[0].sourceChatId, "chat_memory");
  assert.equal(items[0].sourceRunId, "run_memory_2");
  assert.equal(items[0].tags.includes("style"), true);

  const stats = getAssistantMemoryStatsFromRoot(root);
  assert.equal(stats.total, 1);
  assert.equal(stats.factCount, 1);
  assert.equal(stats.observationCount, 0);
  assert.equal(typeof stats.lastLearnedAt, "string");

  assert.equal(deleteAssistantMemoryItemFromRoot(root, items[0].id).ok, true);
  assert.equal(listAssistantMemoryItemsFromRoot(root).length, 0);

  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "observation",
    title: "当前会话发现",
    summary: "这个问题和记忆召回相关。",
    category: "workflow",
    tags: ["memory"]
  }], {
    chatId: "chat_memory",
    runId: "run_memory_3"
  });
  assert.equal(clearAssistantMemoryItemsFromRoot(root).deletedCount, 1);
  assert.equal(listAssistantMemoryItemsFromRoot(root).length, 0);
});

test("assistant memory snapshot recalls only relevant runtime and legacy memories", (t) => {
  const root = makeTempRoot(t);
  saveAssistantMemoryToRoot(root, "# 静态规则\n回答要简洁。");
  upsertAssistantMemoryItemsFromRoot(root, [
    {
      kind: "fact",
      title: "回答偏好",
      summary: "用户偏好：回答先给结论，再给行动项。",
      category: "preference",
      tags: ["reply"],
      importance: 9
    },
    {
      kind: "observation",
      title: "部署观察",
      summary: "上次部署失败是因为 11949 端口被外部 agent-platform 占用。",
      category: "workflow",
      tags: ["deploy", "agent-platform"],
      importance: 8
    },
    {
      kind: "observation",
      title: "无关观察",
      summary: "天气查询页面加载过慢。",
      category: "general",
      tags: ["weather"],
      importance: 6
    }
  ], {
    chatId: "chat_previous",
    runId: "run_previous"
  });

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "之前 agent-platform 部署失败是什么原因？",
    chatId: "chat_current",
    maxItems: 5,
    maxChars: 4000
  });

  assert.match(snapshot.content, /<运行时记忆>/);
  assert.match(snapshot.content, /11949 端口/);
  assert.doesNotMatch(snapshot.content, /天气查询/);
  assert.doesNotMatch(snapshot.content, /回答要简洁/);
  assert.equal(snapshot.references.length, 1);
  assert.equal(snapshot.references.some((reference) => reference.id === "local-zenmind-memory"), false);
  assert.equal(snapshot.references.some((reference) => reference.title === "部署观察"), true);
});

test("assistant memory retrieval keeps unrelated chat memories out of prompts", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "饮食偏好-米饭",
    summary: "用户喜欢吃米饭，这是一个稳定的饮食偏好。应在菜谱推荐、饮食建议中优先考虑米饭相关内容。",
    category: "preference",
    tags: ["food", "rice", "meal"],
    importance: 9
  }], {
    chatId: "chat_same",
    runId: "run_food"
  });

  const sleepSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "我想睡觉",
    chatId: "chat_same",
    maxItems: 5,
    maxChars: 4000
  });
  assert.doesNotMatch(sleepSnapshot.content, /米饭/);
  assert.equal(sleepSnapshot.references.length, 0);

  const dinnerSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "今天晚饭吃什么？",
    chatId: "chat_same",
    maxItems: 5,
    maxChars: 4000
  });
  assert.match(dinnerSnapshot.content, /米饭/);
  assert.equal(dinnerSnapshot.references.length, 1);
  assert.equal(dinnerSnapshot.references[0].title, "饮食偏好-米饭");
});

test("assistant memory recall references include match reasons", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "回复偏好",
    summary: "用户偏好：回答先给结论，再给行动项。",
    category: "preference",
    tags: ["reply", "style"],
    importance: 9,
    confidence: 0.95
  }], {
    chatId: "chat_memory_reason",
    runId: "run_memory_reason"
  });

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "按我的偏好回复一下",
    chatId: "chat_memory_reason",
    maxItems: 5,
    maxChars: 4000
  });

  assert.equal(snapshot.references.length, 1);
  assert.equal(snapshot.references[0].title, "回复偏好");
  assert.match(snapshot.references[0].reason, /偏好|当前会话|关键词|回复风格/);
  assert.match(snapshot.content, /召回原因/);
});

test("assistant memory retrieval keeps non-food memories out of food preference recall", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [
    {
      kind: "fact",
      title: "饮食偏好-米饭",
      summary: "用户喜欢吃米饭，这是一个稳定的饮食偏好。",
      category: "preference",
      tags: ["food", "rice", "diet-preference"],
      importance: 9
    },
    {
      kind: "fact",
      title: "饮食偏好-葡萄",
      summary: "用户喜欢吃葡萄，这是用户当前明确表达的饮食偏好。",
      category: "preference",
      tags: ["food", "fruit", "diet-preference"],
      importance: 8
    },
    {
      kind: "observation",
      title: "容器仓库未启动导致定时任务失败",
      summary: "定时任务报错 dial tcp 127.0.0.1:11960 connection refused，原因是容器仓库服务未运行。",
      category: "bugfix",
      tags: ["容器仓库", "运行", "服务"],
      importance: 8
    },
    {
      kind: "fact",
      title: "王者荣耀游戏偏好",
      summary: "用户喜欢玩王者荣耀游戏。",
      category: "preference",
      tags: ["game", "play"],
      importance: 7
    }
  ], {
    chatId: "chat_food_precision",
    runId: "run_food_precision"
  });

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "我喜欢吃什么",
    chatId: "chat_food_precision",
    maxItems: 5,
    maxChars: 4000
  });

  assert.ok(snapshot.references.length >= 1);
  assert.equal(snapshot.references.some((reference) => /饮食偏好-/.test(reference.title)), true);
  assert.equal(snapshot.references.some((reference) => /容器仓库|王者荣耀/.test(reference.title)), false);
  assert.doesNotMatch(snapshot.content, /容器仓库|王者荣耀/);
});

test("assistant memory retrieval keeps non-response preferences out of reply-style recall", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [
    {
      kind: "fact",
      title: "回复偏好",
      summary: "用户偏好：回答先给结论，再给行动项。",
      category: "preference",
      tags: ["reply", "style"],
      importance: 9
    },
    {
      kind: "fact",
      title: "饮食偏好-米饭",
      summary: "用户喜欢吃米饭，这是一个稳定的饮食偏好。",
      category: "preference",
      tags: ["food", "rice"],
      importance: 8
    },
    {
      kind: "fact",
      title: "王者荣耀游戏偏好",
      summary: "用户喜欢玩王者荣耀游戏。",
      category: "preference",
      tags: ["game", "play"],
      importance: 7
    }
  ], {
    chatId: "chat_reply_precision",
    runId: "run_reply_precision"
  });

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "按我的偏好回复一下",
    chatId: "chat_reply_precision",
    maxItems: 5,
    maxChars: 4000
  });

  assert.equal(snapshot.references.length, 1);
  assert.equal(snapshot.references[0].title, "回复偏好");
  assert.doesNotMatch(snapshot.content, /米饭|王者荣耀/);
});

test("assistant memory retrieval only recalls current-session observations for process questions", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "observation",
    title: "当前会话排查过程",
    summary: "刚才确认过服务端口 11960 未启动，并准备重启容器仓库服务。",
    category: "bugfix",
    tags: ["端口", "服务", "排查"],
    importance: 8
  }], {
    chatId: "chat_current_process",
    runId: "run_current_process"
  });

  const genericSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "帮我写一段欢迎语",
    chatId: "chat_current_process",
    maxItems: 5,
    maxChars: 4000
  });
  assert.equal(genericSnapshot.content, "");
  assert.equal(genericSnapshot.references.length, 0);

  const processSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "刚才这个问题我们排查到哪一步了？",
    chatId: "chat_current_process",
    maxItems: 5,
    maxChars: 4000
  });
  assert.match(processSnapshot.content, /11960/);
  assert.match(processSnapshot.content, /<Current Session>/);
  assert.equal(processSnapshot.references.length, 1);
});

test("assistant memory retrieval allows cross-chat workflow recall without polluting preference queries", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "observation",
    title: "MCP mock 服务端口连接被拒",
    summary: "MCP mock 服务端口 11969 连接被拒，导致 initialize 同步失败。",
    category: "bugfix",
    tags: ["mcp", "mock", "11969"],
    importance: 8
  }], {
    chatId: "chat_old_mcp",
    runId: "run_old_mcp"
  });

  const preferenceSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "我喜欢吃什么",
    chatId: "chat_new_mcp",
    maxItems: 5,
    maxChars: 4000
  });
  assert.equal(preferenceSnapshot.references.length, 0);
  assert.doesNotMatch(preferenceSnapshot.content, /11969|MCP mock/);

  const workflowSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "之前 MCP mock 服务 initialize 失败是什么原因？",
    chatId: "chat_new_mcp",
    maxItems: 5,
    maxChars: 4000
  });
  assert.match(workflowSnapshot.content, /11969/);
  assert.match(workflowSnapshot.content, /<Relevant Observations>/);
  assert.equal(workflowSnapshot.references.length, 1);
});

test("assistant memory retrieval lazily normalizes legacy records for faceted recall", (t) => {
  const root = makeTempRoot(t);
  const now = new Date().toISOString();
  const storage = getAssistantMemoryStorageFromRoot(root);
  fs.mkdirSync(path.dirname(storage.recordsPath), { recursive: true });
  fs.writeFileSync(storage.recordsPath, `${JSON.stringify({
    items: [{
      id: "mem_legacy_food",
      kind: "fact",
      title: "饮食偏好-葡萄",
      summary: "用户喜欢吃葡萄，这是用户当前明确表达的饮食偏好。",
      category: "preference",
      tags: ["food", "diet-preference"],
      importance: 9,
      confidence: 0.95,
      status: "active",
      referenceCount: 0,
      createdAt: now,
      updatedAt: now
    }]
  }, null, 2)}\n`, "utf8");

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "我喜欢吃什么",
    chatId: "chat_legacy_food",
    maxItems: 5,
    maxChars: 4000
  });

  assert.match(snapshot.content, /葡萄/);
  assert.equal(snapshot.references.length, 1);
  const [item] = listAssistantMemoryItemsFromRoot(root);
  assert.equal(item.scopeType, "user");
  assert.equal(item.facet, "food_preference");
  assert.equal(item.subjectKey, "food:葡萄");
});

test("assistant memory recall audit records intent and layered selection counts", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "回复偏好",
    summary: "用户偏好：回答先给结论，再给行动项。",
    category: "preference",
    tags: ["reply", "style"],
    importance: 9
  }], {
    chatId: "chat_audit",
    runId: "run_audit"
  });

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "按我的偏好回复一下",
    chatId: "chat_audit",
    maxItems: 5,
    maxChars: 4000
  });
  assert.equal(snapshot.references.length, 1);

  const auditPath = getAssistantMemoryStorageFromRoot(root).auditPath;
  const lastAudit = fs.readFileSync(auditPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(lastAudit.operation, "recall");
  assert.equal(lastAudit.queryIntent, "response_style");
  assert.equal(lastAudit.candidateCountsByLayer.stable, 1);
  assert.equal(lastAudit.selectedCountsByLayer.stable, 1);
  assert.deepEqual(lastAudit.selectedIds, [snapshot.references[0].id]);
});

test("assistant memory upsert archives conflicting memories and skips low confidence candidates", (t) => {
  const root = makeTempRoot(t);
  const first = upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "回复偏好",
    summary: "用户偏好：回答先给结论。",
    category: "preference",
    tags: ["reply-style"],
    importance: 9,
    confidence: 0.9,
    reason: "用户明确表达的长期回复偏好。"
  }], {
    chatId: "chat_conflict",
    runId: "run_conflict_1"
  });
  assert.equal(first.stored.length, 1);

  const lowConfidence = upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "不确定偏好",
    summary: "用户可能喜欢非常长的回答。",
    category: "preference",
    tags: ["reply-style"],
    importance: 8,
    confidence: 0.42
  }], {
    chatId: "chat_conflict",
    runId: "run_conflict_low"
  });
  assert.equal(lowConfidence.stored.length, 0);
  assert.equal(lowConfidence.skipped[0].reason, "low_confidence");

  const conflict = upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "回复偏好",
    summary: "用户偏好：回答要详细展开，不需要先给结论。",
    category: "preference",
    tags: ["reply-style"],
    importance: 8,
    confidence: 0.88,
    reason: "用户更新了回复风格偏好。"
  }], {
    chatId: "chat_conflict",
    runId: "run_conflict_2"
  });
  assert.equal(conflict.stored.length, 1);

  const items = listAssistantMemoryItemsFromRoot(root);
  assert.equal(items.length, 2);
  assert.equal(items.filter((item) => item.status === "archived").length, 1);
  assert.equal(items.filter((item) => item.status === "active").length, 1);
  assert.match(items.find((item) => item.status === "active").summary, /详细展开/);
  assert.match(items.find((item) => item.status === "active").reason, /更新/);
});

test("assistant memory summary exposes directory-level control data without item bodies", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "回复偏好",
    summary: "用户偏好：回答先给结论。",
    category: "preference",
    confidence: 0.9
  }], {
    chatId: "chat_summary",
    runId: "run_summary"
  });

  const summary = getAssistantMemorySummaryFromRoot(root);
  assert.equal(summary.stats.total, 1);
  assert.equal(summary.directoryPath, path.join(root, "assistant", "memory"));
  assert.equal(summary.storage.recordsPath, path.join(root, "assistant", "memory", "records.json"));
  assert.equal(Object.hasOwn(summary, "items"), false);
  assert.equal(typeof summary.recentAudit?.operation, "string");
  assert.equal(Object.hasOwn(summary.recentAudit ?? {}, "summary"), false);
});

test("assistant memory retrieval ignores generic token overlap for food memories", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "饮食偏好-米饭",
    summary: "用户喜欢吃米饭，这是一个稳定的饮食偏好。应在菜谱推荐、饮食建议中优先考虑米饭相关的内容。",
    category: "preference",
    tags: ["饮食", "食物偏好", "主食"],
    importance: 9
  }], {
    chatId: "chat_search",
    runId: "run_food"
  });

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "在搜索框输入今日热点，然后搜索，然后我想把前三条的内容告诉我",
    chatId: "chat_search",
    maxItems: 5,
    maxChars: 4000
  });

  assert.equal(snapshot.content, "");
  assert.equal(snapshot.references.length, 0);
});

test("assistant memory retrieval ignores generic run/browser words for unrelated service memories", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "observation",
    title: "容器仓库未启动导致定时任务失败",
    summary: "定时任务报错 dial tcp 127.0.0.1:11960 connection refused，原因是容器仓库服务未运行。",
    category: "bugfix",
    tags: ["容器仓库", "运行", "服务"],
    importance: 8
  }], {
    chatId: "chat_service",
    runId: "run_service"
  });

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "你给我写个超级玛丽放在桌面上，并打开浏览器运行，我直接去玩。这个超级玛丽的 HTML 文件我要求用英文来写，例如超级玛丽.html。",
    chatId: "chat_game",
    maxItems: 5,
    maxChars: 4000
  });

  assert.equal(snapshot.content, "");
  assert.equal(snapshot.references.length, 0);
});

test("assistant memory retrieval ignores generic search summary workflow for concrete Google tasks", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "observation",
    title: "百度搜索并总结信息工作流",
    summary: "助手可以执行百度搜索任务：输入关键词搜索、读取结果页内容、提炼核心结论、关键事实和待办事项。",
    category: "workflow",
    tags: ["百度", "搜索", "总结", "工作流"],
    importance: 8
  }], {
    chatId: "chat_baidu_workflow",
    runId: "run_baidu_workflow"
  });

  const concreteGoogleTask = readAssistantMemorySnapshotFromRoot(root, {
    query: "帮我打开 Chrome，输入 Google，然后在谷歌里搜索抖音最热门的10首歌曲，并把搜索的结果总结一下发给我。",
    chatId: "chat_google_song",
    maxItems: 5,
    maxChars: 4000
  });
  assert.equal(concreteGoogleTask.content, "");
  assert.equal(concreteGoogleTask.references.length, 0);

  const explicitWorkflowQuestion = readAssistantMemorySnapshotFromRoot(root, {
    query: "百度搜索工作流怎么做？",
    chatId: "chat_google_song",
    maxItems: 5,
    maxChars: 4000
  });
  assert.match(explicitWorkflowQuestion.content, /百度搜索任务/);
  assert.equal(explicitWorkflowQuestion.references.length, 1);
});

test("assistant memory retrieval collapses semantically duplicate food memories", (t) => {
  const root = makeTempRoot(t);
  const now = new Date().toISOString();
  const storage = getAssistantMemoryStorageFromRoot(root);
  fs.mkdirSync(path.dirname(storage.recordsPath), { recursive: true });
  fs.writeFileSync(storage.recordsPath, `${JSON.stringify({
    items: [
      {
        id: "mem_food_a",
        kind: "fact",
        title: "饮食偏好-米饭",
        summary: "用户喜欢吃米饭，这是一个稳定的饮食偏好。应在菜谱推荐、饮食建议中优先考虑米饭相关内容。",
        category: "preference",
        tags: ["饮食", "主食"],
        importance: 9,
        confidence: 1,
        status: "active",
        referenceCount: 0,
        createdAt: now,
        updatedAt: now
      },
      {
        id: "mem_food_b",
        kind: "fact",
        title: "用户偏好米饭",
        summary: "用户喜欢吃米饭，这是稳定饮食偏好，可能需要在菜谱推荐或饮食建议中考虑。",
        category: "preference",
        tags: ["food", "rice", "diet-preference"],
        importance: 6,
        confidence: 1,
        status: "active",
        referenceCount: 0,
        createdAt: now,
        updatedAt: now
      }
    ]
  }, null, 2)}\n`, "utf8");

  const dinnerSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "今天晚饭吃什么？",
    chatId: "chat_food",
    maxItems: 5,
    maxChars: 4000
  });
  assert.match(dinnerSnapshot.content, /米饭/);
  assert.equal(dinnerSnapshot.references.length, 1);

  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "米饭偏好",
    summary: "用户喜欢吃米饭，做饮食建议时可以优先考虑米饭。",
    category: "preference",
    tags: ["rice"],
    importance: 8
  }]);
  assert.equal(listAssistantMemoryItemsFromRoot(root).length, 2);
});

test("assistant memory upsert replaces stale singular diet preference", (t) => {
  const root = makeTempRoot(t);
  upsertAssistantMemoryItemsFromRoot(root, [{
    kind: "fact",
    title: "饮食偏好-米饭",
    summary: "用户喜欢吃米饭，这是一个稳定的饮食偏好。应在菜谱推荐、饮食建议中优先考虑米饭相关内容。",
    category: "preference",
    tags: ["food", "rice", "diet-preference"],
    importance: 9,
    confidence: 0.95
  }], {
    chatId: "chat_diet_replace",
    runId: "run_diet_replace_1"
  });

  const direct = upsertExplicitUserMemoryFromRoot(root, "我喜欢吃地沟油", {
    chatId: "chat_diet_replace",
    runId: "run_diet_replace_2"
  });
  assert.equal(direct.stored.length, 1);
  assert.equal(direct.skipped.length, 0);

  const items = listAssistantMemoryItemsFromRoot(root);
  const active = items.filter((item) => item.status === "active");
  const archived = items.filter((item) => item.status === "archived");
  assert.equal(active.length, 1);
  assert.equal(archived.length, 1);
  assert.match(active[0].summary, /地沟油/);
  assert.doesNotMatch(active[0].summary, /米饭/);

  const snapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "请问我喜欢吃什么",
    chatId: "chat_diet_replace",
    maxItems: 5,
    maxChars: 4000
  });
  assert.equal(snapshot.references.length, 1);
  assert.match(snapshot.content, /地沟油/);
  assert.doesNotMatch(snapshot.content, /米饭/);
});

test("assistant memory retrieval filters legacy markdown by current question", (t) => {
  const root = makeTempRoot(t);
  saveAssistantMemoryToRoot(root, [
    "# 饮食偏好",
    "用户喜欢吃米饭，做饮食建议时可以优先考虑米饭。",
    "",
    "# 回复偏好",
    "用户喜欢回答先给结论。"
  ].join("\n"));

  const sleepSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "我想睡觉",
    chatId: "chat_sleep",
    maxItems: 5,
    maxChars: 4000
  });
  assert.equal(sleepSnapshot.content, "");
  assert.equal(sleepSnapshot.references.length, 0);

  const dinnerSnapshot = readAssistantMemorySnapshotFromRoot(root, {
    query: "今天晚饭吃什么？",
    chatId: "chat_food",
    maxItems: 5,
    maxChars: 4000
  });
  assert.match(dinnerSnapshot.content, /米饭/);
  assert.doesNotMatch(dinnerSnapshot.content, /先给结论/);
  assert.equal(dinnerSnapshot.references.length, 1);
  assert.equal(dinnerSnapshot.references[0].id, "local-zenmind-memory");
  assert.match(dinnerSnapshot.references[0].excerpt, /米饭/);
});

test("assistant runtime memory skips sensitive and do-not-remember candidates", (t) => {
  const root = makeTempRoot(t);
  const result = upsertAssistantMemoryItemsFromRoot(root, [
    {
      kind: "fact",
      title: "敏感信息",
      summary: "用户的 API key 是 sk-1234567890abcdef。"
    },
    {
      kind: "fact",
      title: "临时偏好",
      summary: "不要记住这条临时偏好。"
    },
    {
      kind: "fact",
      title: "可用偏好",
      summary: "用户偏好：回复先给结论。"
    }
  ], {
    chatId: "chat_safe",
    runId: "run_safe"
  });

  assert.equal(result.stored.length, 1);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(result.skipped.map((item) => item.reason).sort(), ["do_not_remember", "sensitive"]);
  assert.equal(listAssistantMemoryItemsFromRoot(root).length, 1);
});

test("assistant prompt truncates page context before model request", () => {
  const normalized = normalizePageContext({
    url: "https://example.com",
    title: "Example",
    selectedText: "s".repeat(9000),
    metaDescription: "meta",
    headings: ["h1"],
    bodyText: "b".repeat(45000),
    shellSidebarText: "导航".repeat(1000),
    leftRegionText: "左列".repeat(4000),
    modalText: "弹窗".repeat(4000)
  });

  assert.ok(normalized.selectedText.length < 8300);
  assert.ok(normalized.bodyText.length < 40350);
  assert.ok(normalized.shellSidebarText.length < 2200);
  assert.ok(normalized.leftRegionText.length < 6200);
  assert.ok(normalized.modalText.length < 12200);
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

test("assistant prompt asks for chat-friendly answer formatting", () => {
  assert.match(promptBuilderInternals.SYSTEM_PROMPT, /输出要适合聊天阅读/);
  assert.match(promptBuilderInternals.SYSTEM_PROMPT, /少用多级 Markdown 标题/);
  assert.match(promptBuilderInternals.SYSTEM_PROMPT, /只有在比较结构化数据时才使用表格/);
});

test("assistant prompt describes unified ZenMind capabilities without legacy runtime identity", () => {
  assert.match(promptBuilderInternals.SYSTEM_PROMPT, /你是 ZenMind/);
  assert.match(promptBuilderInternals.SYSTEM_PROMPT, /browser_\*/);
  assert.match(promptBuilderInternals.SYSTEM_PROMPT, /desktop_\*/);
  assert.match(promptBuilderInternals.SYSTEM_PROMPT, /agent-platform 的 minimax provider/);
  assert.doesNotMatch(promptBuilderInternals.SYSTEM_PROMPT, /desktop-xiaozhai/);
  assert.doesNotMatch(promptBuilderInternals.SYSTEM_PROMPT, /Zman/);
  assert.doesNotMatch(promptBuilderInternals.SYSTEM_PROMPT, /小宅/);
  assert.doesNotMatch(promptBuilderInternals.SYSTEM_PROMPT, /bash_sandbox|operator_mode_request|全权接管/);
});

test("assistant prompt injects local side assistant memory", () => {
  const messages = buildAssistantMessages({
    history: [],
    message: "按我的偏好整理一下",
    action: "chat",
    memory: "用户偏好：输出先给结论，再给行动项。"
  });

  assert.match(String(messages.at(-1).content), /<长期记忆>/);
  assert.match(String(messages.at(-1).content), /用户偏好：输出先给结论，再给行动项。/);
});

test("assistant capability broker routes browser operations outside sandbox", () => {
  const decision = routeAssistantToolRequest({
    toolName: "browser_click",
    args: { target: "启动" },
    platform: "darwin",
    permissionMode: "safe_default"
  });

  assert.equal(decision.kind, "browser");
  assert.equal(decision.routedToolName, "browser_click");
  assert.equal(decision.requiresSandbox, false);
  assert.equal(decision.requiresApproval, false);
  assert.equal(decision.denied, false);
});

test("assistant capability broker only allows registered host app launches", () => {
  const docker = routeAssistantToolRequest({
    toolName: "host_app_launch",
    args: { app: "Docker Desktop" },
    platform: "darwin",
    permissionMode: "safe_default"
  });
  assert.equal(docker.kind, "host_app");
  assert.equal(docker.routedToolName, "host_app_launch");
  assert.equal(docker.requiresApproval, true);
  assert.equal(docker.requiresSandbox, false);
  assert.equal(docker.denied, false);
  assert.equal(docker.args.appId, "docker-desktop");
  assert.equal(docker.args.command, "open -a \"Docker Desktop\"");

  const unknown = routeAssistantToolRequest({
    toolName: "host_app_launch",
    args: { app: "Unknown App" },
    platform: "darwin",
    permissionMode: "safe_default"
  });
  assert.equal(unknown.denied, true);
  assert.match(unknown.message, /白名单/);

  const claude = routeAssistantToolRequest({
    toolName: "host_app_launch",
    args: { app_name_or_path: "claude" },
    platform: "darwin",
    permissionMode: "safe_default"
  });
  assert.equal(claude.kind, "host_app");
  assert.equal(claude.routedToolName, "host_app_launch");
  assert.equal(claude.requiresApproval, true);
  assert.equal(claude.requiresSandbox, false);
  assert.equal(claude.denied, false);
  assert.equal(claude.args.appId, "claude-code");
  assert.equal(claude.args.command, "open -a \"Claude\"");

  const trustedDocker = routeAssistantToolRequest({
    toolName: "host_app_launch",
    args: { app: "Docker Desktop" },
    platform: "darwin",
    permissionMode: "full_access"
  });
  assert.equal(trustedDocker.kind, "host_app");
  assert.equal(trustedDocker.requiresApproval, false);
});

test("assistant capability broker routes shell commands to confirmed host execution instead of sandbox", () => {
  const install = routeAssistantToolRequest({
    toolName: "bash",
    args: { command: "npm install" },
    platform: "darwin",
    permissionMode: "safe_default"
  });
  assert.equal(install.kind, "host_command");
  assert.equal(install.routedToolName, "bash");
  assert.equal(install.requiresSandbox, false);
  assert.equal(install.requiresApproval, true);

  const trusted = routeAssistantToolRequest({
    toolName: "bash",
    args: { command: "npm test" },
    platform: "darwin",
    permissionMode: "operator",
    operatorActive: true
  });
  assert.equal(trusted.kind, "host_command");
  assert.equal(trusted.routedToolName, "bash");
  assert.equal(trusted.requiresSandbox, false);
  assert.equal(trusted.requiresApproval, false);

  const fullAccess = routeAssistantToolRequest({
    toolName: "bash",
    args: { command: "docker info" },
    platform: "darwin",
    permissionMode: "full_access"
  });
  assert.equal(fullAccess.kind, "host_command");
  assert.equal(fullAccess.routedToolName, "bash");
  assert.equal(fullAccess.requiresApproval, false);

  const docker = routeAssistantToolRequest({
    toolName: "bash_sandbox",
    args: { command: "open -a Docker" },
    platform: "darwin",
    permissionMode: "safe_default"
  });
  assert.equal(docker.kind, "host_app");
  assert.equal(docker.routedToolName, "host_app_launch");
  assert.equal(docker.args.appId, "docker-desktop");
  assert.equal(docker.requiresApproval, true);
});

test("assistant capability broker marks destructive file and operator actions as confirmed session capabilities", () => {
  const remove = routeAssistantToolRequest({
    toolName: "desktop_delete_files",
    args: { paths: ["old.txt"] },
    platform: "darwin",
    permissionMode: "safe_default"
  });
  assert.equal(remove.kind, "file_operation");
  assert.equal(remove.operation, "delete");
  assert.equal(remove.requiresApproval, true);
  assert.equal(remove.riskLevel, "high");

  const trustedRemove = routeAssistantToolRequest({
    toolName: "desktop_delete_files",
    args: { paths: ["old.txt"] },
    platform: "darwin",
    permissionMode: "full_access"
  });
  assert.equal(trustedRemove.kind, "file_operation");
  assert.equal(trustedRemove.requiresApproval, false);

  const grant = capabilityBrokerInternals.createOperatorModeGrant({
    chatId: "chat_1",
    requestedMinutes: 90,
    now: 1000
  });
  assert.equal(grant.chatId, "chat_1");
  assert.equal(grant.durationMs, 15 * 60 * 1000);
  assert.equal(grant.expiresAt, 1000 + 15 * 60 * 1000);
});

test("host startup tools remove macOS user LaunchAgents only after verification", (t) => {
  const root = makeTempRoot(t);
  const userLaunchAgentsDir = path.join(root, "Library", "LaunchAgents");
  const systemLaunchDaemonsDir = path.join(root, "system", "LaunchDaemons");
  fs.mkdirSync(userLaunchAgentsDir, { recursive: true });
  fs.mkdirSync(systemLaunchDaemonsDir, { recursive: true });
  fs.writeFileSync(path.join(userLaunchAgentsDir, "com.example.minimax.plist"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist><dict>",
    "<key>Label</key><string>MiniMax Agent</string>",
    "<key>ProgramArguments</key><array><string>/Applications/MiniMax Agent.app</string></array>",
    "</dict></plist>"
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(systemLaunchDaemonsDir, "com.example.claude.plist"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist><dict>",
    "<key>Label</key><string>Claude Island</string>",
    "</dict></plist>"
  ].join("\n"), "utf8");

  const app = makeApp(root);
  const list = listHostStartupItems(app, {
    platform: "darwin",
    homeDir: root,
    macUserLaunchAgentsDir: userLaunchAgentsDir,
    macSystemLaunchDaemonsDir: systemLaunchDaemonsDir,
    macSystemLaunchAgentsDir: path.join(root, "system", "LaunchAgents"),
    execFileSync() {
      return "";
    }
  });
  assert.equal(list.ok, true);
  assert.deepEqual(list.items.map((item) => item.name).sort(), ["Claude Island", "MiniMax Agent"]);

  const result = removeHostStartupItems(app, {
    targets: ["MiniMax Agent", "Claude Island"]
  }, {
    platform: "darwin",
    homeDir: root,
    macUserLaunchAgentsDir: userLaunchAgentsDir,
    macSystemLaunchDaemonsDir: systemLaunchDaemonsDir,
    macSystemLaunchAgentsDir: path.join(root, "system", "LaunchAgents"),
    execFileSync() {
      return "";
    }
  });

  assert.deepEqual(result.removed.map((item) => item.name), ["MiniMax Agent"]);
  assert.deepEqual(result.failed.map((item) => item.target), ["Claude Island"]);
  assert.match(result.failed[0].reason, /管理员权限|系统级/);
  assert.equal(fs.existsSync(path.join(userLaunchAgentsDir, "com.example.minimax.plist")), false);
  assert.equal(fs.existsSync(path.join(systemLaunchDaemonsDir, "com.example.claude.plist")), true);
  assert.deepEqual(result.remaining.map((item) => item.name), ["Claude Island"]);
});

test("host startup tools remove Windows HKCU Run entries and refuse HKLM without admin", (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const deleted = [];
  const env = {
    platform: "win32",
    homeDir: root,
    windowsUserStartupDir: path.join(root, "Startup"),
    windowsCommonStartupDir: path.join(root, "CommonStartup"),
    windowsRegistryProvider: () => ({
      hkcuRun: deleted.includes("HKCU:MiniMax Agent")
        ? []
        : [{ name: "MiniMax Agent", command: "\"C:\\Program Files\\MiniMax\\agent.exe\"" }],
      hklmRun: [{ name: "Claude Island", command: "\"C:\\Program Files\\Claude Island\\claude.exe\"" }]
    }),
    deleteWindowsRegistryValue(hive, name) {
      deleted.push(`${hive}:${name}`);
    }
  };

  const result = removeHostStartupItems(app, {
    targets: ["MiniMax Agent", "Claude Island"]
  }, env);

  assert.deepEqual(deleted, ["HKCU:MiniMax Agent"]);
  assert.deepEqual(result.removed.map((item) => item.name), ["MiniMax Agent"]);
  assert.deepEqual(result.failed.map((item) => item.target), ["Claude Island"]);
  assert.match(result.failed[0].reason, /管理员权限|HKLM/);
  assert.deepEqual(result.remaining.map((item) => item.name), ["Claude Island"]);
});

test("assistant runtime emits local memory references when memory is injected", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });
  saveAssistantMemoryToRoot(root, [
    "# 用户偏好",
    "输出先给结论，再给行动项。"
  ].join("\n"));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    const transcript = JSON.stringify(payload.messages);
    assert.match(transcript, /<长期记忆>/);
    assert.match(transcript, /输出先给结论/);
    return new Response('data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
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
    message: "按我的偏好回复",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  const memoryEvent = events.find((event) => event.type === "memory.reference");
  assert.equal(memoryEvent?.status, "ok");
  assert.equal(memoryEvent?.data.references.length, 1);
  assert.equal(memoryEvent.data.references[0].path, path.join("assistant", "memory", "zenmind-memory.md"));
  assert.equal(memoryEvent.data.references[0].lineStart, 1);
  assert.equal(memoryEvent.data.references[0].lineEnd, 2);
  assert.match(memoryEvent.data.references[0].excerpt, /输出先给结论/);
});

test("assistant runtime silently learns local memory after successful runs", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    if (payload.stream === false) {
      const transcript = JSON.stringify(payload.messages);
      assert.match(transcript, /用户消息/);
      assert.match(transcript, /助手回复/);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              memories: [{
                kind: "fact",
                title: "回答偏好",
                summary: "用户偏好：回答先给结论，再给行动项。",
                category: "preference",
                tags: ["reply"],
                importance: 9,
                confidence: 0.9
              }]
            })
          }
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response('data: {"choices":[{"delta":{"content":"我会先给结论。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
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
    message: "我喜欢回答先给结论",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;
  assert.equal(events.some((event) => event.type === "run.complete"), true);

  const learned = await waitForCondition(() => {
    const items = listAssistantMemoryItemsFromRoot(root);
    assert.equal(items.length, 1);
    return items;
  });
  assert.equal(learned[0].kind, "fact");
  assert.equal(learned[0].category, "preference");
  assert.match(learned[0].summary, /先给结论/);
});

test("assistant runtime completes chat before background auto-learn finishes", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let resolveLearningFetch;
  const learningFetchDone = new Promise((resolve) => {
    resolveLearningFetch = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    if (payload.stream === false) {
      await learningFetchDone;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              memories: [{
                kind: "fact",
                title: "回答偏好",
                summary: "用户偏好：回答先给结论。",
                category: "preference",
                confidence: 0.9,
                importance: 8
              }]
            })
          }
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response('data: {"choices":[{"delta":{"content":"好的，记住了。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
  });
  const start = runtime.startRun({
    message: "以后回答请先给结论",
    action: "chat"
  });
  assert.equal(start.ok, true);

  await waitForCondition(() => {
    assert.equal(events.some((event) => event.runId === start.runId && event.type === "run.complete"), true);
    assert.equal(events.some((event) => event.runId === start.runId && event.type === "done"), true);
  });

  resolveLearningFetch();
  const backgroundStored = await waitForCondition(() => {
    const completion = events.find((event) => event.runId === start.runId && event.type === "run.complete");
    const memoryStored = events.find((event) => event.runId === start.runId && event.type === "memory.stored");
    assert.ok(completion);
    assert.ok(memoryStored);
    assert.ok((memoryStored.seq ?? 0) > (completion.seq ?? 0));
    return memoryStored;
  });
  assert.match(JSON.stringify(backgroundStored.data), /回答偏好/);
});

test("assistant runtime recalls explicit food preference in later chat turns", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    if (payload.stream === false) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({ memories: [] })
          }
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const transcript = JSON.stringify(payload.messages);
    if (/我喜欢吃什么/.test(transcript)) {
      assert.match(transcript, /<运行时记忆>/);
      assert.match(transcript, /饮食偏好-米饭/);
    }
    return new Response('data: {"choices":[{"delta":{"content":"知道了。"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
  });

  const first = runtime.startRun({
    message: "我喜欢吃米饭",
    action: "chat"
  });
  assert.equal(first.ok, true);
  await waitForCondition(() => {
    assert.equal(events.some((event) => event.runId === first.runId && isTerminalEvent(event)), true);
  });
  assert.equal(listAssistantMemoryItemsFromRoot(root).some((item) => item.title === "饮食偏好-米饭"), true);

  const second = runtime.startRun({
    chatId: first.chatId,
    message: "我喜欢吃什么",
    action: "chat"
  });
  assert.equal(second.ok, true);
  await waitForCondition(() => {
    assert.equal(events.some((event) => event.runId === second.runId && isTerminalEvent(event)), true);
  });

  const memoryEvent = events.find((event) => event.runId === second.runId && event.type === "memory.reference");
  assert.equal(memoryEvent?.status, "ok");
  assert.equal(memoryEvent?.data.references.some((reference) => reference.title === "饮食偏好-米饭"), true);
});

test("assistant memory UI renders recent memory previews without delete controls", () => {
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const settingsPageSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );
  const assistantDockSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx"),
    "utf8"
  );

  assert.match(settingsPageSource, /最近记忆/);
  assert.match(settingsPageSource, /assistant\.listMemoryItems\(\)/);
  assert.match(settingsPageSource, /formatMemoryPreview/);
  assert.doesNotMatch(settingsPageSource, /deleteMemoryItem/);
  assert.match(settingsPageSource, /recordsPath/);
  assert.match(settingsPageSource, /auditPath/);
  assert.match(assistantDockSource, /<p>\{reference\.excerpt\}<\/p>/);
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
  assert.doesNotMatch(messages.at(-1).content, /左侧浏览器目标：未检测到可操作浏览器目标/);
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

test("assistant prompt keeps attachment-only chat away from incidental page context", () => {
  const messages = buildAssistantMessages({
    history: [],
    message: "解析一下",
    action: "chat",
    pageContext: {
      url: "https://example.com/control",
      title: "ZenMind 控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["服务状态"],
      bodyText: "ZenMind 控制中心运行状态和服务列表。"
    },
    attachments: [
      {
        id: "att_pdf",
        name: "法规考点.pdf",
        mimeType: "application/pdf",
        sizeBytes: 170957,
        text: "PDF 附件正文内容",
        document: {
          format: "pdf",
          readStatus: "readable",
          extractedChars: 9,
          truncated: false
        }
      }
    ]
  });
  const content = String(messages.at(-1).content);
  assert.match(content, /附件上下文/);
  assert.match(content, /PDF 附件正文内容/);
  assert.doesNotMatch(content, /当前页面上下文/);
  assert.doesNotMatch(content, /ZenMind 控制中心/);
});

test("assistant prompt keeps page context when attachment chat explicitly asks for the current page", () => {
  const messages = buildAssistantMessages({
    history: [],
    message: "请结合附件和当前页面总结一下",
    action: "chat",
    pageContext: {
      url: "https://example.com/control",
      title: "ZenMind 控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["服务状态"],
      bodyText: "ZenMind 控制中心运行状态和服务列表。"
    },
    attachments: [
      {
        id: "att_pdf",
        name: "法规考点.pdf",
        mimeType: "application/pdf",
        sizeBytes: 170957,
        text: "PDF 附件正文内容",
        document: {
          format: "pdf",
          readStatus: "readable",
          extractedChars: 9,
          truncated: false
        }
      }
    ]
  });
  const content = String(messages.at(-1).content);
  assert.match(content, /附件上下文/);
  assert.match(content, /当前页面上下文/);
  assert.match(content, /ZenMind 控制中心/);
});

test("assistant prompt includes structured native left regions and modal content", () => {
  const messages = buildAssistantMessages({
    history: [],
    message: "左侧区域有什么，弹窗里有什么？",
    action: "chat",
    pageContext: {
      url: "app://zenmind/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心", "容器仓库"],
      bodyText: "右侧详情展示容器仓库配置。",
      shellSidebarText: "智能助理 控制中心 百度 国小君 插件市场 帮助 设置",
      leftRegionText: "控制中心 4 个核心服务 容器仓库 智能体平台 智能助理 认证服务 插件市场 3 个插件",
      modalText: "容器仓库 · 日志文件 输入关键词 检索范围 已加载内容 已到日志开头"
    }
  });
  const content = String(messages.at(-1).content);
  assert.match(content, /前台弹层\/模态框内容/);
  assert.match(content, /容器仓库 · 日志文件/);
  assert.match(content, /应用左导航/);
  assert.match(content, /智能助理 控制中心 百度/);
  assert.match(content, /当前页面左侧区域/);
  assert.match(content, /容器仓库 智能体平台 智能助理/);
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

test("assistant vision provider sends base64 images to MiniMax VLM endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody = null;
  globalThis.fetch = async (url, init) => {
    requestedUrl = String(url);
    requestedBody = JSON.parse(String(init.body));
    assert.equal(init.method, "POST");
    assert.match(init.headers.authorization, /^Bearer sk-/);
    return new Response(JSON.stringify({
      base_resp: { status_code: 0 },
      content: "左边是红色，右边是蓝色。"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const settings = {
      baseURL: "https://api.minimaxi.com/v1/chat/completions",
      model: "MiniMax-M2.7",
      apiKey: "sk-test"
    };
    const dataUrl = "data:image/png;base64,AAECAwQ=";
    assert.equal(canDescribeImageWithVision(settings, dataUrl), true);
    const result = await describeImageWithVision({
      settings,
      name: "red-blue.png",
      dataUrl,
      signal: new AbortController().signal
    });

    assert.equal(requestedUrl, "https://api.minimaxi.com/v1/coding_plan/vlm");
    assert.equal(requestedBody.image_url, dataUrl);
    assert.match(requestedBody.prompt, /附件名称：red-blue\.png/);
    assert.equal(result.summary, "左边是红色，右边是蓝色。");
    assert.equal(result.provider, "minimax-vlm");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assistant vision provider converts gif images before MiniMax VLM requests", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody = null;
  globalThis.fetch = async (_url, init) => {
    requestedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      base_resp: { status_code: 0 },
      content: "GIF 第一帧是 1x1 图片。"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const settings = {
      baseURL: "https://api.minimaxi.com/v1/chat/completions",
      model: "MiniMax-M2.7",
      apiKey: "sk-test"
    };
    const gifDataUrl = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    assert.equal(canDescribeImageWithVision(settings, gifDataUrl), true);
    await describeImageWithVision({
      settings,
      name: "one-pixel.gif",
      dataUrl: gifDataUrl,
      signal: new AbortController().signal
    });
    assert.match(requestedBody.image_url, /^data:image\/png;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assistant package excludes removed browser agent dependencies and bridge build", () => {
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const removedPackageScope = "@page" + "-agent";
  const removedBridgeScript = "build:" + "page" + "-agent-bridge";

  assert.equal(Object.hasOwn(manifest.scripts || {}, removedBridgeScript), false);
  assert.equal(String(manifest.scripts?.["build:main"] || "").includes(removedBridgeScript), false);
  for (const dependencyName of Object.keys(manifest.dependencies || {})) {
    assert.equal(dependencyName.startsWith(removedPackageScope), false);
  }
});

test("browser runtime reports insufficient built-in extraction without agent fallback", async () => {
  const calls = [];
  const contexts = [
    {
      url: "https://www.google.com/search?q=zenmind",
      title: "zenmind - Google Search",
      selectedText: "",
      metaDescription: "",
      headings: ["News"],
      bodyText: "News\nRelated searches",
      browserTarget: {
        kind: "webview",
        webContentsId: 42
      }
    },
    {
      url: "https://www.google.com/search?q=zenmind",
      title: "zenmind - Google Search",
      selectedText: "",
      metaDescription: "",
      headings: ["News", "ZenMind 产品介绍"],
      bodyText: "News\nZenMind 产品介绍\nRelated searches",
      browserTarget: {
        kind: "webview",
        webContentsId: 42
      }
    }
  ];
  const runtime = new BrowserRuntime({
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "Search"
      };
    },
    async waitForPageSettle(webContentsId, timeoutMs) {
      calls.push(["waitForPageSettle", webContentsId, timeoutMs]);
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return contexts.shift() || contexts.at(-1);
    }
  });

  const result = await runtime.executeSearchExtraction(42, {
    task: "搜索 zenmind 并读取前3条标题",
    query: "zenmind",
    extraction: {
      count: 3,
      itemLabel: "标题"
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "insufficient_items");
  assert.match(result.message || "", /只读取到 1 条标题/);
  assert.deepEqual(calls, [
    ["waitForPageSettle", 42, 5000],
    ["fillBestInputAndSubmit", 42, "zenmind"],
    ["waitForPageSettle", 42, 1500],
    ["readPageContext", 42],
    ["waitForPageSettle", 42, 1200],
    ["readPageContext", 42]
  ]);
  assert.equal(result.data.verification.requestedCount, 3);
  assert.equal(result.data.verification.extractedCount, 1);
  assert.equal(result.data.verification.enoughItems, false);
  assert.equal(result.data.verification.attempts, 2);
  assert.equal(Object.hasOwn(result.data, "fallbackResult"), false);
});

test("browser runtime retries transient execution-context errors during search", async () => {
  const calls = [];
  let fillAttempts = 0;
  let readAttempts = 0;
  const runtime = new BrowserRuntime({
    async waitForPageSettle(webContentsId, timeoutMs) {
      calls.push(["waitForPageSettle", webContentsId, timeoutMs]);
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      fillAttempts += 1;
      calls.push(["fillBestInputAndSubmit", webContentsId, value, fillAttempts]);
      if (fillAttempts < 3) {
        throw new Error(fillAttempts === 1
          ? "Cannot find default execution context"
          : "Execution context was destroyed.");
      }
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      readAttempts += 1;
      calls.push(["readPageContext", webContentsId, readAttempts]);
      if (readAttempts === 1) {
        throw new Error("Cannot find default execution context");
      }
      return {
        url: "https://www.google.com/search?q=song",
        title: "song - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: ["歌曲一", "歌曲二", "歌曲三"],
        bodyText: "歌曲一\n歌曲二\n歌曲三",
        browserTarget: {
          kind: "webview",
          webContentsId
        }
      };
    }
  });
  const progress = [];

  const result = await runtime.executeSearchExtraction(77, {
    task: "搜索歌曲并读取前三条",
    query: "热门歌曲",
    extraction: {
      count: 3,
      itemLabel: "歌曲"
    }
  }, {
    onEvent(event) {
      progress.push(event);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(fillAttempts, 3);
  assert.equal(readAttempts, 2);
  assert.match(result.message || "", /前 3 条歌曲/);
  assert.ok(progress.some((event) => /上下文|重试|导航/u.test(event.message || "")));
  assert.equal(calls.some((call) => call[0] === "fillBestInputAndSubmit"), true);
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
  assert.deepEqual(extractBrowserInputIntent("请在百度里面输入美国人，搜索后，把前三条记录发给我"), {
    action: "input",
    value: "美国人",
    submit: true,
    summarizeAfterSubmit: true,
    extraction: {
      count: 3,
      itemLabel: "记录"
    }
  });
  assert.deepEqual(extractBrowserInputIntent("Google 搜美国人，查完以后发前3个结果给我"), {
    action: "input",
    value: "美国人",
    submit: true,
    summarizeAfterSubmit: true,
    extraction: {
      count: 3,
      itemLabel: "结果"
    }
  });
  assert.equal(extractBrowserInputIntent("根据搜索结果的前3条总结一下，发给我"), null);
  assert.equal(extractBrowserInputIntent("把当前搜索结果前三条总结一下"), null);
  assert.equal(extractBrowserInputIntent("请帮我填写好右侧的表单，不用提交，信息随便填"), null);
});

test("assistant browser task intent separates URLs, search results, hot search, and service control", () => {
  assert.deepEqual(extractBrowserTaskIntent("打开一个新 tab，在 URL 输入 www.baidu.com"), {
    kind: "open_url",
    url: "https://www.baidu.com/",
    label: "www.baidu.com",
    newTab: true
  });
  assert.deepEqual(extractBrowserTaskIntent("在百度搜索张雪机车手退赛，把搜索结果前10条标题发给我"), {
    kind: "compound",
    website: {
      label: "百度",
      url: "https://www.baidu.com/"
    },
    query: "张雪机车手退赛",
    extraction: {
      kind: "search_results",
      count: 10,
      itemLabel: "标题"
    }
  });
  assert.deepEqual(extractBrowserTaskIntent("帮我打开google,然后搜索抖音热门歌曲，然后把搜索的结果最热门的10条返回给我"), {
    kind: "compound",
    website: {
      label: "谷歌",
      url: "https://www.google.com/"
    },
    query: "抖音热门歌曲",
    extraction: {
      kind: "search_results",
      count: 10,
      itemLabel: "歌曲"
    }
  });
  assert.deepEqual(extractBrowserTaskIntent("帮我打开 Chrome，输入 Google，然后在谷歌里搜索抖音最热门的10首歌曲，并总结发给我"), {
    kind: "compound",
    website: {
      label: "谷歌",
      url: "https://www.google.com/"
    },
    query: "抖音最热门的10首歌曲",
    extraction: {
      kind: "search_results",
      count: 10,
      itemLabel: "歌曲"
    }
  });
  for (const message of [
    "在谷歌里搜索抖音最热门的10首歌并发给我",
    "在谷歌里搜索抖音前十首热门歌并发给我",
    "在谷歌里搜索抖音10个热门歌曲并发给我"
  ]) {
    assert.equal(extractBrowserTaskIntent(message)?.extraction?.count, 10);
    assert.equal(extractBrowserTaskIntent(message)?.extraction?.itemLabel, "歌曲");
  }
  assert.deepEqual(extractBrowserTaskIntent("把百度热搜前10条发给我"), {
    kind: "compound",
    website: {
      label: "百度",
      url: "https://www.baidu.com/"
    },
    extraction: {
      kind: "hot_search",
      count: 10,
      itemLabel: "热搜"
    }
  });
  assert.deepEqual(extractBrowserTaskIntent("帮我把容器仓库启动起来"), {
    kind: "service_control",
    serviceId: "agent-container-hub",
    operation: "start"
  });
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

test("assistant agent-platform public settings preserve local voice correction preference", (t) => {
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
    path.join(registries, "providers", "openai.yml"),
    [
      "key: openai",
      "baseUrl: https://api.openai.com",
      "apiKey: sk-provider",
      "defaultModel: gpt-4o",
      "protocols:",
      "  OPENAI:",
      "    endpointPath: /v1/chat/completions",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(registries, "models", "gpt-4o.yml"),
    ["key: gpt-4o", "provider: openai", "protocol: OPENAI", "modelId: gpt-4o", ""].join("\n"),
    "utf8"
  );
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    voiceCorrectionEnabled: false
  });

  const settings = getAgentPlatformSettingsPublic(makeApp(root));
  assert.equal(settings.source, "agent-platform");
  assert.equal(settings.voiceCorrectionEnabled, false);
  assert.equal(settings.configured, true);
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

test("assistant reads provider env from the installed agent-platform service directory", (t) => {
  const root = makeTempRoot(t);
  const registries = path.join(root, ".zenmind", "registries");
  fs.mkdirSync(path.join(root, "services", "agent-platform", "1.0.0"), { recursive: true });
  fs.mkdirSync(path.join(registries, "providers"), { recursive: true });
  fs.mkdirSync(path.join(registries, "models"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "services", "agent-platform", "1.0.0", ".env"),
    `REGISTRIES_DIR=${registries}\nPROVIDER_APIKEY_KEY_PART=0.1.0\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(registries, "providers", "minimax.yml"),
    [
      "key: minimax",
      "baseUrl: https://api.minimaxi.com",
      `apiKey: ${encryptProviderAPIKey("0.1.0", "sk-installed-service")}`,
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
  assert.equal(settings.apiKey, "sk-installed-service");
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

test("assistant voice ASR ignores placeholder provider keys", (t) => {
  const root = makeTempRoot(t);
  const registries = path.join(root, ".zenmind", "registries");
  fs.mkdirSync(path.join(registries, "providers"), { recursive: true });
  fs.writeFileSync(
    path.join(registries, "providers", "bailian.yml"),
    [
      "key: bailian",
      "baseUrl: https://dashscope.aliyuncs.com/compatible-mode",
      "apiKey: your-bailian-api-key",
      "defaultModel: qwen3.5-plus",
      ""
    ].join("\n"),
    "utf8"
  );

  assert.equal(loadAgentPlatformVoiceAsrSettings(makeApp(root)), null);
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

test("assistant falls back to the default provider key part when env is missing", (t) => {
  const root = makeTempRoot(t);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Desktop", "minimax.yml"),
    [
      "key: minimax",
      "baseUrl: https://api.minimaxi.com",
      `apiKey: ${encryptProviderAPIKey("0.1.0", "sk-default-key-part")}`,
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
  assert.equal(settings.apiKey, "sk-default-key-part");
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

test("assistant attachment store saves files under chat id directory", async (t) => {
  const root = makeTempRoot(t);
  const source = path.join(root, "source.md");
  fs.writeFileSync(source, "# 标题\n附件正文", "utf8");

  const result = await createAssistantAttachmentsFromFiles(makeApp(root), null, [source]);
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

test("assistant chat history restores legacy stored attachments on read", async (t) => {
  const root = makeTempRoot(t);
  const source = path.join(root, "legacy-source.md");
  fs.writeFileSync(source, "旧附件正文", "utf8");

  const result = await createAssistantAttachmentsFromFiles(makeApp(root), null, [source]);
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

test("assistant attachment store extracts common documents and keeps images as visual context", async (t) => {
  const root = makeTempRoot(t);
  const sourceDir = path.join(root, "sources");
  fs.mkdirSync(sourceDir, { recursive: true });
  const pdfPath = path.join(sourceDir, "report.pdf");
  const docxPath = path.join(sourceDir, "report.docx");
  const xlsxPath = path.join(sourceDir, "table.xlsx");
  const pptxPath = path.join(sourceDir, "slides.pptx");
  const zipPath = path.join(sourceDir, "bundle.zip");
  const imagePath = path.join(sourceDir, "image.png");
  fs.writeFileSync(pdfPath, makePdfBuffer("PDF 附件正文内容"));
  await writeDocxFixture(docxPath, "Word 附件正文内容");
  await writeXlsxFixture(xlsxPath, "Excel 附件正文内容");
  await writePptxFixture(pptxPath, "PPT 附件正文内容");
  await writeZipFixture(zipPath, "ZIP 附件正文内容");
  fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));

  const result = await createAssistantAttachmentsFromFiles(makeApp(root), null, [
    pdfPath,
    docxPath,
    xlsxPath,
    pptxPath,
    zipPath,
    imagePath
  ]);
  assert.equal(result.ok, true);
  assert.match(result.message, /已解析/);

  const byName = new Map(result.attachments.map((attachment) => [attachment.name, attachment]));
  assert.match(byName.get("report.pdf").text, /PDF 附件正文内容/);
  assert.equal(byName.get("report.pdf").document.format, "pdf");
  assert.equal(byName.get("report.pdf").document.readStatus, "readable");
  assert.match(byName.get("report.docx").text, /Word 附件正文内容/);
  assert.equal(byName.get("report.docx").document.format, "docx");
  assert.match(byName.get("table.xlsx").text, /Excel 附件正文内容/);
  assert.deepEqual(byName.get("table.xlsx").document.sheetNames, ["Data"]);
  assert.match(byName.get("slides.pptx").text, /PPT 附件正文内容/);
  assert.equal(byName.get("slides.pptx").document.slideCount, 1);
  assert.match(byName.get("bundle.zip").text, /ZIP 附件正文内容/);
  assert.equal(byName.get("bundle.zip").document.format, "zip");
  assert.match(byName.get("image.png").dataUrl, /^data:image\/png;base64,/);
  assert.equal(byName.get("image.png").document.format, "image");
  assert.equal(byName.get("image.png").document.imageMode, "vision");
});

test("assistant runtime refreshes stale unreadable PDF attachments before prompting the model", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const sourceDir = path.join(root, "sources");
  fs.mkdirSync(sourceDir, { recursive: true });
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const pdfPath = path.join(sourceDir, "stale.pdf");
  fs.writeFileSync(pdfPath, makePdfBuffer("PDF 重新解析正文"));
  const picked = await createAssistantAttachmentsFromFiles(app, null, [pdfPath]);
  const originalAttachment = picked.attachments[0];
  const staleDocument = {
    format: "pdf",
    readStatus: "unreadable",
    extractedChars: 0,
    truncated: false,
    errorCode: "parse_failed"
  };
  const staleError = "该附件已保存，但解析时未能提取到可读文本。";
  const attachmentsDir = path.join(root, "assistant", "chats", picked.chatId, "attachments");
  const metadataPath = path.join(attachmentsDir, `${originalAttachment.id}.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    ...metadata,
    text: "",
    error: staleError,
    document: staleDocument
  }, null, 2)}\n`, "utf8");
  const staleAttachment = {
    ...originalAttachment,
    text: "",
    error: staleError,
    document: staleDocument
  };

  const originalFetch = globalThis.fetch;
  let sawPrompt = false;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    const userContent = String(payload.messages.at(-1).content);
    assert.match(userContent, /PDF 重新解析正文/);
    assert.doesNotMatch(userContent, /ZenMind 控制中心/);
    sawPrompt = true;
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "已解析 PDF。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(app, (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  });
  const start = runtime.startRun({
    chatId: picked.chatId,
    message: "解析一下",
    action: "chat",
    pageContext: {
      url: "https://example.com/control",
      title: "ZenMind 控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["服务状态"],
      bodyText: "ZenMind 控制中心运行状态和服务列表。"
    },
    attachments: [staleAttachment]
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(sawPrompt, true);
  const refreshed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.match(refreshed.text, /PDF 重新解析正文/);
  assert.equal(refreshed.document.readStatus, "readable");
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
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

test("assistant runtime opens ordinary website requests without browser use or model guessing", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ordinary website open should not call the model");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const opened = [];
  const browserUse = {
    async activateSurface() {
      throw new Error("ordinary website open should not use Browser Use");
    },
    async click() {
      throw new Error("ordinary website open should not click Browser Use");
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
  }, browserUse, {
    async openExternalUrl(url) {
      opened.push(url);
    }
  });

  const start = runtime.startRun({
    message: "帮我打开谷歌。",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心"],
      bodyText: "服务状态"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(opened, ["https://www.google.com/"]);
  assert.match(visibleContent(events), /已打开谷歌/);
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "open_url"));
  assert.equal(events.some((event) => event.type === "awaiting.ask"), false);
});

test("assistant runtime opens system Chrome for compound Google search extraction without a left browser", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("compound browser search should not ask the model to invent results");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async openUrl(input) {
      calls.push(["openUrl", input]);
      return {
        ok: true,
        action: "open_url",
        target: input.url,
        message: `已打开${input.label || input.url}。`,
        data: {
          surface: {
            id: "builtin-browser",
            label: input.label || "浏览器",
            url: input.url,
            active: true,
            currentUrl: input.url,
            webContentsId: 77
          }
        }
      };
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.google.com/search?q=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
        title: "今日热点 - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: [
          "News",
          "今日热点新闻第一条",
          "今日热点新闻第二条",
          "今日热点新闻第三条",
          "Related searches"
        ],
        bodyText: "今日热点新闻第一条\n今日热点新闻第二条\n今日热点新闻第三条",
        browserTarget: {
          kind: "webview",
          webContentsId
        }
      };
    }
  };

  const openedExternal = [];
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
  }, browserUse, {
    async openExternalUrl(url) {
      openedExternal.push(url);
    }
  });

  const start = runtime.startRun({
    message: "帮我打开谷歌，在谷歌里搜索今日热点，并返回前三条数据",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心"],
      bodyText: "服务状态"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(openedExternal, []);
  assert.deepEqual(calls, [
    ["openUrl", { url: "https://www.google.com/", label: "谷歌" }],
    ["fillBestInputAndSubmit", 77, "今日热点"],
    ["readPageContext", 77]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /已完成搜索并读取到前 3 条数据|已完成搜索并读取到前 3 条结果/);
  assert.match(visibleText, /1\. 今日热点新闻第一条/);
  assert.match(visibleText, /2\. 今日热点新闻第二条/);
  assert.match(visibleText, /3\. 今日热点新闻第三条/);
});

test("assistant runtime completes open-google search result requests without stopping after open", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("deterministic site search should not fall into the model browser loop");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async openUrl(input) {
      calls.push(["openUrl", input]);
      return {
        ok: true,
        action: "open_url",
        target: input.url,
        message: `已打开${input.label || input.url}。`,
        data: {
          surface: {
            id: "system-chrome:google",
            label: input.label || "Google Chrome",
            url: input.url,
            active: true,
            currentUrl: input.url,
            webContentsId: 77
          }
        }
      };
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3%E6%9C%80%E7%83%AD%E9%97%A8%E7%9A%84%E6%AD%8C%E6%9B%B2",
        title: "抖音最热门的歌曲 - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: [
          "抖音热门歌曲榜单",
          "2025 抖音热门歌曲合集",
          "抖音热歌排行榜",
          "抖音最火 BGM 推荐",
          "近期短视频热门歌曲"
        ],
        bodyText: "抖音热门歌曲榜单\n2025 抖音热门歌曲合集\n抖音热歌排行榜\n抖音最火 BGM 推荐\n近期短视频热门歌曲",
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
    message: "打开浏览器进入google，然后搜搜抖音最热门的歌曲，然后告诉我记过",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心"],
      bodyText: "服务状态"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls.slice(0, 3), [
    ["openUrl", { url: "https://www.google.com/", label: "谷歌" }],
    ["fillBestInputAndSubmit", 77, "抖音最热门的歌曲"],
    ["readPageContext", 77]
  ]);
  assert.ok(calls.length <= 4, `unexpected extra browser calls: ${JSON.stringify(calls)}`);
  const visibleText = visibleContent(events);
  assert.doesNotMatch(visibleText, /已在系统 Chrome 打开谷歌。$/);
  assert.doesNotMatch(visibleText, /浏览器操作步骤已达到上限/);
  assert.match(visibleText, /抖音热门歌曲榜单/);
  assert.match(visibleText, /抖音热门歌曲合集/);
});

test("assistant runtime reads ten song results for Chrome Google song requests", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ten-song browser search should be handled by BrowserRuntime");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const googleSongHtml = `
<main id="search">
  <nav>
    <a>Skip to main content</a>
    <a>Accessibility help</a>
    <a>Accessibility feedback</a>
    <a>Sign in</a>
    <a>AI Mode</a>
    <a>Short videos</a>
    <a>Forums</a>
    <a>Any time</a>
    <a>Past hour</a>
    <a>Past 24 hours</a>
  </nav>
  <section>
    <h2>AI Overview</h2>
    <p>榜单前列热歌： 颜人中《我只能离开》、李荣浩《恋人》、周杰伦《晴天》、Justin Bieber/Nicki Minaj《Beauty And A Beat》、唯一。</p>
    <p>高频流行曲： LBI利比《跳楼机》、王菲《世界赠予我的》、郑润泽《瞬》。</p>
    <p>粤语经典/热门： 《刚刚好》、《一夜入冬》、《爱情被告》。</p>
  </section>
</main>
`;
  const calls = [];
  const browserUse = {
    async openUrl(input) {
      calls.push(["openUrl", input]);
      return {
        ok: true,
        action: "open_url",
        target: input.url,
        message: `已打开${input.label || input.url}。`,
        data: {
          surface: {
            id: "system-chrome:google",
            label: input.label || "Google Chrome",
            url: input.url,
            active: true,
            currentUrl: input.url,
            webContentsId: 77
          }
        }
      };
    },
    async waitForPageSettle(webContentsId, timeoutMs) {
      calls.push(["waitForPageSettle", webContentsId, timeoutMs]);
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3%E6%9C%80%E7%83%AD%E9%97%A8%E7%9A%8410%E9%A6%96%E6%AD%8C%E6%9B%B2",
        title: "抖音最热门的10首歌曲 - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: ["Search Results"],
        bodyText: [
          "Skip to main content",
          "Accessibility help",
          "Accessibility feedback",
          "Sign in",
          "AI Mode",
          "Short videos",
          "Forums",
          "Any time",
          "Past hour",
          "Past 24 hours",
          "榜单前列热歌： 颜人中《我只能离开》、李荣浩《恋人》、周杰伦《晴天》、Justin Bieber/Nicki Minaj《Beauty And A Beat》、唯一。"
        ].join("\n"),
        browserTarget: {
          kind: "webview",
          webContentsId
        }
      };
    },
    async extractPage(webContentsId, extraction) {
      calls.push(["extractPage", webContentsId, extraction]);
      return browserRuntimeInternals.extractBrowserItemsFromHtml(
        googleSongHtml,
        "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3%E6%9C%80%E7%83%AD%E9%97%A8%E7%9A%8410%E9%A6%96%E6%AD%8C%E6%9B%B2",
        extraction
      );
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
    message: "帮我打开 Chrome，输入 Google，然后在谷歌里搜索抖音最热门的10首歌曲，并把搜索的结果总结一下发给我。",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心"],
      bodyText: "服务状态"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.ok(calls.some((call) => call[0] === "fillBestInputAndSubmit" && call[2] === "抖音最热门的10首歌曲"));
  const visibleText = visibleContent(events);
  assert.match(visibleText, /前 10 条歌曲/);
  assert.match(visibleText, /1\. 我只能离开 - 颜人中/);
  assert.match(visibleText, /10\. 一夜入冬/);
  assert.doesNotMatch(visibleText, /前 3 条/);
  assert.doesNotMatch(visibleText, /Skip to main content|Accessibility help|Sign in|Past 24 hours/);
});

test("assistant runtime opens system Chrome when left side is not a browser surface", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const calls = [];
  const browserUse = {
    async openUrl(input) {
      calls.push(["openUrl", input]);
      return {
        ok: true,
        action: "open_url",
        target: input.url,
        message: `已在 Chrome 打开${input.label || input.url}。`,
        data: {
          surface: {
            id: "chrome",
            label: "Chrome",
            url: input.url,
            active: true,
            currentUrl: input.url,
            webContentsId: 77
          }
        }
      };
    }
  };
  const openedExternal = [];
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
  }, browserUse, {
    async openExternalUrl(url) {
      openedExternal.push(url);
    }
  });

  const start = runtime.startRun({
    message: "在当前窗口内帮我打开谷歌",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心"],
      bodyText: "服务状态"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(openedExternal, []);
  assert.deepEqual(calls, [["openUrl", { url: "https://www.google.com/", label: "谷歌" }]]);
  assert.match(visibleContent(events), /Chrome|谷歌/);
});

test("assistant runtime navigates current left browser surface for website open requests", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const calls = [];
  const browserUse = {
    async navigateUrl(webContentsId, input) {
      calls.push(["navigateUrl", webContentsId, input]);
      return {
        ok: true,
        action: "navigate",
        target: input.url,
        url: input.url,
        title: input.label,
        message: `已在当前网页打开${input.label}。`
      };
    },
    async openUrl() {
      throw new Error("current left browser surface should be reused instead of opening system Chrome");
    }
  };
  const openedExternal = [];
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
  }, browserUse, {
    async openExternalUrl(url) {
      openedExternal.push(url);
    }
  });

  const start = runtime.startRun({
    message: "帮我打开谷歌",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "",
      browserTarget: {
        kind: "webview",
        webContentsId: 23,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(openedExternal, []);
  assert.deepEqual(calls, [["navigateUrl", 23, { url: "https://www.google.com/", label: "谷歌" }]]);
  assert.match(visibleContent(events), /当前左侧网页|当前网页/);
});

test("assistant runtime navigates current browser before compound search when requested site differs", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const calls = [];
  const browserUse = {
    async navigateUrl(webContentsId, input) {
      calls.push(["navigateUrl", webContentsId, input]);
      return {
        ok: true,
        action: "navigate",
        target: input.url,
        url: input.url,
        title: input.label,
        message: `已在当前网页打开${input.label}。`
      };
    },
    async openUrl() {
      throw new Error("current left browser surface should be reused instead of opening system Chrome");
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.google.com/search?q=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
        title: "今日热点 - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: ["今日热点新闻第一条", "今日热点新闻第二条", "今日热点新闻第三条"],
        bodyText: "今日热点新闻第一条\n今日热点新闻第二条\n今日热点新闻第三条",
        browserTarget: {
          kind: "webview",
          webContentsId
        }
      };
    }
  };
  const openedExternal = [];
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
  }, browserUse, {
    async openExternalUrl(url) {
      openedExternal.push(url);
    }
  });

  const start = runtime.startRun({
    message: "帮我打开谷歌，在谷歌里搜索今日热点，并返回前三条数据",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下",
      selectedText: "",
      metaDescription: "",
      headings: ["百度一下"],
      bodyText: "",
      browserTarget: {
        kind: "webview",
        webContentsId: 23,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(openedExternal, []);
  assert.deepEqual(calls, [
    ["navigateUrl", 23, { url: "https://www.google.com/", label: "谷歌" }],
    ["fillBestInputAndSubmit", 23, "今日热点"],
    ["readPageContext", 23]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /1\. 今日热点新闻第一条/);
  assert.match(visibleText, /2\. 今日热点新闻第二条/);
  assert.match(visibleText, /3\. 今日热点新闻第三条/);
});

test("assistant runtime continues current left browser site search instead of stopping after navigation", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("current browser deterministic search should not ask the model");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  const browserUse = {
    async navigateUrl(webContentsId, input) {
      calls.push(["navigateUrl", webContentsId, input]);
      return {
        ok: true,
        action: "navigate",
        target: input.url,
        url: input.url,
        title: input.label,
        message: `已在当前网页打开${input.label}。`
      };
    },
    async openUrl() {
      throw new Error("current left browser surface should be reused instead of opening system Chrome");
    },
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        value,
        submitted: true,
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3%E7%83%AD%E9%97%A8%E6%AD%8C%E6%9B%B2",
        title: "抖音热门歌曲 - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: [
          "抖音热门歌曲第一条",
          "抖音热门歌曲第二条",
          "抖音热门歌曲第三条",
          "抖音热门歌曲第四条",
          "抖音热门歌曲第五条",
          "抖音热门歌曲第六条",
          "抖音热门歌曲第七条",
          "抖音热门歌曲第八条",
          "抖音热门歌曲第九条",
          "抖音热门歌曲第十条"
        ],
        bodyText: "抖音热门歌曲第一条\n抖音热门歌曲第二条\n抖音热门歌曲第三条\n抖音热门歌曲第四条\n抖音热门歌曲第五条\n抖音热门歌曲第六条\n抖音热门歌曲第七条\n抖音热门歌曲第八条\n抖音热门歌曲第九条\n抖音热门歌曲第十条",
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
    message: "帮我打开google,然后搜索抖音热门歌曲，然后把搜索的结果最热门的10条返回给我",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下",
      selectedText: "",
      metaDescription: "",
      headings: ["百度一下"],
      bodyText: "",
      browserTarget: {
        kind: "webview",
        webContentsId: 23,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls, [
    ["navigateUrl", 23, { url: "https://www.google.com/", label: "谷歌" }],
    ["fillBestInputAndSubmit", 23, "抖音热门歌曲"],
    ["readPageContext", 23]
  ]);
  const visibleText = visibleContent(events);
  assert.doesNotMatch(visibleText, /已在当前左侧网页打开谷歌。$/);
  assert.match(visibleText, /抖音热门歌曲第一条/);
  assert.match(visibleText, /抖音热门歌曲第十条/);
});

test("assistant runtime treats fresh information questions as new browser searches", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fresh information request should not answer from stale page context");
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
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.google.com/search?q=%E4%BB%8A%E5%A4%A9%E7%83%AD%E7%82%B9%E6%96%B0%E9%97%BB",
        title: "今天热点新闻 - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: ["热点新闻第一条", "热点新闻第二条", "热点新闻第三条", "热点新闻第四条", "热点新闻第五条"],
        bodyText: "热点新闻第一条\n热点新闻第二条\n热点新闻第三条\n热点新闻第四条\n热点新闻第五条",
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
    message: "今天有什么热点新闻总结一下发给我",
    action: "chat",
    pageContext: {
      url: "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3%E7%83%AD%E9%97%A8%E6%AD%8C%E6%9B%B2",
      title: "抖音热门歌曲 - Google Search",
      selectedText: "",
      metaDescription: "",
      headings: ["抖音热门歌曲"],
      bodyText: "抖音热门歌曲 Top 10",
      browserTarget: {
        kind: "webview",
        webContentsId: 23,
        surfaceLabel: "Google",
        currentUrl: "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3%E7%83%AD%E9%97%A8%E6%AD%8C%E6%9B%B2"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls, [
    ["fillBestInputAndSubmit", 23, "今天热点新闻"],
    ["readPageContext", 23]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /热点新闻第一条/);
  assert.doesNotMatch(visibleText, /抖音热门歌曲 Top 10/);
});

test("assistant runtime only uses browser input for explicit left-side web instructions", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const opened = [];
  const calls = [];
  const browserUse = {
    async fillBestInputAndSubmit(webContentsId, value) {
      calls.push(["fillBestInputAndSubmit", webContentsId, value]);
      return {
        ok: true,
        action: "submit",
        target: value,
        message: `已在输入框输入“${value}”并提交。`
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
  }, browserUse, {
    async openExternalUrl(url) {
      opened.push(url);
    }
  });

  const start = runtime.startRun({
    message: "在左边的百度搜索今日热点",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下",
      selectedText: "",
      metaDescription: "",
      headings: ["百度一下"],
      bodyText: "",
      browserTarget: {
        kind: "webview",
        webContentsId: 23,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(opened, []);
  assert.deepEqual(calls, [["fillBestInputAndSubmit", 23, "今日热点"]]);
  assert.match(visibleContent(events), /已在输入框输入“今日热点”并提交/);
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
    assert.doesNotMatch(transcript, /左侧浏览器目标：未检测到可操作浏览器目标/);
    assert.match(transcript, /当前页面上下文/);
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
  writeAgentPlatformMinimaxProvider(root);

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
  assert.equal(mixedResult.rawText, "帮我看一下 open ai 的 api key 设置");
  assert.equal(mixedResult.correctedText, "帮我看一下 OpenAI 的 API Key 设置");
  assert.equal(mixedResult.changeLevel, "minor");
  assert.equal(mixedResult.glossaryHits.includes("OpenAI"), true);
  assert.ok(mixedResult.confidence > 0.5);

  const englishResult = await runtime.correctVoiceText({
    text: "please help me check github actions",
    locale: "zh-CN-mixed-en"
  });
  assert.equal(englishResult.ok, true);
  assert.equal(englishResult.text, "please help me check GitHub Actions");
  assert.equal(englishResult.correctedText, "please help me check GitHub Actions");
  assert.equal(englishResult.glossaryHits.includes("GitHub Actions"), true);

  assert.equal(requests.length, 2);
  assert.deepEqual(events, []);
  assert.equal(fs.existsSync(path.join(root, "assistant", "chats")), false);
});

test("assistant voice correction keeps ASR text when model correction fails", async (t) => {
  const root = makeTempRoot(t);
  writeAgentPlatformMinimaxProvider(root);

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

test("assistant voice correction quietly keeps ASR text when minimax provider is unavailable", async (t) => {
  const root = makeTempRoot(t);
  const events = [];
  const runtime = new AssistantRuntime(makeApp(root), (event) => events.push(event));

  const result = await runtime.correctVoiceText({
    text: "帮我看一下 open ai",
    locale: "zh-CN-mixed-en"
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "帮我看一下 open ai");
  assert.equal(result.correctedText, "帮我看一下 open ai");
  assert.equal(result.changeLevel, "none");
  assert.equal(result.message, "语音文本已确认。");
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

test("assistant voice transcription does not reuse minimax chat provider as ASR fallback", async (t) => {
  const root = makeTempRoot(t);
  const providerDir = path.join(root, "Desktop", "zenmind-env", "registries", "providers");
  fs.mkdirSync(providerDir, { recursive: true });
  fs.writeFileSync(path.join(providerDir, "minimax.yml"), [
    "key: minimax",
    "baseUrl: https://api.minimaxi.com",
    "apiKey: sk-minimax",
    "defaultModel: minimax-m2_7-openai",
    ""
  ].join("\n"), "utf8");

  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error("minimax provider must not be used for ASR fallback");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new AssistantRuntime(makeApp(root), () => {});
  const result = await runtime.transcribeVoiceAudio({
    mimeType: "audio/webm",
    data: new Uint8Array([1, 2, 3, 4]).buffer,
    locale: "zh-CN-mixed-en"
  });

  assert.equal(result.ok, false);
  assert.equal(requestCount, 0);
  assert.match(result.message, /云端语音识别 provider/);
  assert.match(result.message, /qwen3-asr-flash/);
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
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[0].content[0].type, "input_audio");
    assert.equal(
      String(payload.messages[0].content[0].input_audio.data).startsWith("data:audio/wav;base64,"),
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
  assert.equal(result.rawText, "帮我检查 GitHub Actions");
  assert.equal(result.correctedText, "帮我检查 GitHub Actions");
  assert.equal(result.changeLevel, "none");
  assert.ok(result.confidence > 0.5);
  assert.equal(requests.length, 1);
  assert.deepEqual(events, []);
  assert.equal(fs.existsSync(path.join(root, "assistant", "chats")), false);
});

test("assistant runtime emits intent, route, and verify events for browser tools", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  let fetchIndex = 0;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    if (fetchIndex === 0) {
      fetchIndex += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "tool_observe",
              type: "function",
              function: {
                name: "browser_observe",
                arguments: "{}"
              }
            }]
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "页面读取完成。" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      resolveDone();
    }
  }, {
    async observePage(webContentsId) {
      return {
        ok: true,
        action: "observe",
        url: "https://example.com/",
        title: "Example",
        bodyText: "Example body",
        elements: [],
        fields: [],
        data: { webContentsId }
      };
    }
  });
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const start = runtime.startRun({
    message: "帮我观察左侧网页",
    action: "chat",
    pageContext: {
      url: "https://example.com/",
      title: "Example",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "Example",
      browserTarget: {
        kind: "webview",
        webContentsId: 42
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  const intentEvent = events.find((event) => event.type === "intent.classified");
  assert.equal(intentEvent?.data.intent.kind, "operate_browser");
  assert.equal(intentEvent.data.intent.usesPageContext, true);
  const routeEvent = events.find((event) => event.type === "tool.route" && event.toolName === "browser_observe");
  assert.equal(routeEvent?.status, "ok");
  assert.equal(routeEvent.data.route.kind, "browser");
  const verifyEvent = events.find((event) => event.type === "tool.verify" && event.toolName === "browser_observe");
  assert.equal(verifyEvent?.status, "ok");
  assert.match(verifyEvent.message, /复查|完成/);
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
  assert.deepEqual(events.map((event) => event.type), ["request.query", "chat.start", "run.start", "intent.classified", "run.stopped", "done"]);
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
    "intent.classified",
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

test("assistant runtime extracts requested records after generic search without hardcoded engine selectors", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("generic browser runtime extraction should not ask the model to invent results");
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
        inputLabel: "Search"
      };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.google.com/search?q=%E7%BE%8E%E5%9B%BD%E4%BA%BA",
        title: "美国人 - Google Search",
        selectedText: "",
        metaDescription: "",
        headings: [
          "Videos",
          "American people - Wikipedia",
          "Americans - Britannica",
          "People in the United States - Census.gov",
          "Related searches"
        ],
        bodyText: [
          "American people - Wikipedia",
          "Americans are the citizens and nationals of the United States.",
          "Americans - Britannica",
          "A brief overview of people from the United States.",
          "People in the United States - Census.gov",
          "Population and demographic records."
        ].join("\n"),
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
    message: "Google 搜美国人，查完以后发前3个结果给我",
    action: "chat",
    pageContext: {
      url: "https://www.google.com/",
      title: "Google",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "Google Search",
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
    ["fillBestInputAndSubmit", 7, "美国人"],
    ["readPageContext", 7]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /已完成搜索并读取到前 3 条结果/);
  assert.match(visibleText, /1\. American people - Wikipedia/);
  assert.match(visibleText, /2\. Americans - Britannica/);
  assert.match(visibleText, /3\. People in the United States - Census\.gov/);
});

test("assistant runtime summarizes visible search results without rewriting the search box", async (t) => {
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
    assert.match(transcript, /当前页面上下文/);
    assert.match(transcript, /豆包AI/);
    assert.match(transcript, /长期前三反思文/);
    assert.match(transcript, /前3条总结|前3条/);
    return new Response('data: {"choices":[{"delta":{"content":"前三条总结完成"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async fillBestInputAndSubmit() {
      throw new Error("visible search result summary should not submit the search box");
    },
    async fillBestInput() {
      throw new Error("visible search result summary should not fill the search box");
    },
    async clickElementByText() {
      throw new Error("visible search result summary should not click");
    },
    async observePage() {
      throw new Error("visible search result summary should not enter browser tool mode");
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
    message: "根据搜索结果的前3条总结一下，发给我",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/s?wd=%E7%BB%93%E6%9E%9C",
      title: "结果_百度搜索",
      selectedText: "",
      metaDescription: "",
      headings: ["百度热搜", "豆包AI-更智能的写作助手", "长期前三反思文 - 百度文库", "工作总结门前三 - 百度文库"],
      bodyText: "1 豆包AI-更智能的写作助手\n2 长期前三反思文 - 百度文库\n3 工作总结门前三 - 百度文库",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.match(visibleContent(events), /前三条总结完成/);
  assert.ok(events.every((event) => event.type !== "tool.start" && event.type !== "tool.result"));
});

test("assistant runtime sends compound search-result clicks to browser tools instead of direct click", async (t) => {
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
    assert.ok(payload.tools.some((tool) => tool.function?.name === "browser_observe"));
    assert.ok(payload.tools.some((tool) => tool.function?.name === "browser_read"));
    const transcript = JSON.stringify(payload.messages);
    assert.match(transcript, /第一条/);
    assert.match(transcript, /详细解读/);
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "将通过浏览器工具观察搜索结果，再打开第一条并解读。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async observePage() {
      return {
        ok: true,
        action: "observe",
        url: "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
        title: "今日热点_百度搜索",
        bodyText: "百度搜索结果 第一条 新闻标题",
        elements: [],
        fields: []
      };
    },
    async clickElementByText() {
      throw new Error("compound search-result task should not use direct click");
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
    message: "打开页面上今日热点搜索结果中的第一条，然后详细解读",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
      title: "今日热点_百度搜索",
      selectedText: "",
      metaDescription: "",
      headings: ["百度热搜", "第一条 新闻标题"],
      bodyText: "百度搜索结果 第一条 新闻标题",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.match(visibleContent(events), /浏览器工具观察搜索结果/);
});

test("assistant runtime lets model drive variable browser instructions through tools", async (t) => {
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
      throw new Error("current browser task should not need surface listing");
    },
    async activateSurface(target) {
      throw new Error(`current browser task should not activate ${target}`);
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
    message: "请用浏览器工具按页面流程处理当前百度任务，关键词是今日热点",
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
        webContentsId: 77,
        surfaceId: "custom-baidu",
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;
  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);

  assert.deepEqual(calls, [
    ["observePage", 77],
    ["fillFields", 77, [{ label: "搜索框", value: "今日热点" }]],
    ["submit", 77, { target: "百度一下" }],
    ["readPageContext", 77]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /今日热点/);
  assert.doesNotMatch(visibleText, /按页面流程处理当前百度任务/);
  assert.equal(events[0].type, "request.query");
  assert.equal(events[2].type, "run.start");
  assert.equal(events[3].type, "intent.classified");
  assert.ok(events.some((event) => event.type === "tool.start" && event.toolName === "browser_observe"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_fill"));
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
  assert.ok(
    getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId)
      .events.some((event) => event.type === "tool.result" && event.toolName === "browser_fill")
  );
});

test("assistant runtime exposes system Chrome CDP tools when no left browser target exists", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const toolResponses = [
    {
      id: "tool_open",
      name: "browser_open_url",
      arguments: JSON.stringify({ url: "https://example.com/", label: "Example" })
    },
    {
      id: "tool_cdp",
      name: "browser_cdp_command",
      arguments: JSON.stringify({
        method: "Runtime.evaluate",
        params: { expression: "document.title", returnByValue: true }
      })
    },
    { id: "tool_snapshot", name: "browser_snapshot", arguments: "{}" }
  ];
  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    assert.ok(toolNames.includes("browser_open_url"));
    assert.ok(toolNames.includes("browser_cdp_command"));
    assert.ok(toolNames.includes("browser_snapshot"));

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
            content: "已在系统 Chrome 打开 Example，并读取到页面标题。"
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
    async openUrl(input) {
      calls.push(["openUrl", input]);
      return {
        ok: true,
        action: "open_url",
        target: input.url,
        url: input.url,
        title: input.label,
        message: "已在系统 Chrome 打开 Example。",
        data: {
          surface: {
            id: "system-chrome:target-1",
            label: "Google Chrome",
            url: input.url,
            active: true,
            currentUrl: input.url,
            title: input.label,
            webContentsId: 77
          }
        }
      };
    },
    async sendCdpCommand(webContentsId, input) {
      calls.push(["sendCdpCommand", webContentsId, input]);
      return {
        ok: true,
        action: "cdp_command",
        target: input.method,
        message: `已执行 CDP 命令：${input.method}。`,
        data: { result: { type: "string", value: "Example Domain" } }
      };
    },
    async createRuntimeSnapshot(webContentsId) {
      calls.push(["createRuntimeSnapshot", webContentsId]);
      return {
        url: "https://example.com/",
        title: "Example Domain",
        pageContext: {
          url: "https://example.com/",
          title: "Example Domain",
          selectedText: "",
          metaDescription: "",
          headings: ["Example Domain"],
          bodyText: "Example Domain",
          browserTarget: {
            kind: "webview",
            webContentsId
          }
        },
        accessibility: [],
        screenshot: {
          mimeType: "image/jpeg",
          data: "base64-screenshot"
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
    message: "请用浏览器打开一个新网页 https://example.com/，然后用 CDP 读取页面标题和快照",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/agent",
      title: "智能助理",
      selectedText: "",
      metaDescription: "",
      headings: ["智能助理"],
      bodyText: "普通页面"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls, [
    ["openUrl", { url: "https://example.com/", label: "Example" }],
    ["sendCdpCommand", 77, { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }],
    ["createRuntimeSnapshot", 77]
  ]);
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_open_url"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_cdp_command"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "browser_snapshot"));
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
});

test("assistant runtime blocks internal surface activation when no left browser target exists", async (t) => {
  const root = makeTempRoot(t);
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
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    assert.ok(toolNames.includes("browser_open_url"));
    assert.ok(toolNames.includes("browser_activate_surface"));

    if (fetchIndex === 0) {
      fetchIndex += 1;
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "tool_activate",
                  type: "function",
                  function: {
                    name: "browser_activate_surface",
                    arguments: JSON.stringify({ target: "百度" })
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
            content: "当前左侧不是可操作浏览器页面，应改用系统 Chrome 打开网页。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async openUrl() {
      throw new Error("this test verifies activation is blocked before opening a fallback");
    },
    async activateSurface() {
      throw new Error("non-browser page should not activate internal browser surfaces");
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
    message: "请用浏览器工具激活百度入口",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/agent",
      title: "智能助理",
      selectedText: "",
      metaDescription: "",
      headings: ["智能助理"],
      bodyText: "普通页面"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.ok(events.some((event) =>
    event.type === "tool.result" &&
    event.toolName === "browser_activate_surface" &&
    event.status === "error" &&
    event.error === "browser_target_not_active"
  ));
  assert.match(visibleContent(events), /系统 Chrome/);
});

test("assistant runtime navigates current left browser target with CDP instead of opening system Chrome", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const toolResponses = [
    {
      id: "tool_nav",
      name: "browser_navigate",
      arguments: JSON.stringify({ url: "https://example.com/", label: "Example" })
    },
    { id: "tool_snapshot", name: "browser_snapshot", arguments: "{}" }
  ];
  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    assert.ok(toolNames.includes("browser_navigate"));
    assert.ok(toolNames.includes("browser_snapshot"));

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
            content: "已在当前左侧 Chrome 页面访问 Example。"
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
    async navigateUrl(webContentsId, input) {
      calls.push(["navigateUrl", webContentsId, input]);
      return {
        ok: true,
        action: "navigate",
        target: input.url,
        url: input.url,
        title: input.label,
        message: `已在当前网页打开${input.label}。`
      };
    },
    async createRuntimeSnapshot(webContentsId) {
      calls.push(["createRuntimeSnapshot", webContentsId]);
      return {
        url: "https://example.com/",
        title: "Example Domain",
        pageContext: {
          url: "https://example.com/",
          title: "Example Domain",
          selectedText: "",
          metaDescription: "",
          headings: ["Example Domain"],
          bodyText: "Example Domain",
          browserTarget: {
            kind: "webview",
            webContentsId,
            surfaceLabel: "百度",
            currentUrl: "https://example.com/"
          }
        }
      };
    },
    async openUrl() {
      throw new Error("current left browser target should be reused instead of opening system Chrome");
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
    message: "请在地址栏输入 https://example.com/，然后获取 CDP 快照",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下",
      selectedText: "",
      metaDescription: "",
      headings: [],
      bodyText: "",
      browserTarget: {
        kind: "webview",
        webContentsId: 23,
        surfaceId: "builtin-baidu",
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls, [
    ["navigateUrl", 23, { url: "https://example.com/", label: "Example" }],
    ["createRuntimeSnapshot", 23]
  ]);
  assert.equal(lastRunTerminalEvent(events).type, "run.complete");
});

test("assistant runtime keeps removed agent execution out of the default browser tool loop", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const toolResponses = [
    { id: "tool_observe_default", name: "browser_observe", arguments: "{}" },
    {
      id: "tool_fill_default",
      name: "browser_fill",
      arguments: JSON.stringify({
        fields: [{ label: "搜索框", value: "普通搜索" }]
      })
    },
    { id: "tool_submit_default", name: "browser_submit", arguments: JSON.stringify({ target: "搜索" }) },
    { id: "tool_read_default", name: "browser_read", arguments: "{}" }
  ];
  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    const removedToolName = "browser" + "_agent_execute";
    assert.equal(toolNames.includes(removedToolName), false);
    assert.ok(toolNames.includes("browser_observe"));
    assert.ok(toolNames.includes("browser_fill"));
    assert.ok(toolNames.includes("browser_submit"));
    assert.ok(toolNames.includes("browser_read"));

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
            content: "已用内置浏览器工具完成普通搜索。"
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
        url: "https://example.com/",
        title: "Example",
        bodyText: "搜索页面",
        elements: [{ elementRef: "{\"selector\":\"button\",\"text\":\"搜索\"}", text: "搜索", kind: "button", unsafe: false }],
        fields: [{ elementRef: "{\"selector\":\"input\",\"label\":\"搜索框\"}", label: "搜索框", value: "", options: [] }]
      };
    },
    async fillFields(webContentsId, fields) {
      calls.push(["fillFields", webContentsId, fields]);
      return { ok: true, action: "fill", message: "已填写搜索框。" };
    },
    async submit(webContentsId, input) {
      calls.push(["submit", webContentsId, input]);
      return { ok: true, action: "submit", target: input.target, message: "已提交搜索。" };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://example.com/search?q=%E6%99%AE%E9%80%9A%E6%90%9C%E7%B4%A2",
        title: "Search",
        selectedText: "",
        metaDescription: "",
        headings: ["普通搜索结果"],
        bodyText: "普通搜索结果",
        browserTarget: { kind: "webview", webContentsId }
      };
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
    ["observePage", 33],
    ["fillFields", 33, [{ label: "搜索框", value: "普通搜索" }]],
    ["submit", 33, { target: "搜索" }],
    ["readPageContext", 33]
  ]);
  assert.match(visibleContent(events), /内置浏览器工具/);
  assert.equal(events.some((event) => event.toolName === "browser" + "_agent_execute"), false);
});

test("assistant runtime treats removed agent wording as built-in browser tool work", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const removedAgentName = "Page" + "Agent";
  const removedToolName = "browser" + "_agent_execute";
  const toolResponses = [
    { id: "tool_removed_observe", name: "browser_observe", arguments: "{}" },
    {
      id: "tool_removed_fill",
      name: "browser_fill",
      arguments: JSON.stringify({
        fields: [{ label: "搜索框", value: "相爱" }]
      })
    },
    { id: "tool_removed_submit", name: "browser_submit", arguments: JSON.stringify({ target: "百度一下" }) },
    { id: "tool_removed_read", name: "browser_read", arguments: "{}" }
  ];
  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, false);
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    assert.equal(toolNames.includes(removedToolName), false);
    assert.ok(toolNames.includes("browser_observe"));
    assert.ok(toolNames.includes("browser_fill"));
    assert.ok(toolNames.includes("browser_submit"));
    assert.ok(toolNames.includes("browser_read"));

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
            content: "已用内置浏览器工具读取前三条结果。"
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
        elements: [{ elementRef: "{\"selector\":\"#su\",\"text\":\"百度一下\"}", text: "百度一下", kind: "button", unsafe: false }],
        fields: [{ elementRef: "{\"selector\":\"#kw\",\"label\":\"搜索框\"}", label: "搜索框", value: "", options: [] }]
      };
    },
    async fillFields(webContentsId, fields) {
      calls.push(["fillFields", webContentsId, fields]);
      return { ok: true, action: "fill", message: "已填写搜索框。" };
    },
    async submit(webContentsId, input) {
      calls.push(["submit", webContentsId, input]);
      return { ok: true, action: "submit", target: input.target, message: "已提交搜索。" };
    },
    async readPageContext(webContentsId) {
      calls.push(["readPageContext", webContentsId]);
      return {
        url: "https://www.baidu.com/s?wd=%E7%9B%B8%E7%88%B1",
        title: "相爱_百度搜索",
        selectedText: "",
        metaDescription: "",
        headings: ["相爱第一条", "相爱第二条", "相爱第三条"],
        bodyText: "相爱第一条\n相爱第二条\n相爱第三条",
        browserTarget: { kind: "webview", webContentsId }
      };
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
    message: `请用 ${removedAgentName} 按页面流程处理当前网页。`,
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
        webContentsId: 44
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.deepEqual(calls, [
    ["observePage", 44],
    ["fillFields", 44, [{ label: "搜索框", value: "相爱" }]],
    ["submit", 44, { target: "百度一下" }],
    ["readPageContext", 44]
  ]);
  assert.equal(events.some((event) => event.toolName === removedToolName), false);
  assert.match(visibleContent(events), /内置浏览器工具/);
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

test("assistant runtime routes service start requests to verified service control", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("service control should not ask the model to guess service state");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async listSurfaces() {
      throw new Error("non-browser service page should not list browser surfaces");
    },
    async activateSurface() {
      throw new Error("non-browser service page should not activate browser surfaces");
    },
    async clickElementByText() {
      throw new Error("non-browser service page should not click through Browser Use");
    },
    async fillBestInput() {
      throw new Error("service start should not use input");
    },
    async fillBestInputAndSubmit() {
      throw new Error("service start should not use search");
    }
  };

  const serviceCalls = [];
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
  }, browserUse, {
    services: {
      async control(serviceId, operation) {
        serviceCalls.push([serviceId, operation]);
        return {
          ok: false,
          message: "启动命令已执行，但复查失败：服务状态仍为 stopped。",
          service: {
            id: serviceId,
            name: "容器仓库",
            kind: "builtin",
            version: "v0.1.0",
            description: "",
            installDir: "/tmp/agent-container-hub",
            installed: true,
            status: "stopped",
            statusLabel: "已停止",
            message: "服务已安装，可手动启动。",
            frontendMode: "embedded",
            configFiles: [],
            healthMeta: {
              pid: null,
              pidFilePath: "/tmp/agent-container-hub/run/agent-container-hub.pid",
              logFilePath: "/tmp/agent-container-hub/run/agent-container-hub.log",
              errorLogFilePath: "/tmp/agent-container-hub/run/agent-container-hub.stderr.log",
              webUrl: "http://127.0.0.1:11960/",
              port: 11960,
              prerequisites: []
            }
          },
          verification: {
            verified: false,
            desired: "running",
            actualStatus: "stopped",
            pidAlive: false,
            portListening: false,
            managedPortPid: null,
            httpOk: false,
            runtimeInfoOk: false,
            checkedAt: new Date().toISOString(),
            issues: ["复查后服务状态仍为 stopped", "端口 11960 无监听"]
          }
        };
      }
    }
  });
  const start = runtime.startRun({
    message: "左侧页面的容器仓库无法启动，帮我启动一下",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心", "容器仓库"],
      bodyText: "容器仓库 已停止 启动 停止 重启"
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(serviceCalls, [["agent-container-hub", "start"]]);
  assert.ok(events.some((event) => event.type === "tool.start" && event.toolName === "service_control"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "service_verify" && event.status === "error"));
  const visibleText = visibleContent(events);
  assert.match(visibleText, /启动命令已执行|启动命令执行过/);
  assert.match(visibleText, /复查失败|未确认启动/);
  assert.doesNotMatch(visibleText, /已成功启动|已启动成功/);
});

test("assistant runtime executes pseudo XML browser tool text instead of displaying it", async (t) => {
  const root = makeTempRoot(t);
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
    assert.ok(payload.tools.some((tool) => tool.function?.name === "browser_click"));
    fetchIndex += 1;
    if (fetchIndex === 1) {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                "我来点击启动按钮：",
                "<functions>",
                "<invoke name=\"browser_dom_click\">",
                "<parameter name=\"locator\">button:has-text(\"启动\")</parameter>",
                "<parameter name=\"target\">left</parameter>",
                "</invoke>",
                "</functions>"
              ].join("\n")
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
            content: "已点击启动按钮。"
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
      throw new Error("pseudo XML fallback should not need a separate observe step");
    },
    async click(webContentsId, input) {
      calls.push(["click", webContentsId, input]);
      return {
        ok: true,
        action: "click",
        target: input.target,
        message: "已点击启动。"
      };
    },
    async clickElementByText() {
      throw new Error("pseudo XML fallback should use the tool-loop browser click");
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
    message: "请用浏览器工具按页面流程处理当前控件任务",
    action: "chat",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心", "容器仓库"],
      bodyText: "容器仓库 已停止 启动 停止 重启",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls, [["click", 7, { target: "启动" }]]);
  assert.equal(fetchIndex, 2);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /已点击启动/);
  assert.doesNotMatch(visibleText, /<functions?>/);
  assert.doesNotMatch(visibleText, /browser_dom_click/);
});

test("assistant runtime converts pseudo sandbox host app launch into allowlisted host app launch", async (t) => {
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
    assert.ok(payload.tools.some((tool) => tool.function?.name === "host_app_launch"));
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              "我来帮您启动 macOS 上的 Docker Desktop 应用。",
              "<function_calls>",
              "<invoke name=\"bash_sandbox\">",
              "<arg name=\"command\">open -a Docker</arg>",
              "</invoke>",
              "</function_calls>"
            ].join("\n")
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
  let terminalEvent;
  let asked = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (event.type === "awaiting.ask" && !asked) {
      asked = true;
      setImmediate(() => {
        runtime.submitAwaiting({
          awaitingId: event.awaiting.awaitingId,
          action: "reject",
          params: [],
          reason: "test blocks host command"
        });
      });
    }
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  });
  const start = runtime.startRun({
    message: "我想让你启动操作系统中的docerk应用",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.equal(asked, true);
  const awaiting = events.find((event) => event.type === "awaiting.ask");
  assert.equal(awaiting?.toolName, "host_app_launch");
  assert.match(awaiting?.awaiting?.approval?.command ?? "", /open -a "Docker Desktop"/);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /用户已拒绝/);
  assert.doesNotMatch(visibleText, /<function_calls>/);
  assert.doesNotMatch(visibleText, /bash_sandbox/);
});

test("assistant runtime captures Claude Code pseudo host app launch before it reaches chat text", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const pseudoLaunch = [
    "我来帮你启动 Claude Code。",
    "<function_calls>",
    "<invoke name=\"host_app_launch\">",
    "<arg name=\"app_name_or_path\">claude</arg>",
    "</invoke>",
    "</function_calls>"
  ].join("\n");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    if (payload.stream === true) {
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: pseudoLaunch } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    assert.equal(payload.stream, false);
    assert.ok(payload.tools.some((tool) => tool.function?.name === "host_app_launch"));
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: pseudoLaunch
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
  let terminalEvent;
  let asked = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (event.type === "awaiting.ask" && !asked) {
      asked = true;
      setImmediate(() => {
        runtime.submitAwaiting({
          awaitingId: event.awaiting.awaitingId,
          action: "reject",
          params: [],
          reason: "test blocks host app launch"
        });
      });
    }
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  });
  const start = runtime.startRun({
    message: "请帮我打开 claude code",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.equal(asked, true);
  const awaiting = events.find((event) => event.type === "awaiting.ask");
  assert.equal(awaiting?.toolName, "host_app_launch");
  assert.match(awaiting?.awaiting?.approval?.command ?? "", /open -a "Claude"/);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /用户已拒绝/);
  assert.doesNotMatch(visibleText, /<function_calls>/);
  assert.doesNotMatch(visibleText, /host_app_launch/);
});

test("assistant runtime intercepts pseudo tool markup from ordinary streamed chat", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const pseudoLaunch = [
    "<function_calls>",
    "<invoke name=\"host_app_launch\">",
    "<arg name=\"app_name_or_path\">claude</arg>",
    "</invoke>",
    "</function_calls>"
  ].join("\n");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.stream, true);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: pseudoLaunch } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let runtime;
  let terminalEvent;
  let asked = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  runtime = new AssistantRuntime(makeApp(root), (event) => {
    events.push(event);
    if (event.type === "awaiting.ask" && !asked) {
      asked = true;
      setImmediate(() => {
        runtime.submitAwaiting({
          awaitingId: event.awaiting.awaitingId,
          action: "reject",
          params: [],
          reason: "test blocks stream pseudo launch"
        });
      });
    }
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  });
  const start = runtime.startRun({
    message: "随便聊聊",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.equal(asked, true);
  assert.equal(events.find((event) => event.type === "awaiting.ask")?.toolName, "host_app_launch");
  const visibleText = visibleContent(events);
  assert.match(visibleText, /用户已拒绝/);
  assert.doesNotMatch(visibleText, /<function_calls>/);
  assert.doesNotMatch(visibleText, /host_app_launch/);
});

test("assistant runtime intercepts pseudo desktop document reads from streamed attachment requests", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  const sourcePath = path.join(root, "Desktop", "report.pdf");
  fs.writeFileSync(sourcePath, makePdfBuffer("附件 PDF 正文"));
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const pick = await createAssistantAttachmentsFromFiles(app, null, [sourcePath]);
  assert.equal(pick.ok, true);

  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    fetchIndex += 1;
    const payload = JSON.parse(String(init.body));
    if (fetchIndex === 1) {
      assert.equal(payload.stream, true);
      const pseudoRead = [
        "PDF 解析遇到了问题，让我用备用方式重新读取：",
        "<result>",
        "<tool_calls>",
        "<invoke name=\"desktop_read_document\">",
        "<parameter name=\"input\">{\"task_name\":\"parse_pdf\",\"filePath\":\"/Users/zhuanzhuan/Downloads/report.pdf\",\"fileType\":\"pdf\"}</parameter>",
        "</invoke>",
        "</result>"
      ].join("\n");
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: pseudoRead } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }

    assert.equal(payload.stream, false);
    assert.ok(payload.messages.some((message) => message.role === "tool" && /附件 PDF 正文/u.test(message.content || "")));
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "这份 PDF 的正文是：附件 PDF 正文。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(app, (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  });

  const start = runtime.startRun({
    chatId: pick.chatId,
    message: "解析一下",
    action: "chat",
    attachments: pick.attachments,
    pageContext: {
      url: "https://www.baidu.com/",
      title: "百度一下",
      selectedText: "",
      metaDescription: "",
      headings: ["百度"],
      bodyText: "百度搜索页面",
      browserTarget: {
        kind: "webview",
        webContentsId: 99,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.equal(fetchIndex, 2);
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "desktop_read_document" && event.status === "ok"));
  const visibleText = visibleContent(events);
  assert.match(visibleText, /附件 PDF 正文/);
  assert.doesNotMatch(visibleText, /<tool_calls>/);
  assert.doesNotMatch(visibleText, /desktop_read_document/);
});

test("assistant runtime naturalizes legacy operator-mode pseudo tools into current permission language", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const pseudoOperatorCall = [
    "我来帮你开启全权接管模式。",
    "<function_calls>",
    "<invoke name=\"operator_mode_request\">",
    "<arg>{\"description\":\"启动容器仓库服务\"}</arg>",
    "</invoke>",
    "</function_calls>"
  ].join("\n");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    if (payload.stream === true) {
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: pseudoOperatorCall } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    assert.equal(payload.stream, false);
    assert.equal(payload.tools.some((tool) => tool.function?.name === "operator_mode_request"), false);
    assert.equal(payload.tools.some((tool) => tool.function?.name === "bash_sandbox"), false);
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "现在只有“询问后操作”和“完全允许控制”两种权限模式，请在输入栏切换。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

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
  });

  const start = runtime.startRun({
    message: "请开启全权接管模式",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.equal(events.some((event) => event.type === "awaiting.ask"), false);
  assert.equal(runtime.getOperatorModeStatus(start.chatId).active, false);
  const visibleText = visibleContent(events);
  assert.doesNotMatch(visibleText, /<function_calls>/);
  assert.doesNotMatch(visibleText, /operator_mode_request/);
  assert.doesNotMatch(visibleText, /全权接管模式已开启/);
  assert.match(visibleText, /询问后操作/);
  assert.match(visibleText, /完全允许控制/);
});

test("assistant runtime uses full access mode to execute generic pseudo browser tools", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    fetchIndex += 1;
    if (payload.stream === true) {
      return new Response([
        "data: {\"choices\":[{\"delta\":{\"content\":\"<function_calls>\"}}]}",
        "",
        "data: [DONE]",
        "",
        ""
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (fetchIndex === 1) {
      assert.ok(payload.tools.some((tool) => tool.function?.name === "browser_click"));
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                "我看到智能助理服务当前是已停止状态。让我点击启动按钮来启动它。",
                "<function_calls>",
                "<invoke name=\"browser_click\">",
                "<parameter name=\"target\">text</parameter>",
                "<parameter name=\"value\">智能助理</parameter>",
                "<parameter name=\"index\">0</parameter>",
                "<parameter name=\"page\">current</parameter>",
                "</invoke>",
                "</function_calls>"
              ].join("\n")
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
            content: "已点击智能助理。"
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
    async click(webContentsId, input) {
      calls.push(["click", webContentsId, input]);
      return {
        ok: true,
        action: "click",
        target: input.target,
        message: `已点击“${input.target}”。`
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
    message: "请帮我启动智能助理",
    action: "chat",
    permissionMode: "full_access",
    pageContext: {
      url: "http://127.0.0.1:5173/#/control-center",
      title: "控制中心",
      selectedText: "",
      metaDescription: "",
      headings: ["控制中心", "智能助理"],
      bodyText: "智能助理 已停止 启动 停止 重启",
      browserTarget: {
        kind: "webview",
        webContentsId: 7
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls, [["click", 7, { target: "智能助理", allowSensitive: true }]]);
  const visibleText = visibleContent(events);
  assert.doesNotMatch(visibleText, /<function_calls>/);
  assert.match(visibleText, /已点击智能助理/);
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

test("desktop tools list, read, write, read documents, and preview organize only allowed Desktop paths", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, "notes.txt"), "hello", "utf8");
  fs.writeFileSync(path.join(desktop, "report.pdf"), makePdfBuffer("桌面 PDF 正文"), "utf8");
  fs.writeFileSync(path.join(desktop, "photo.png"), "png", "utf8");

  const listed = listDesktopFiles(app, {}, null);
  assert.deepEqual(listed.entries.map((entry) => entry.name).sort(), ["notes.txt", "photo.png", "report.pdf"]);

  const read = readDesktopFile(app, { path: "notes.txt" }, null);
  assert.equal(read.content, "hello");
  const documentRead = await readDesktopDocument(app, { path: "report.pdf" }, null);
  assert.match(documentRead.content, /桌面 PDF 正文/);
  assert.equal(documentRead.document.format, "pdf");

  const written = writeDesktopFile(app, {
    filename: "game.html",
    content: "<!doctype html><title>Snake</title>"
  }, null);
  assert.equal(fs.existsSync(written.path), true);
  const renamed = writeDesktopFile(app, {
    path: desktop,
    filename: "game.html",
    content: "<!doctype html><title>Snake v2</title>"
  }, null);
  assert.equal(renamed.renamed, true);
  assert.equal(renamed.requestedPath, path.join(desktop, "game.html"));
  assert.equal(renamed.path, path.join(desktop, "game 1.html"));
  assert.equal(fs.readFileSync(renamed.path, "utf8"), "<!doctype html><title>Snake v2</title>");

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

test("desktop delete tool only deletes allowed Desktop paths", (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, "old.txt"), "old", "utf8");
  fs.writeFileSync(path.join(root, "secret.txt"), "secret", "utf8");

  const result = deleteDesktopFiles(app, { paths: ["old.txt"] }, null);
  assert.deepEqual(result.deleted, [path.join(desktop, "old.txt")]);
  assert.equal(fs.existsSync(path.join(desktop, "old.txt")), false);

  assert.throws(
    () => deleteDesktopFiles(app, { paths: [path.join(root, "secret.txt")] }, null),
    /允许范围/
  );
  assert.equal(fs.existsSync(path.join(root, "secret.txt")), true);
});

test("desktop host command can recover ambiguous kill-port commands", () => {
  assert.match(
    desktopToolInternals.buildPortKillRecoveryCommand("kill 11948", "zsh:kill:1: kill 11948 failed: no such process", "darwin"),
    /lsof -nP -tiTCP:11948 -sTCP:LISTEN/
  );
  assert.match(
    desktopToolInternals.buildPortKillRecoveryCommand("kill -9 11948", "no such process", "darwin"),
    /kill -9 "\$pid"/
  );
  assert.match(
    desktopToolInternals.buildPortKillRecoveryCommand("kill 11948", "no such process", "win32"),
    /Get-NetTCPConnection -LocalPort 11948/
  );
  assert.equal(
    desktopToolInternals.buildPortKillRecoveryCommand("kill 11948", "", "darwin"),
    null
  );
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
  const detail = getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId);
  const assistantMessage = detail.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage.attachments.length, 1);
  assert.equal(assistantMessage.attachments[0].kind, "artifact");
  assert.equal(assistantMessage.attachments[0].name, "snake.html");
});

test("assistant runtime creates Office and PDF files as artifact attachments", async (t) => {
  const cases = [
    {
      toolName: "desktop_create_docx",
      filename: "joke.docx",
      args: {
        filename: "joke",
        title: "今日笑话",
        content: "一只蚂蚁从喜马拉雅山顶滚下来。",
        contentFormat: "plain"
      }
    },
    {
      toolName: "desktop_create_pdf",
      filename: "brief.pdf",
      args: {
        filename: "brief",
        title: "简报",
        content: "PDF 正文",
        contentFormat: "plain"
      }
    },
    {
      toolName: "desktop_create_xlsx",
      filename: "scores.xlsx",
      args: {
        filename: "scores",
        title: "成绩",
        sheets: [{ name: "Sheet A", headers: ["姓名", "分数"], rows: [["Alice", 98]] }]
      }
    },
    {
      toolName: "desktop_create_pptx",
      filename: "deck.pptx",
      args: {
        filename: "deck",
        title: "演示",
        slides: [{ title: "第一页", body: "摘要", bullets: ["要点一"] }]
      }
    }
  ];

  for (const item of cases) {
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
      const toolNames = payload.tools.map((tool) => tool.function?.name);
      for (const expected of ["desktop_create_docx", "desktop_create_pdf", "desktop_create_xlsx", "desktop_create_pptx"]) {
        assert.ok(toolNames.includes(expected), `${expected} should be exposed`);
      }
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
                    id: `tool_${item.toolName}`,
                    type: "function",
                    function: {
                      name: item.toolName,
                      arguments: JSON.stringify(item.args)
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
              content: `已生成 ${item.filename}。`
            }
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

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
      }, undefined, {
        renderPdf: async () => Buffer.from("%PDF-1.4\n% runtime test pdf\n", "utf8")
      });
    });

    try {
      const start = runtime.startRun({
        message: `请生成 ${item.filename}`,
        action: "chat"
      });
      assert.equal(start.ok, true);
      await done;

      assert.equal(fs.existsSync(path.join(root, "Desktop", item.filename)), true);
      assert.ok(events.some((event) => event.type === "awaiting.ask" && event.awaiting?.mode === "approval"));
      assert.ok(events.some((event) => event.type === "artifact.publish"));
      assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === item.toolName && event.status === "ok"));
      const detail = getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId);
      const assistantMessage = detail.messages.find((message) => message.role === "assistant");
      assert.equal(assistantMessage.attachments.length, 1);
      assert.equal(assistantMessage.attachments[0].kind, "artifact");
      assert.equal(assistantMessage.attachments[0].name, item.filename);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("assistant runtime does not turn explicit PDF creation into a browser search", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    assert.ok(toolNames.includes("desktop_create_pdf"));
    assert.equal(toolNames.some((name) => String(name).startsWith("browser_")), false);
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tool_pdf",
                type: "function",
                function: {
                  name: "desktop_create_pdf",
                  arguments: JSON.stringify({
                    filename: "今日热点",
                    title: "今日热点",
                    content: "今日热点 PDF 内容",
                    contentFormat: "plain"
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

  const browserUse = {
    async fillBestInputAndSubmit() {
      throw new Error("explicit PDF creation should not start a browser search");
    },
    async readPageContext() {
      throw new Error("explicit PDF creation should not read browser results");
    }
  };
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
    }, browserUse, {
      renderPdf: async () => Buffer.from("%PDF-1.4\n% explicit pdf test\n", "utf8")
    });
  });

  const start = runtime.startRun({
    message: "请给我生成一个今日热点的 PDF。",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
      title: "今日热点_百度搜索",
      selectedText: "",
      metaDescription: "",
      headings: ["百度热搜"],
      bodyText: "百度搜索页面",
      browserTarget: {
        kind: "webview",
        webContentsId: 77,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(fs.existsSync(path.join(root, "Desktop", "今日热点.pdf")), true);
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "desktop_create_pdf" && event.status === "ok"));
  assert.ok(events.every((event) => event.toolName !== "browser_runtime_execute"));
});

test("assistant runtime keeps an office-content follow-up on desktop document tools", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });
  const assistantRoot = path.join(root, "assistant");
  const chat = appendAssistantMessageToRoot(assistantRoot, null, createAssistantMessage("user", "请帮我生成一个Excel文档。"));
  appendAssistantMessageToRoot(
    assistantRoot,
    chat.summary.id,
    createAssistantMessage("assistant", "好的！请告诉我你想要什么内容的 Excel 文档？比如：今日热点热搜榜。你希望包含哪些数据？")
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    assert.ok(toolNames.includes("desktop_create_xlsx"));
    assert.equal(toolNames.some((name) => String(name).startsWith("browser_")), false);
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tool_xlsx",
                type: "function",
                function: {
                  name: "desktop_create_xlsx",
                  arguments: JSON.stringify({
                    filename: "今日热点",
                    title: "今日热点",
                    sheets: [
                      {
                        name: "今日热点",
                        headers: ["序号", "标题"],
                        rows: [[1, "今日热点"]]
                      }
                    ]
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

  const browserUse = {
    async fillBestInputAndSubmit() {
      throw new Error("office follow-up should not start a browser search");
    },
    async readPageContext() {
      throw new Error("office follow-up should not read browser results");
    }
  };
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
    }, browserUse);
  });

  const start = runtime.startRun({
    chatId: chat.summary.id,
    message: "今日热点",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9",
      title: "今日热点_百度搜索",
      selectedText: "",
      metaDescription: "",
      headings: ["百度热搜"],
      bodyText: "百度搜索页面",
      browserTarget: {
        kind: "webview",
        webContentsId: 88,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/s?wd=%E4%BB%8A%E6%97%A5%E7%83%AD%E7%82%B9"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(fs.existsSync(path.join(root, "Desktop", "今日热点.xlsx")), true);
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "desktop_create_xlsx" && event.status === "ok"));
  assert.ok(events.every((event) => event.toolName !== "browser_runtime_execute"));
});

test("assistant runtime routes document reading to desktop document tools without browser search", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  fs.writeFileSync(path.join(root, "Desktop", "report.pdf"), makePdfBuffer("路由 PDF 正文"));
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    const toolNames = payload.tools.map((tool) => tool.function?.name);
    assert.ok(toolNames.includes("desktop_read_document"));
    assert.equal(toolNames.some((name) => String(name).startsWith("browser_")), false);
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
                  id: "tool_read_document",
                  type: "function",
                  function: {
                    name: "desktop_read_document",
                    arguments: JSON.stringify({ path: "report.pdf" })
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
            content: "这份 PDF 的正文是：路由 PDF 正文。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const browserUse = {
    async fillBestInputAndSubmit() {
      throw new Error("document reading should not start a browser search");
    },
    async readPageContext() {
      throw new Error("document reading should not read browser results");
    }
  };
  const events = [];
  let runtime;
  const done = new Promise((resolve) => {
    runtime = new AssistantRuntime(app, (event) => {
      events.push(event);
      if (event.type === "run.complete") {
        resolve();
      }
    }, browserUse);
  });

  const start = runtime.startRun({
    message: "请读取桌面 report.pdf 并总结",
    action: "chat",
    pageContext: {
      url: "https://www.baidu.com/s?wd=report.pdf",
      title: "report.pdf_百度搜索",
      selectedText: "",
      metaDescription: "",
      headings: ["百度搜索"],
      bodyText: "百度搜索页面",
      browserTarget: {
        kind: "webview",
        webContentsId: 91,
        surfaceLabel: "百度",
        currentUrl: "https://www.baidu.com/s?wd=report.pdf"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.ok(events.some((event) => event.type === "tool.result" && event.toolName === "desktop_read_document" && event.status === "ok"));
  assert.ok(events.every((event) => event.toolName !== "browser_runtime_execute"));
  assert.match(visibleContent(events), /路由 PDF 正文/);
});

test("assistant runtime publishes legacy artifact paths into assistant message attachments", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  fs.writeFileSync(path.join(root, "Desktop", "joke.docx"), "docx bytes", "utf8");
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.ok(payload.tools.some((tool) => tool.function?.name === "artifact_publish"));
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
                  id: "tool_artifact_legacy",
                  type: "function",
                  function: {
                    name: "artifact_publish",
                    arguments: JSON.stringify({
                      title: "笑话 Word 文档",
                      path: "joke.docx",
                      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      description: "今天的笑话"
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
            content: "已生成以下产物。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(app, (event) => {
    events.push(event);
    if (event.type === "run.complete") {
      resolveDone();
    }
  });

  const start = runtime.startRun({
    message: "把桌面的 joke.docx 作为产物发布到聊天里",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  const detail = getAssistantChatFromRoot(path.join(root, "assistant"), start.chatId);
  const assistantMessage = detail.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage.attachments.length, 1);
  assert.equal(assistantMessage.attachments[0].kind, "artifact");
  assert.equal(assistantMessage.attachments[0].name, "joke.docx");
  assert.equal(assistantMessage.attachments[0].artifactId, "tool_artifact_legacy");
  assert.equal(assistantMessage.attachments[0].description, "今天的笑话");
  assert.match(assistantMessage.attachments[0].sha256, /^[a-f0-9]{64}$/);
  const artifactEvent = events.find((event) => event.type === "artifact.publish");
  assert.equal(artifactEvent.artifactCount, 1);
  assert.equal(artifactEvent.artifacts.length, 1);
  assert.equal(artifactEvent.artifacts[0].url, `assistant://attachment/${start.chatId}/${assistantMessage.attachments[0].id}`);
  assert.equal(artifactEvent.data.artifacts.length, 1);
  assert.equal(artifactEvent.data.artifacts[0].attachmentId, assistantMessage.attachments[0].id);
});

test("assistant runtime publishes ZenMind artifact arrays from chat workspace", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  const chatId = "chat_workspace_artifact";
  const workspace = path.join(root, "assistant", "chats", chatId, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "demo.docx"), "workspace docx", "utf8");
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  let fetchIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.ok(payload.tools.some((tool) => tool.function?.name === "artifact_publish"));
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
                  id: "tool_artifact_array",
                  type: "function",
                  function: {
                    name: "artifact_publish",
                    arguments: JSON.stringify({
                      artifacts: [
                        {
                          artifactId: "artifact_demo",
                          path: "/workspace/demo.docx",
                          name: "demo.docx",
                          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                          description: "工作区文档"
                        }
                      ]
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
            content: ""
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(app, (event) => {
    if (event.type === "run.complete") {
      resolveDone();
    }
  });

  const start = runtime.startRun({
    chatId,
    message: "发布工作区文档产物",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  const detail = getAssistantChatFromRoot(path.join(root, "assistant"), chatId);
  const assistantMessage = detail.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage.content, "已生成以下产物。");
  assert.equal(assistantMessage.attachments.length, 1);
  assert.equal(assistantMessage.attachments[0].kind, "artifact");
  assert.equal(assistantMessage.attachments[0].artifactId, "artifact_demo");
  assert.equal(assistantMessage.attachments[0].name, "demo.docx");
});

test("assistant runtime routes local HTML generation to desktop tools even with a browser target", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.ok(payload.tools.some((tool) => tool.function?.name === "desktop_write_file"));
    assert.equal(payload.tools.some((tool) => tool.function?.name === "browser_click"), false);
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "我会生成 HTML 文件到桌面，而不是点击当前网页。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  let terminalEvent;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = new AssistantRuntime(app, (event) => {
    events.push(event);
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      resolveDone();
    }
  }, {
    async click() {
      throw new Error("local HTML generation should not click the current page");
    }
  });

  const start = runtime.startRun({
    message: "你给我写个超级玛丽放在桌面上，并打开浏览器运行，我直接去玩。这个超级玛丽的 HTML 文件我要求用英文来写，例如超级玛丽.html。",
    action: "chat",
    pageContext: {
      url: "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3",
      title: "抖音热门歌曲 - Google Search",
      selectedText: "",
      metaDescription: "",
      headings: ["抖音热门歌曲"],
      bodyText: "抖音热门歌曲",
      browserTarget: {
        kind: "webview",
        webContentsId: 23,
        surfaceLabel: "Google",
        currentUrl: "https://www.google.com/search?q=%E6%8A%96%E9%9F%B3"
      }
    }
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.doesNotMatch(visibleContent(events), /当前网页没有找到可点击/);
});

test("assistant runtime waits for HITL before deleting Desktop files", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  fs.writeFileSync(path.join(root, "Desktop", "old.txt"), "old", "utf8");
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
    assert.ok(payload.tools.some((tool) => tool.function?.name === "desktop_delete_files"));
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
                  id: "tool_delete",
                  type: "function",
                  function: {
                    name: "desktop_delete_files",
                    arguments: JSON.stringify({
                      paths: ["old.txt"]
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
            content: "已删除 old.txt。"
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
        assert.equal(event.toolName, "desktop_delete_files");
        assert.match(event.awaiting?.approval?.risk ?? "", /删除/);
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
    message: "删除桌面 old.txt",
    action: "chat"
  });
  assert.equal(start.ok, true);
  await done;

  assert.equal(fs.existsSync(path.join(root, "Desktop", "old.txt")), false);
  assert.ok(events.some((event) => event.type === "awaiting.ask" && event.awaiting?.mode === "approval"));
  assert.ok(events.some((event) => event.type === "awaiting.answer"));
});

test("assistant runtime reuses full access grant to skip Desktop delete HITL for 10 minutes", async (t) => {
  const root = makeTempRoot(t);
  const app = makeApp(root);
  fs.mkdirSync(path.join(root, "Desktop"), { recursive: true });
  fs.writeFileSync(path.join(root, "Desktop", "old-1.txt"), "old 1", "utf8");
  fs.writeFileSync(path.join(root, "Desktop", "old-2.txt"), "old 2", "utf8");
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
    assert.ok(payload.tools.some((tool) => tool.function?.name === "desktop_delete_files"));
    fetchIndex += 1;
    if (fetchIndex === 1 || fetchIndex === 3) {
      const target = fetchIndex === 1 ? "old-1.txt" : "old-2.txt";
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: `tool_delete_${fetchIndex}`,
                  type: "function",
                  function: {
                    name: "desktop_delete_files",
                    arguments: JSON.stringify({
                      paths: [target]
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
            content: "已删除。"
          }
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const events = [];
  const waitForRunComplete = () => new Promise((resolve) => {
    const startIndex = events.length;
    const timer = setInterval(() => {
      if (events.slice(startIndex).some((event) => event.type === "run.complete")) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
  const runtime = new AssistantRuntime(app, (event) => {
    events.push(event);
  });

  const firstDone = waitForRunComplete();
  const first = runtime.startRun({
    message: "删除桌面 old-1.txt",
    action: "chat",
    permissionMode: "full_access"
  });
  assert.equal(first.ok, true);
  assert.equal(first.permissionMode, "full_access");
  assert.ok((first.fullAccessRemainingMs ?? 0) > 0);
  await firstDone;

  const secondDone = waitForRunComplete();
  const second = runtime.startRun({
    chatId: first.chatId,
    message: "删除桌面 old-2.txt",
    action: "chat"
  });
  assert.equal(second.ok, true);
  assert.equal(second.permissionMode, "full_access");
  assert.ok((second.fullAccessRemainingMs ?? 0) > 0);
  await secondDone;

  assert.equal(fs.existsSync(path.join(root, "Desktop", "old-1.txt")), false);
  assert.equal(fs.existsSync(path.join(root, "Desktop", "old-2.txt")), false);
  assert.equal(events.some((event) => event.type === "awaiting.ask"), false);
});

test("assistant runtime reports startup item partial removal from verification results", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("startup item removal should use deterministic tools, not model guesses");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const items = [
    { id: "mac_login_item:poe", name: "POE", source: "mac_login_item", enabled: true, removable: true, requiresAdmin: false, platform: "darwin" },
    { id: "mac_login_item:minimax", name: "MiniMax Agent", source: "mac_login_item", enabled: true, removable: true, requiresAdmin: false, platform: "darwin" },
    { id: "mac_login_item:claude", name: "Claude Island", source: "mac_login_item", enabled: true, removable: true, requiresAdmin: false, platform: "darwin" },
    { id: "mac_login_item:figma", name: "FigmaAgent", source: "mac_login_item", enabled: true, removable: true, requiresAdmin: false, platform: "darwin" }
  ];
  const remaining = items.slice(1);
  const calls = [];
  const startupItems = {
    async list() {
      calls.push(["list"]);
      return {
        ok: true,
        platform: "darwin",
        items,
        message: "已读取开机启动项。"
      };
    },
    async remove(input) {
      calls.push(["remove", input.targets]);
      return {
        ok: false,
        platform: "darwin",
        requestedTargets: input.targets,
        removed: [items[0]],
        failed: [
          { target: "MiniMax Agent", item: items[1], reason: "复查仍存在，未确认移除。" },
          { target: "Claude Island", item: items[2], reason: "复查仍存在，未确认移除。" },
          { target: "FigmaAgent", item: items[3], reason: "复查仍存在，未确认移除。" }
        ],
        remaining,
        verification: {
          beforeCount: 4,
          afterCount: 3,
          removedCount: 1,
          failedCount: 3
        },
        message: "已移除 1 项，3 项未确认移除。"
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
  }, undefined, { startupItems });

  const start = runtime.startRun({
    message: "帮我移除开机启动项 POE、MiniMax Agent、Claude Island 和 FigmaAgent",
    action: "chat",
    permissionMode: "full_access"
  });
  assert.equal(start.ok, true);
  await done;

  assert.notEqual(terminalEvent?.type, "run.error", terminalEvent?.error);
  assert.deepEqual(calls, [
    ["list"],
    ["remove", ["POE", "MiniMax Agent", "Claude Island", "FigmaAgent"]]
  ]);
  const visibleText = visibleContent(events);
  assert.match(visibleText, /POE/);
  assert.match(visibleText, /MiniMax Agent/);
  assert.match(visibleText, /Claude Island/);
  assert.match(visibleText, /FigmaAgent/);
  assert.doesNotMatch(visibleText, /剩余启动项[：:]\s*无|当前剩余启动项[：:]\s*无/);
});

test("assistant runtime asks user to choose startup items when removal target is missing", async (t) => {
  const root = makeTempRoot(t);
  saveAssistantSettingsToRoot(path.join(root, "assistant"), {
    baseURL: "https://example.com/v1",
    model: "demo-model",
    apiKey: "sk-secret"
  });

  const startupItems = {
    async list() {
      return {
        ok: true,
        platform: "darwin",
        items: [
          { id: "mac_login_item:poe", name: "POE", source: "mac_login_item", enabled: true, removable: true, requiresAdmin: false, platform: "darwin" },
          { id: "mac_login_item:minimax", name: "MiniMax Agent", source: "mac_login_item", enabled: true, removable: true, requiresAdmin: false, platform: "darwin" }
        ],
        message: "已读取开机启动项。"
      };
    },
    async remove() {
      throw new Error("should wait for user selection before removing startup items");
    }
  };

  const events = [];
  let runtime;
  let start;
  const awaiting = new Promise((resolve) => {
    runtime = new AssistantRuntime(makeApp(root), (event) => {
      events.push(event);
      if (event.type === "awaiting.ask") {
        resolve(event);
      }
    }, undefined, { startupItems });
  });

  start = runtime.startRun({
    message: "帮我移除开机启动项",
    action: "chat"
  });
  assert.equal(start.ok, true);
  const event = await awaiting;
  assert.equal(event.awaiting?.mode, "question");
  assert.equal(event.toolName, "host_startup_remove");
  const options = event.awaiting?.questions?.[0]?.options ?? [];
  assert.deepEqual(options.map((option) => option.label), ["POE", "MiniMax Agent"]);
  const stop = runtime.stopRun(start.runId);
  assert.equal(stop.ok, true);
  assert.ok(events.some((item) => item.type === "awaiting.ask"));
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
