import test from "node:test";
import assert from "node:assert/strict";

const {
  createEmbeddedCdpServiceSurface
} = await import("../dist-electron/main/cdp-integration.js");

test("CDP integration exposes running frontend services as webview surfaces", () => {
  const surface = createEmbeddedCdpServiceSurface({
    service: {
      id: "agent-webclient",
      name: "Agent Webclient",
      status: "running",
      frontendMode: "managed",
      healthMeta: {
        webUrl: "http://127.0.0.1:5173/agents"
      }
    },
    currentPageSnapshot: {
      pageKind: "webview",
      surfaceId: "agent-webclient",
      route: "/agents",
      embedPath: "/agents/chat",
      webContentsId: 42,
      pageContext: {
        title: "Agents",
        browserTarget: {
          kind: "webview",
          surfaceId: "agent-webclient",
          currentUrl: "http://127.0.0.1:5173/agents?tab=active",
          surfaceRoute: "/agents"
        }
      }
    },
    contents: {
      id: 42,
      getURL: () => "http://127.0.0.1:5173/agents",
      getTitle: () => "Ignored"
    },
    isLoopbackUrl: () => true
  });

  assert.deepEqual(surface, {
    id: "agent-webclient",
    label: "Agent Webclient",
    url: "http://127.0.0.1:5173/agents",
    kind: "webview",
    active: true,
    currentUrl: "http://127.0.0.1:5173/agents?tab=active",
    title: "Agents",
    webContentsId: 42,
    surfaceRoute: "/agents",
    embedPath: "/agents/chat"
  });
});

test("CDP integration skips stopped or non-frontend services", () => {
  assert.equal(createEmbeddedCdpServiceSurface({
    service: {
      id: "api",
      name: "API",
      status: "stopped",
      frontendMode: "managed",
      healthMeta: { webUrl: "http://127.0.0.1:3000" }
    },
    currentPageSnapshot: null,
    contents: null,
    isLoopbackUrl: () => true
  }), null);
});
