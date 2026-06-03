import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function loadCoderProjectHelpers() {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "main", "copilot", "core", "coder-project.ts"),
    "utf8"
  );
  const start = source.indexOf("function workspaceNameFromPath");
  const end = source.length;
  assert.notEqual(start, -1);
  const helperSource = source
    .slice(start, end)
    .replaceAll("export ", "")
    .replace(/,\s*options:\s*\{\s*acpProxyId\?: string\s*\}\s*=\s*\{\}/u, ", options = {}")
    .replaceAll(": Record<string, string>", "")
    .replaceAll(": string", "")
    .replaceAll(": string[]", "");
  return Function(`${helperSource}; return { workspaceNameFromPath, buildCoderProjectAgentCreateRequest };`)();
}

test("CODER project helper derives names from workspace paths", () => {
  const { workspaceNameFromPath } = loadCoderProjectHelpers();

  assert.equal(workspaceNameFromPath("/Users/demo/Project/agent-coder"), "agent-coder");
  assert.equal(workspaceNameFromPath("/Users/demo/Project/My App"), "My App");
  assert.equal(workspaceNameFromPath("C:\\Users\\demo\\Project\\Agent Coder"), "Agent Coder");
  assert.equal(workspaceNameFromPath("/Users/demo/项目"), "项目");
});

test("CODER project helper builds the expected agent create payload", () => {
  const { buildCoderProjectAgentCreateRequest } = loadCoderProjectHelpers();
  const payload = buildCoderProjectAgentCreateRequest("/Users/demo/Project/agent-coder");

  assert.deepEqual(payload, {
    definition: {
      name: "agent-coder",
      mode: "CODER",
      icon: {
        name: "folder"
      },
      workspace: {
        root: "/Users/demo/Project/agent-coder"
      },
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Project/agent-coder"
      },
      visibility: {
        scopes: ["nav", "copilot"]
      }
    }
  });
});

test("CODER project helper can target an ACP proxy backend", () => {
  const { buildCoderProjectAgentCreateRequest } = loadCoderProjectHelpers();
  const payload = buildCoderProjectAgentCreateRequest("/Users/demo/Project/agent-coder", {
    acpProxyId: "codex"
  });

  assert.deepEqual(payload.definition.runtimeConfig, {
    workspaceRoot: "/Users/demo/Project/agent-coder",
    coderBackend: "acp",
    acpProxyId: "codex"
  });
});
