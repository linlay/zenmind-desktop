import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function loadCoderProjectHelpers() {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const start = source.indexOf("function workspaceNameFromPath");
  const end = source.indexOf("function sanitizeDownloadFilename", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const helperSource = source
    .slice(start, end)
    .replaceAll(": string", "")
    .replaceAll(": string[]", "");
  return Function(`${helperSource}; return { coderAgentKeyFromWorkspace, buildCoderProjectAgentCreateRequest };`)();
}

test("CODER project helper creates matching agent keys from workspace paths", () => {
  const { coderAgentKeyFromWorkspace } = loadCoderProjectHelpers();

  assert.equal(coderAgentKeyFromWorkspace("/Users/demo/Project/agent-coder"), "coder-agent-coder");
  assert.equal(coderAgentKeyFromWorkspace("/Users/demo/Project/My App"), "coder-my-app");
  assert.equal(coderAgentKeyFromWorkspace("C:\\Users\\demo\\Project\\Agent Coder"), "coder-agent-coder");
  assert.equal(coderAgentKeyFromWorkspace("/Users/demo/项目"), "coder-project");
});

test("CODER project helper builds the expected agent create payload", () => {
  const { buildCoderProjectAgentCreateRequest } = loadCoderProjectHelpers();
  const payload = buildCoderProjectAgentCreateRequest("/Users/demo/Project/agent-coder");

  assert.deepEqual(payload, {
    key: "coder-agent-coder",
    definition: {
      key: "coder-agent-coder",
      name: "coder-agent-coder",
      mode: "CODER",
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
