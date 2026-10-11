import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function decodeLocalMarkdown(bytes: Uint8Array) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

export function renderLocalMarkdown(bytes: Uint8Array, fileName: string) {
  const body = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    skipHtml: true,
    children: decodeLocalMarkdown(bytes),
  }));
  const title = renderToStaticMarkup(createElement("title", null, fileName));
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${title}
<style>
:root { color-scheme: light dark; --text: #24292f; --muted: #57606a; --line: #d0d7de; --surface: #f6f8fa; --link: #0969da; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--text); background: #fff; font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
main { max-width: 920px; margin: 0 auto; padding: 32px 40px 72px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 .65em; }
h1, h2 { border-bottom: 1px solid var(--line); padding-bottom: .3em; }
main > :first-child { margin-top: 0; }
a { color: var(--link); text-underline-offset: 3px; }
img { max-width: 100%; height: auto; }
pre, code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: .9em; }
code { padding: .15em .35em; border-radius: 4px; background: var(--surface); }
pre { overflow: auto; padding: 16px; border-radius: 6px; background: var(--surface); overflow-wrap: normal; }
pre code { padding: 0; font-size: inherit; }
blockquote { margin-left: 0; padding-left: 18px; color: var(--muted); border-left: 4px solid var(--line); }
table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
th, td { border: 1px solid var(--line); padding: 6px 12px; }
tr:nth-child(even) { background: var(--surface); }
hr { border: 0; border-top: 1px solid var(--line); }
li + li { margin-top: .25em; }
input[type=checkbox] { margin-right: .45em; }
@media (max-width: 600px) { main { padding: 24px 20px 48px; } }
@media (prefers-color-scheme: dark) {
  :root { --text: #e6edf3; --muted: #9da7b3; --line: #30363d; --surface: #161b22; --link: #58a6ff; }
  body { background: #0d1117; }
}
</style></head><body><main>${body}</main></body></html>`;
}
