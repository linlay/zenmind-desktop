import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appShellCssPath = path.join(projectRoot, "src", "renderer", "styles", "app-shell.css");
const agentNativeCssPath = path.join(projectRoot, "src", "renderer", "styles", "agent-webclient-native.css");

test("agent webclient native pages define dark surface tokens", () => {
  const css = fs.readFileSync(agentNativeCssPath, "utf8");

  assert.match(css, /:root\[data-theme="dark"\]\s+\.agent-webclient-native\s*\{/);
  assert.match(css, /--bg-base:\s*#111318;/);
  assert.match(css, /--bg-input:\s*#171a21;/);
  assert.match(css, /--ink-1:\s*#f4f7fb;/);
});

test("agent native app shell follows the active theme background", () => {
  const css = fs.readFileSync(appShellCssPath, "utf8");

  assert.match(
    css,
    /\.app-shell\.has-agent-native-surface \.app-content,\s*\.app-shell\.has-agent-native-surface \.app-main\s*\{\s*background:\s*var\(--bg-base\);/s
  );
  assert.match(
    css,
    /:root\[data-theme="dark"\]\s+\.app-shell\.has-agent-native-surface \.app-content,\s*:root\[data-theme="dark"\]\s+\.app-shell\.has-agent-native-surface \.app-main\s*\{\s*background:\s*#111318;/s
  );
});
