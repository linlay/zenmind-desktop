export const LOCAL_MARKDOWN_MAX_BYTES = 8 * 1024 * 1024;
export const LOCAL_MARKDOWN_MAX_HTML_BYTES = 32 * 1024 * 1024;
export const LOCAL_MARKDOWN_RENDER_TIMEOUT_MS = 15_000;

export type LocalMarkdownWorkerRequest = {
  mode: "local-markdown-render";
  bytes: Uint8Array;
  fileName: string;
};

export type LocalMarkdownWorkerResponse =
  | { ok: true; html: string }
  | { ok: false; code: "too_large" | "render_failed" };
