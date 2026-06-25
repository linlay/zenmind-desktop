import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readSourceFile(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("agents without a known icon use the gray robot default", () => {
  const agentIconSource = readSourceFile(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AgentIcon.tsx",
  );
  const defaultAgentIcon = readSourceFile(
    "src",
    "renderer",
    "assets",
    "agent-icons",
    "default.svg",
  );

  assert.match(defaultAgentIcon, /<rect x="10" y="14" width="28" height="24" rx="6"/);
  assert.match(defaultAgentIcon, /#94A3B8/);
  assert.match(
    agentIconSource,
    /renderImageIcon\(IconMap\[name as keyof typeof IconMap\] \|\| defaultIcon, className, size\)/,
  );
  assert.doesNotMatch(
    agentIconSource,
    /fallbackSeed|resolveFallbackIcon|hashFallbackSeed|DEFAULT_ICON_NAMES/,
  );
});
