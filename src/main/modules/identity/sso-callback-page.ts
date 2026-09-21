import { RETURN_TO_APP_PATH } from "./sso-defaults";
import http from "node:http";

export function renderCallbackHtml(title: string, message: string, options: {
  actionHref?: string;
  actionLabel?: string;
} = {}) {
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);
  const actionHref = options.actionHref?.trim() || "";
  const actionLabel = options.actionLabel?.trim() || "";
  const actionHtml = actionHref && actionLabel
    ? `<a class="primary-action" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #162033; }
    main { width: min(520px, calc(100vw - 48px)); padding: 32px; border: 1px solid #d9e2ef; border-radius: 16px; background: #fff; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12); }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.25; }
    p { margin: 0; font-size: 15px; line-height: 1.7; color: #44546a; }
    .primary-action { display: inline-flex; align-items: center; justify-content: center; margin-top: 24px; min-height: 42px; padding: 0 18px; border-radius: 8px; background: #1f5eff; color: #fff; font-size: 15px; font-weight: 600; text-decoration: none; box-shadow: 0 10px 22px rgba(31, 94, 255, 0.24); }
    .primary-action:focus-visible { outline: 3px solid rgba(31, 94, 255, 0.28); outline-offset: 3px; }
    .primary-action:hover { background: #174edb; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>${escapedMessage}</p>
    ${actionHtml}
  </main>
</body>
</html>`;
}

export function buildReturnToAppUrl(origin: string) {
  return `${origin}${RETURN_TO_APP_PATH}`;
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function writeHtmlResponse(response: http.ServerResponse, statusCode: number, html: string) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}
