import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("Desktop display renderer owns one non-interactive lifecycle with reduced-motion fallback", () => {
  const overlay = fs.readFileSync(path.join(root, "src/renderer/app-shell/DesktopDisplayOverlay.tsx"), "utf8");
  const shell = fs.readFileSync(path.join(root, "src/renderer/app-shell/AppShell.tsx"), "utf8");
  const style = fs.readFileSync(path.join(root, "src/renderer/styles/desktop-display.css"), "utf8");

  assert.match(shell, /request\.action !== "desktop\.display"/u);
  assert.match(shell, /validateDesktopDisplayPayload\(request\.args \?\? \{\}\)/u);
  assert.match(shell, /document\.visibilityState !== "visible"/u);
  assert.match(shell, /status: "accepted"/u);
  assert.match(shell, /current\?\.token === desktopDisplay\.token \? null : current/u);

  assert.match(overlay, /prefers-reduced-motion: reduce/u);
  assert.match(overlay, /requestAnimationFrame/u);
  assert.match(overlay, /cancelAnimationFrame/u);
  assert.match(overlay, /removeEventListener\("resize", resize\)/u);
  assert.match(overlay, /drawStar/u);
  assert.match(overlay, /bezierCurveTo/u);
  assert.match(style, /pointer-events: none/u);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(style, /desktop-display-lifecycle/u);
});
