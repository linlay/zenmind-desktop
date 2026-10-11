import { parentPort, workerData } from "node:worker_threads";
import { renderLocalMarkdown } from "./local-document-markdown";
import {
  LOCAL_MARKDOWN_MAX_BYTES,
  LOCAL_MARKDOWN_MAX_HTML_BYTES,
  type LocalMarkdownWorkerRequest,
  type LocalMarkdownWorkerResponse,
} from "./local-document-worker-contract";

const port = parentPort;
const request = workerData as LocalMarkdownWorkerRequest | undefined;
if (port && request?.mode === "local-markdown-render") {
  let response: LocalMarkdownWorkerResponse;
  try {
    if (!(request.bytes instanceof Uint8Array) || typeof request.fileName !== "string") {
      throw new Error("Invalid local Markdown render request.");
    }
    if (request.bytes.byteLength > LOCAL_MARKDOWN_MAX_BYTES) {
      response = { ok: false, code: "too_large" };
    } else {
      const html = renderLocalMarkdown(request.bytes, request.fileName);
      response = Buffer.byteLength(html, "utf8") > LOCAL_MARKDOWN_MAX_HTML_BYTES
        ? { ok: false, code: "too_large" }
        : { ok: true, html };
    }
  } catch {
    response = { ok: false, code: "render_failed" };
  }
  port.postMessage(response);
  port.close();
}
