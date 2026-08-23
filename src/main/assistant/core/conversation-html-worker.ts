import { parentPort, workerData } from "node:worker_threads";
import { TextDecoder } from "node:util";
import { isLoopbackHostname } from "../../loopback-url";
import {
  isTunnelHubForbiddenHostname,
  isTunnelHubLoopbackHostname
} from "../../tunnel-hub-url-policy";
import {
  CONVERSATION_EXPORT_ASSET_ORIGIN_MARKER,
  CONVERSATION_EXPORT_SNAPSHOT_MARKER,
  CONVERSATION_EXPORT_TEMPLATE_PATH,
  MAX_CONVERSATION_HTML_BYTES,
  MAX_CONVERSATION_SNAPSHOT_BYTES,
  MAX_CONVERSATION_TEMPLATE_BYTES,
  type ConversationHtmlWorkerErrorCode,
  type RenderConversationHtmlFailure,
  type RenderConversationHtmlRequest,
  type RenderConversationHtmlResponse
} from "./conversation-export-contract";

const SNAPSHOT_MARKER = Buffer.from(CONVERSATION_EXPORT_SNAPSHOT_MARKER);
const ASSET_ORIGIN_MARKER = Buffer.from(CONVERSATION_EXPORT_ASSET_ORIGIN_MARKER);
const SNAPSHOT_TIMEOUT_MS = 15_000;
const TEMPLATE_TIMEOUT_MS = 5_000;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type TemplateMarker = {
  kind: "snapshot" | "assetOrigin";
  offset: number;
  length: number;
};

export type ParsedConversationHtmlTemplate = {
  bytes: Buffer;
  markers: TemplateMarker[];
  staticBytes: number;
  assetOriginMarkers: number;
};

type CachedTemplate = {
  key: string;
  parsed: ParsedConversationHtmlTemplate;
};

type SnapshotResponse = {
  bytes: Buffer;
  filename: string;
};

class ConversationHtmlRenderFailure extends Error {
  constructor(
    readonly code: ConversationHtmlWorkerErrorCode,
    readonly actualBytes?: number,
    readonly limitBytes?: number
  ) {
    super(code);
    this.name = "ConversationHtmlRenderFailure";
  }
}

const ESCAPES = [
  { needle: Buffer.from("<"), replacement: Buffer.from("\\u003c") },
  { needle: Buffer.from(">"), replacement: Buffer.from("\\u003e") },
  { needle: Buffer.from("&"), replacement: Buffer.from("\\u0026") },
  { needle: Buffer.from([0xe2, 0x80, 0xa8]), replacement: Buffer.from("\\u2028") },
  { needle: Buffer.from([0xe2, 0x80, 0xa9]), replacement: Buffer.from("\\u2029") }
] as const;

let cachedTemplate: CachedTemplate | null = null;

export function parseConversationHtmlTemplate(bytes: Buffer): ParsedConversationHtmlTemplate {
  if (bytes.length === 0 || bytes.length > MAX_CONVERSATION_TEMPLATE_BYTES) {
    throw new ConversationHtmlRenderFailure("template_invalid");
  }
  try {
    STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    throw new ConversationHtmlRenderFailure("template_invalid");
  }
  const markers: TemplateMarker[] = [];
  let cursor = 0;
  let snapshotMarkers = 0;
  let assetOriginMarkers = 0;
  let markerBytes = 0;
  while (cursor < bytes.length) {
    const snapshotOffset = bytes.indexOf(SNAPSHOT_MARKER, cursor);
    const assetOriginOffset = bytes.indexOf(ASSET_ORIGIN_MARKER, cursor);
    if (snapshotOffset < 0 && assetOriginOffset < 0) break;
    const snapshotNext = snapshotOffset >= 0 &&
      (assetOriginOffset < 0 || snapshotOffset < assetOriginOffset);
    const marker = snapshotNext
      ? { kind: "snapshot" as const, offset: snapshotOffset, length: SNAPSHOT_MARKER.length }
      : { kind: "assetOrigin" as const, offset: assetOriginOffset, length: ASSET_ORIGIN_MARKER.length };
    markers.push(marker);
    markerBytes += marker.length;
    if (marker.kind === "snapshot") snapshotMarkers += 1;
    else assetOriginMarkers += 1;
    cursor = marker.offset + marker.length;
  }
  if (snapshotMarkers !== 1 || assetOriginMarkers < 1) {
    throw new ConversationHtmlRenderFailure("template_invalid");
  }
  return {
    bytes,
    markers,
    staticBytes: bytes.length - markerBytes,
    assetOriginMarkers
  };
}

export function assembleConversationHtml(
  template: ParsedConversationHtmlTemplate,
  snapshot: Buffer,
  assetOrigin: string
): ArrayBuffer {
  const normalizedAssetOrigin = requireAssetOrigin(assetOrigin);
  const assetOriginBytes = Buffer.from(normalizedAssetOrigin);
  const escapedSnapshotBytes = measureEscapedSnapshotBytes(
    snapshot,
    MAX_CONVERSATION_HTML_BYTES - template.staticBytes -
      template.assetOriginMarkers * assetOriginBytes.length
  );
  const finalSize = template.staticBytes + escapedSnapshotBytes +
    template.assetOriginMarkers * assetOriginBytes.length;
  if (finalSize <= 0 || finalSize > MAX_CONVERSATION_HTML_BYTES) {
    throw new ConversationHtmlRenderFailure(
      "too_large",
      finalSize,
      MAX_CONVERSATION_HTML_BYTES
    );
  }

  const output = new ArrayBuffer(finalSize);
  const outputBytes = Buffer.from(output);
  let templateCursor = 0;
  let outputCursor = 0;
  for (const marker of template.markers) {
    outputCursor += template.bytes.copy(
      outputBytes,
      outputCursor,
      templateCursor,
      marker.offset
    );
    if (marker.kind === "snapshot") {
      outputCursor = writeEscapedSnapshot(snapshot, outputBytes, outputCursor);
    } else {
      outputCursor += assetOriginBytes.copy(outputBytes, outputCursor);
    }
    templateCursor = marker.offset + marker.length;
  }
  outputCursor += template.bytes.copy(outputBytes, outputCursor, templateCursor);
  if (outputCursor !== finalSize) {
    throw new ConversationHtmlRenderFailure("worker_failed");
  }
  return output;
}

export async function fetchLimitedResponse(input: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  expectedContentType: string;
  unavailableCode: ConversationHtmlWorkerErrorCode;
  invalidCode: ConversationHtmlWorkerErrorCode;
}): Promise<{ response: Response; bytes: Buffer }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  timeout.unref?.();
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "GET",
      headers: input.headers,
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      if (input.unavailableCode === "snapshot_unavailable" &&
        (response.status === 401 || response.status === 403)) {
        throw new ConversationHtmlRenderFailure("snapshot_unauthorized");
      }
      throw new ConversationHtmlRenderFailure(input.unavailableCode);
    }
    const contentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== input.expectedContentType) {
      throw new ConversationHtmlRenderFailure(input.invalidCode);
    }
    const rawLength = response.headers.get("content-length")?.trim() || "";
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
      throw new ConversationHtmlRenderFailure(input.invalidCode);
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength)) {
      throw new ConversationHtmlRenderFailure(input.invalidCode);
    }
    if (declaredLength > input.maxBytes) {
      throw new ConversationHtmlRenderFailure("too_large", declaredLength, input.maxBytes);
    }
    const bytes = await readExactResponseBody(
      response,
      declaredLength,
      input.maxBytes,
      input.invalidCode
    );
    return { response, bytes };
  } catch (error) {
    controller.abort();
    if (error instanceof ConversationHtmlRenderFailure) throw error;
    throw new ConversationHtmlRenderFailure(input.unavailableCode);
  } finally {
    clearTimeout(timeout);
  }
}

async function readExactResponseBody(
  response: Response,
  declaredLength: number,
  maximumLength: number,
  invalidCode: ConversationHtmlWorkerErrorCode
): Promise<Buffer> {
  if (!response.body) {
    if (declaredLength === 0) return Buffer.alloc(0);
    throw new ConversationHtmlRenderFailure(invalidCode);
  }
  const storage = new ArrayBuffer(declaredLength);
  const target = new Uint8Array(storage);
  const reader = response.body.getReader();
  let actualLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextLength = actualLength + value.byteLength;
      if (nextLength > maximumLength) {
        throw new ConversationHtmlRenderFailure("too_large", nextLength, maximumLength);
      }
      if (nextLength > declaredLength) {
        throw new ConversationHtmlRenderFailure(invalidCode);
      }
      target.set(value, actualLength);
      actualLength = nextLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  if (actualLength !== declaredLength) {
    throw new ConversationHtmlRenderFailure(invalidCode);
  }
  return Buffer.from(storage);
}

async function loadSnapshot(request: RenderConversationHtmlRequest): Promise<SnapshotResponse> {
  const snapshotURL = requireLoopbackURL(request.snapshotUrl, "/api/chat/export");
  if (snapshotURL.searchParams.get("format") !== "snapshot" ||
    !snapshotURL.searchParams.get("chatId")) {
    throw new ConversationHtmlRenderFailure("request_invalid");
  }
  if (!request.bearerToken.trim() || /\s/u.test(request.bearerToken)) {
    throw new ConversationHtmlRenderFailure("request_invalid");
  }
  const { response, bytes } = await fetchLimitedResponse({
    url: snapshotURL.toString(),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${request.bearerToken}`
    },
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    maxBytes: MAX_CONVERSATION_SNAPSHOT_BYTES,
    expectedContentType: "application/json",
    unavailableCode: "snapshot_unavailable",
    invalidCode: "snapshot_invalid"
  });
  return {
    bytes,
    filename: htmlFilename(
      response.headers.get("content-disposition"),
      snapshotURL.searchParams.get("chatId") || "conversation"
    )
  };
}

async function loadTemplate(request: RenderConversationHtmlRequest): Promise<ParsedConversationHtmlTemplate> {
  const templateURL = requireLoopbackURL(request.templateUrl, CONVERSATION_EXPORT_TEMPLATE_PATH);
  if (templateURL.search || templateURL.hash || !request.templateCacheKey.trim()) {
    throw new ConversationHtmlRenderFailure("request_invalid");
  }
  if (cachedTemplate?.key === request.templateCacheKey) {
    return cachedTemplate.parsed;
  }
  const { bytes } = await fetchLimitedResponse({
    url: templateURL.toString(),
    headers: { Accept: "text/html" },
    timeoutMs: TEMPLATE_TIMEOUT_MS,
    maxBytes: MAX_CONVERSATION_TEMPLATE_BYTES,
    expectedContentType: "text/html",
    unavailableCode: "template_unavailable",
    invalidCode: "template_invalid"
  });
  const parsed = parseConversationHtmlTemplate(bytes);
  cachedTemplate = { key: request.templateCacheKey, parsed };
  return parsed;
}

async function renderConversationHtml(
  request: RenderConversationHtmlRequest
): Promise<RenderConversationHtmlResponse> {
  try {
    if (!request.requestId?.trim()) {
      throw new ConversationHtmlRenderFailure("request_invalid");
    }
    const snapshotPromise = loadSnapshot(request);
    const templatePromise = loadTemplate(request);
    const [snapshot, template] = await Promise.all([snapshotPromise, templatePromise]);
    const html = assembleConversationHtml(template, snapshot.bytes, request.assetOrigin);
    return {
      type: "result",
      requestId: request.requestId,
      filename: snapshot.filename,
      html
    };
  } catch (error) {
    return failureResponse(request.requestId, error);
  }
}

function requireLoopbackURL(value: string, expectedPath: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConversationHtmlRenderFailure("request_invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !isLoopbackHostname(parsed.hostname) || parsed.username || parsed.password ||
    parsed.pathname !== expectedPath || parsed.hash) {
    throw new ConversationHtmlRenderFailure("request_invalid");
  }
  return parsed;
}

function requireAssetOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ConversationHtmlRenderFailure("request_invalid");
  }
  const loopback = isTunnelHubLoopbackHostname(parsed.hostname);
  if (value.trim() !== parsed.origin || parsed.username || parsed.password ||
    isTunnelHubForbiddenHostname(parsed.hostname) ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
    throw new ConversationHtmlRenderFailure("request_invalid");
  }
  return parsed.origin;
}

function measureEscapedSnapshotBytes(snapshot: Buffer, maximum: number): number {
  let escapedBytes = snapshot.length;
  if (escapedBytes > maximum) {
    throw new ConversationHtmlRenderFailure("too_large", escapedBytes, MAX_CONVERSATION_HTML_BYTES);
  }
  for (const escape of ESCAPES) {
    let cursor = 0;
    while (cursor < snapshot.length) {
      const offset = snapshot.indexOf(escape.needle, cursor);
      if (offset < 0) break;
      escapedBytes += escape.replacement.length - escape.needle.length;
      if (escapedBytes > maximum) {
        throw new ConversationHtmlRenderFailure("too_large", escapedBytes, MAX_CONVERSATION_HTML_BYTES);
      }
      cursor = offset + escape.needle.length;
    }
  }
  return escapedBytes;
}

function writeEscapedSnapshot(snapshot: Buffer, output: Buffer, start: number): number {
  let inputCursor = 0;
  let outputCursor = start;
  while (inputCursor < snapshot.length) {
    let nextOffset = -1;
    let nextEscape: (typeof ESCAPES)[number] | undefined;
    for (const escape of ESCAPES) {
      const offset = snapshot.indexOf(escape.needle, inputCursor);
      if (offset >= 0 && (nextOffset < 0 || offset < nextOffset)) {
        nextOffset = offset;
        nextEscape = escape;
      }
    }
    if (nextOffset < 0 || !nextEscape) break;
    outputCursor += snapshot.copy(output, outputCursor, inputCursor, nextOffset);
    outputCursor += nextEscape.replacement.copy(output, outputCursor);
    inputCursor = nextOffset + nextEscape.needle.length;
  }
  outputCursor += snapshot.copy(output, outputCursor, inputCursor);
  return outputCursor;
}

function htmlFilename(contentDisposition: string | null, fallbackChatID: string): string {
  const header = String(contentDisposition || "");
  const utf8Match = /filename\*=UTF-8''([^;]+)/iu.exec(header);
  const quotedMatch = /filename="([^"]+)"/iu.exec(header);
  let filename = quotedMatch?.[1]?.trim() || "";
  if (utf8Match?.[1]) {
    try {
      filename = decodeURIComponent(utf8Match[1].trim());
    } catch {
      filename = utf8Match[1].trim();
    }
  }
  if (/\.snapshot\.json$/iu.test(filename)) {
    filename = filename.replace(/\.snapshot\.json$/iu, ".html");
  } else {
    filename = `${fallbackChatID}.html`;
  }
  const safe = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim();
  return safe && /\.html$/iu.test(safe) ? safe : "conversation.html";
}

function failureResponse(requestId: string, error: unknown): RenderConversationHtmlFailure {
  const failure = error instanceof ConversationHtmlRenderFailure
    ? error
    : new ConversationHtmlRenderFailure("worker_failed");
  return {
    type: "error",
    requestId: typeof requestId === "string" ? requestId : "",
    code: failure.code,
    ...(failure.actualBytes === undefined ? {} : { actualBytes: failure.actualBytes }),
    ...(failure.limitBytes === undefined ? {} : { limitBytes: failure.limitBytes })
  };
}

let queue = Promise.resolve();
const workerPort = parentPort;
const isRenderWorker = (workerData as { mode?: unknown } | null)?.mode === "conversation-html-render";
if (workerPort && isRenderWorker) workerPort.on("message", (request: RenderConversationHtmlRequest) => {
  queue = queue.then(async () => {
    const response = await renderConversationHtml(request);
    if (response.type === "result") {
      workerPort.postMessage(response, [response.html]);
      return;
    }
    workerPort.postMessage(response);
  });
});
