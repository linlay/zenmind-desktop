import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const typescript = require("typescript");

function loadSessionModule() {
  const source = fs.readFileSync(path.join(
    process.cwd(),
    "src",
    "renderer",
    "copilot",
    "sidebar-copilot",
    "copilotDockSession.ts"
  ), "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  }).outputText;
  const values = new Map();
  const window = {
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    }
  };
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "../../../shared/brand") {
      return { STORAGE_NAMESPACE: "desktop-test" };
    }
    throw new Error(`Unexpected module: ${specifier}`);
  };
  new Function("exports", "module", "require", "window", output)(
    module.exports,
    module,
    localRequire,
    window
  );
  return { api: module.exports, values };
}

test("copilot dock session snapshot keeps only relative route identity", () => {
  const { api, values } = loadSessionModule();
  api.writeCopilotDockSessionSnapshot({
    contexts: {
      "website:docs": {
        embedPath: "https://webclient.example/copilot/helper?chatId=chat-1&token=secret&code=hidden",
        agentKey: "helper",
        chatId: "chat-1"
      }
    }
  });

  const serialized = [...values.values()][0];
  assert.equal(serialized.includes("webclient.example"), false);
  assert.equal(serialized.includes("openPath"), false);
  assert.equal(serialized.includes("surfaceId"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("hidden"), false);
  assert.equal(serialized.includes("/copilot/helper?chatId=chat-1"), true);
  assert.deepEqual(api.readCopilotDockSessionSnapshot(), {
    version: 5,
    contexts: {
      "website:docs": {
        embedPath: "/copilot/helper?chatId=chat-1",
        agentKey: "helper",
        chatId: "chat-1"
      }
    }
  });
});

test("copilot dock session captures a promoted WebClient chat URL", () => {
  const { api } = loadSessionModule();
  const currentUrl = "http://127.0.0.1:17080/copilot/zenmi?lang=zh&theme=light&chatId=d8c73338-7e4b-49ad-a134-bc15b16ef3ed";

  assert.equal(
    api.normalizeCopilotEmbedPath(currentUrl),
    "/copilot/zenmi?chatId=d8c73338-7e4b-49ad-a134-bc15b16ef3ed"
  );
  assert.equal(
    api.readCopilotChatId(currentUrl),
    "d8c73338-7e4b-49ad-a134-bc15b16ef3ed"
  );
});

test("copilot dock session keeps each context on its own historical chat", () => {
  const { api } = loadSessionModule();
  api.writeCopilotDockSessionSnapshot({
    contexts: {
      "website:docs": {
        embedPath: "/copilot/docs-agent?chatId=docs-history",
        agentKey: "docs-agent",
        chatId: "docs-history"
      },
      "webapp:tasks": {
        embedPath: "/copilot/tasks-agent?chatId=tasks-history",
        agentKey: "tasks-agent",
        chatId: "tasks-history"
      }
    }
  });

  assert.deepEqual(api.readCopilotDockSessionSnapshot()?.contexts, {
    "website:docs": {
      embedPath: "/copilot/docs-agent?chatId=docs-history",
      agentKey: "docs-agent",
      chatId: "docs-history"
    },
    "webapp:tasks": {
      embedPath: "/copilot/tasks-agent?chatId=tasks-history",
      agentKey: "tasks-agent",
      chatId: "tasks-history"
    }
  });
});

test("copilot dock session rejects non-copilot paths and clears on explicit close", () => {
  const { api, values } = loadSessionModule();
  api.writeCopilotDockSessionSnapshot({
    contexts: {
      "website:docs": {
        embedPath: "/agents/helper?chatId=chat-1",
        agentKey: "helper"
      }
    }
  });
  assert.equal(values.size, 0);

  api.writeCopilotDockSessionSnapshot({
    contexts: {
      "website:docs": {
        embedPath: "/copilot/helper",
        agentKey: "helper"
      }
    }
  });
  assert.equal(values.size, 1);
  api.clearCopilotDockSessionSnapshot();
  assert.equal(values.size, 0);
  assert.equal(api.readCopilotDockSessionSnapshot(), null);
});

test("copilot dock session migrates v3 surface keys to v5 context keys", () => {
  const { api, values } = loadSessionModule();
  values.set(api.__testInternals.COPILOT_DOCK_SESSION_KEY, JSON.stringify({
    version: 3,
    surfaces: {
      "website:docs": {
        embedPath: "/copilot/helper?chatId=chat-3",
        agentKey: "helper",
        chatId: "chat-3"
      }
    }
  }));

  assert.deepEqual(api.readCopilotDockSessionSnapshot(), {
    version: 5,
    contexts: {
      "website:docs": {
        embedPath: "/copilot/helper?chatId=chat-3",
        agentKey: "helper",
        chatId: "chat-3"
      }
    }
  });
  assert.equal(JSON.parse([...values.values()][0]).version, 5);
});

test("copilot dock session drops the forbidden Kanban route while preserving other contexts", () => {
  const { api } = loadSessionModule();
  api.writeCopilotDockSessionSnapshot({
    contexts: {
      "desktop-route:/kanban": {
        embedPath: "/copilot/helper?chatId=kanban-chat",
        agentKey: "helper",
        chatId: "kanban-chat"
      },
      "website:docs": {
        embedPath: "/copilot/helper?chatId=docs-chat",
        agentKey: "helper",
        chatId: "docs-chat"
      }
    }
  });

  assert.deepEqual(api.readCopilotDockSessionSnapshot(), {
    version: 5,
    contexts: {
      "website:docs": {
        embedPath: "/copilot/helper?chatId=docs-chat",
        agentKey: "helper",
        chatId: "docs-chat"
      }
    }
  });
});

test("copilot dock session discards the old single-surface snapshots", () => {
  const { api, values } = loadSessionModule();
  values.set(api.__testInternals.COPILOT_DOCK_SESSION_KEY, JSON.stringify({
    version: 1,
    openPath: "/webs/website:docs",
    surfaceId: "website:docs",
    embedPath: "/copilot/helper?chatId=chat-1",
    agentKey: "helper",
    chatId: "chat-1"
  }));

  assert.equal(api.readCopilotDockSessionSnapshot(), null);
  assert.equal(values.size, 0);

  values.set(api.__testInternals.COPILOT_DOCK_SESSION_KEY, JSON.stringify({
    version: 2,
    embedPath: "/copilot/helper?chatId=chat-2",
    agentKey: "helper",
    chatId: "chat-2"
  }));
  assert.equal(api.readCopilotDockSessionSnapshot(), null);
  assert.equal(values.size, 0);
});
