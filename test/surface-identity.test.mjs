import test from "node:test";
import assert from "node:assert/strict";

const {
  createLegacySurfaceIdAliases,
  createChatChildSurfaceIdentity,
  createServiceSurfaceIdentity,
  createSurfaceIdentity,
  createWebEntrySurfaceIdentity,
  stableSurfaceHash,
  surfaceIdentityMatchesPolicy
} = await import("../dist-electron/shared/surface-identity.js");
const {
  createBrowserSurfaceRegistry,
  registeredSurfaceIdentitiesConflict
} = await import("../dist-electron/main/browser-surface-registry.js");

test("surface identity uses readable singleton roots and stable domain-prefixed dynamic ids", () => {
  assert.equal(createSurfaceIdentity("main-chat").surfaceId, "main-chat");
  assert.equal(createSurfaceIdentity("copilot-chat").surfaceId, "copilot-chat");
  assert.equal(createSurfaceIdentity("kanban-chat").surfaceId, "kanban-chat");
  assert.equal(createSurfaceIdentity("browser").surfaceId, "browser");

  const entryKey = "website:https://docs.example/private/path";
  const website = createWebEntrySurfaceIdentity("website", entryKey);
  const webapp = createWebEntrySurfaceIdentity("webapp", entryKey);
  assert.equal(website.surfaceId, `site:${stableSurfaceHash(entryKey)}`);
  assert.equal(webapp.surfaceId, `app:${stableSurfaceHash(entryKey)}`);
  assert.notEqual(website.surfaceId, webapp.surfaceId);
  assert.equal(website.surfaceId.includes("docs.example"), false);
  assert.ok(website.surfaceId.length < 24);
  assert.equal(stableSurfaceHash(entryKey), stableSurfaceHash(entryKey));
  assert.deepEqual(createLegacySurfaceIdAliases("website", entryKey), [entryKey]);
});

test("surface identity separates hierarchy and interaction from the short id", () => {
  const overview = createChatChildSurfaceIdentity("overview", "overview:chat-secret", "chat-secret");
  assert.match(overview.surfaceId, /^ov:[a-z0-9]+$/u);
  assert.equal(overview.surfaceId.includes("chat-secret"), false);
  assert.equal(overview.surfaceLevel, "child");
  assert.equal(overview.parentSurfaceId, "main-chat");
  assert.equal(overview.interaction, "read-only");
  assert.equal(surfaceIdentityMatchesPolicy(overview, "overview:chat-secret"), true);
  assert.equal(surfaceIdentityMatchesPolicy(overview, "overview:another-chat"), false);

  const service = createServiceSurfaceIdentity("agent-webclient");
  assert.equal(service.surfaceId, "svc:agent-webclient");
  assert.equal(service.surfaceLevel, "utility");
  assert.equal(surfaceIdentityMatchesPolicy(createSurfaceIdentity("main-chat"), "forged-key"), false);

  for (const [role, key, rawValue] of [
    ["project", "agent:private-agent", "private-agent"],
    ["artifact", "artifact:private-item", "private-item"],
    ["workpanel-web", "web:https://private.example/path", "private.example"],
  ]) {
    assert.equal(createSurfaceIdentity(role, key).surfaceId.includes(rawValue), false);
  }
});

test("surface registry rejects a forged identity and cascades child removal", () => {
  const guests = new Map([
    [71, { id: 71, getType: () => "webview", isDestroyed: () => false }],
    [72, { id: 72, getType: () => "webview", isDestroyed: () => false }],
    [73, { id: 73, getType: () => "webview", isDestroyed: () => false }],
    [74, { id: 74, getType: () => "webview", isDestroyed: () => false }],
    [75, { id: 75, getType: () => "webview", isDestroyed: () => false }]
  ]);
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [...guests.values()],
      fromId: (id) => guests.get(id)
    },
    listWebEntries: () => ({ items: [] }),
    getCurrentPageSnapshot: () => null
  });
  const registration = (identity, guestId, surfaceType, identityKey = "") => ({
    registrationId: `generation-${guestId}`,
    ...identity,
    ...(identityKey ? { surfaceIdentityKey: identityKey } : {}),
    surfaceKind: "service",
    surfaceType,
    serviceId: "agent-webclient",
    pageRoute: "/chat",
    label: identity.surfaceRole,
    url: "http://127.0.0.1:7788/",
    active: true,
    tabs: [{
      tabId: `tab-${guestId}`,
      currentUrl: "http://127.0.0.1:7788/ui/",
      title: identity.surfaceRole,
      webContentsId: guestId,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: `tab-${guestId}`
  });

  const main = createSurfaceIdentity("main-chat");
  assert.equal(registry.registerSurface(registration(main, 71, "agent-chat"), 7), true);
  assert.equal(registry.findRegisteredSurfaceWebContents("agent-webclient-chat"), guests.get(71));
  assert.equal(registry.registerSurface(registration({ ...main, interaction: "none" }, 72, "agent-chat"), 7), false);
  assert.equal(registry.registerSurface(registration({ ...main, surfaceRole: "copilot-chat" }, 72, "agent-chat"), 7), false);

  const missingParentKey = "overview:missing-parent";
  const missingParent = createChatChildSurfaceIdentity("overview", missingParentKey, "chat-missing", "missing-root");
  assert.equal(registry.registerSurface(registration(missingParent, 72, "agent-overview", missingParentKey), 7), false);

  const childKey = "overview:chat-1";
  const overview = createChatChildSurfaceIdentity("overview", childKey, "chat-1");
  assert.equal(registry.registerSurface(registration(overview, 72, "agent-overview", childKey), 7), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(72).parentSurfaceId, "main-chat");
  const crossOwnerOverview = createChatChildSurfaceIdentity("overview", "overview:chat-cross-owner", "chat-1");
  assert.equal(registry.registerSurface(
    registration(crossOwnerOverview, 75, "agent-overview", "overview:chat-cross-owner"),
    8
  ), false);

  const debugKey = "debug:chat-1:run-2";
  const debug = createChatChildSurfaceIdentity("debug", debugKey, "chat-1");
  assert.equal(registry.registerSurface(registration(debug, 73, "agent-debug", debugKey), 7), true);
  assert.notEqual(debug.surfaceId, overview.surfaceId);
  assert.equal(registry.resolveWebviewSurfaceTarget(73).interaction, "read-only");

  const projectKey = "agent:detached-project";
  const detachedProject = createSurfaceIdentity("project", projectKey);
  assert.equal(registry.registerSurface(registration(detachedProject, 74, "project", projectKey), 7), true);

  assert.equal(registeredSurfaceIdentitiesConflict(
    { surfaceId: "site:forced-collision", surfaceRole: "website", surfaceIdentityKey: "website:first" },
    { surfaceId: "site:forced-collision", surfaceRole: "website", surfaceIdentityKey: "website:second" }
  ), true);

  assert.equal(registry.unregisterSurface({
    registrationId: "generation-71",
    surfaceId: "main-chat"
  }, 7), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(72), null);
  assert.equal(registry.resolveWebviewSurfaceTarget(73), null);
  assert.equal(registry.resolveWebviewSurfaceTarget(74).surfaceId, detachedProject.surfaceId);
  registry.unregisterSurfacesForOwner(7);
  assert.equal(registry.resolveWebviewSurfaceTarget(74), null);
});
