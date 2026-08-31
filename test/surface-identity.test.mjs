import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const {
  SURFACE_ROLES,
  createLegacySurfaceIdAliases,
  createChatChildSurfaceIdentity,
  createServiceSurfaceIdentity,
  createSurfaceIdentity,
  createWebEntrySurfaceIdentity,
  resolveLegacyFixedSurfaceId,
  stableSurfaceHash,
  surfaceIdentityMatchesPolicy
} = await import("../dist-electron/shared/surface-identity.js");
const {
  createBrowserSurfaceRegistry,
  registeredSurfaceIdentitiesConflict
} = await import("../dist-electron/main/browser-surface-registry.js");
const {
  resolveAgentWebclientWebviewSurfaceType
} = await import("../dist-electron/shared/webview-context-menu.js");

test("surface identity uses readable singleton roots and stable domain-prefixed dynamic ids", () => {
  assert.equal(SURFACE_ROLES.includes("copilot-chat"), false);
  assert.equal(resolveLegacyFixedSurfaceId("agent-webclient-copilot"), "agent-webclient-copilot");
  assert.equal(createSurfaceIdentity("main-chat").surfaceId, "main-chat");
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
    ["skill", "skill:private-skill", "private-skill"],
    ["workpanel-web", "web:https://private.example/path", "private.example"],
  ]) {
    assert.equal(createSurfaceIdentity(role, key).surfaceId.includes(rawValue), false);
  }
});

test("Agent WebClient surface type follows the trusted semantic role", () => {
  for (const [role, expected] of [
    ["main-chat", "agent-chat"],
    ["kanban-chat", "agent-chat"],
    ["copilot-dock", "agent-copilot"],
    ["copilot", "agent-copilot"],
    ["overview", "agent-overview"],
    ["debug", "agent-debug"],
    ["btw", "agent-btw"],
    ["project", "agent-project"],
    ["file", "agent-management"],
    ["file-diff", "agent-management"],
    ["source", "agent-management"],
    ["artifact", "agent-management"],
    ["reference", "agent-management"],
    ["planning", "agent-management"],
    ["agent", "agent-management"],
    ["skill", "agent-management"],
    ["service", "agent-management"],
  ]) {
    assert.equal(resolveAgentWebclientWebviewSurfaceType(role), expected, role);
  }
});

test("surface registry rejects Copilot Dock on Kanban and emits trusted root lifecycle", () => {
  const guest = { id: 61, getType: () => "webview", isDestroyed: () => false };
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [guest],
      fromId: (id) => id === guest.id ? guest : undefined,
    },
    listWebEntries: () => ({ items: [] }),
    getCurrentPageSnapshot: () => null,
  });
  const events = [];
  registry.subscribeLifecycle((event) => events.push(event));
  const dock = createSurfaceIdentity("copilot-dock");
  const registration = {
    registrationId: "dock-generation-1",
    ...dock,
    surfaceIdentityKey: "desktop-route:/kanban",
    surfaceKind: "service",
    surfaceType: "agent-copilot",
    serviceId: "agent-webclient",
    pageRoute: "/kanban",
    label: "Copilot Dock",
    url: "http://127.0.0.1:7788/copilot/helper",
    active: true,
    tabs: [{
      tabId: "dock-tab",
      currentUrl: "http://127.0.0.1:7788/copilot/helper",
      title: "Copilot Dock",
      webContentsId: guest.id,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    }],
    activeTabId: "dock-tab",
  };
  assert.deepEqual(registry.registerSurfaceResult(registration, 7), {
    ok: false,
    reason: "invalid_registration",
  });
  assert.equal(events.length, 0);

  const allowed = { ...registration, registrationId: "dock-generation-2", surfaceIdentityKey: "desktop-route:/settings", pageRoute: "/settings" };
  assert.equal(registry.registerSurface(allowed, 7), true);
  assert.equal(events[0].type, "registered");
  assert.equal(events[0].surface.surfaceRole, "copilot-dock");
  assert.equal(registry.unregisterSurface({ surfaceId: "copilot-dock", registrationId: "dock-generation-2" }, 7), true);
  assert.equal(events[1].type, "unregistered");
});

test("surface registry rejects a forged identity and cascades child removal", () => {
  const guests = new Map([
    [71, { id: 71, getType: () => "webview", isDestroyed: () => false }],
    [72, { id: 72, getType: () => "webview", isDestroyed: () => false }],
    [73, { id: 73, getType: () => "webview", isDestroyed: () => false }],
    [74, { id: 74, getType: () => "webview", isDestroyed: () => false }],
    [75, { id: 75, getType: () => "webview", isDestroyed: () => false }],
    [76, { id: 76, getType: () => "webview", isDestroyed: () => false }],
    [77, { id: 77, getType: () => "webview", isDestroyed: () => false }],
    [78, { id: 78, getType: () => "webview", isDestroyed: () => false }]
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
    pageRoute: identity.surfaceRole === "main-chat" ? "/agent/agent-1" : "/chat",
    ...(identity.surfaceRole === "main-chat"
      ? { pageRouteIdentity: "/agent/agent-1?chatId=chat-1" }
      : {}),
    label: identity.surfaceRole,
    url: "http://127.0.0.1:7788/",
    active: true,
    tabs: [{
      tabId: `tab-${guestId}`,
      currentUrl: identity.surfaceRole === "main-chat"
        ? "http://127.0.0.1:7788/agent/agent-1?chatId=chat-1"
        : "http://127.0.0.1:7788/ui/",
      title: identity.surfaceRole,
      webContentsId: guestId,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: `tab-${guestId}`
  });

  const main = createSurfaceIdentity("main-chat", "", { ownerChatId: "chat-1" });
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

  const btwKey = "btw:agent-1:chat-1:btw-1";
  const btw = createChatChildSurfaceIdentity("btw", btwKey, "chat-1");
  assert.equal(registry.registerSurface(registration(btw, 76, "agent-btw", btwKey), 7), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(76).surfaceRole, "btw");
  assert.equal(registry.resolveWebviewSurfaceTarget(76).interaction, "interactive");

  const fileKey = "file:agent-1:/Users/demo/Project/project-file.ts";
  const file = createChatChildSurfaceIdentity("file", fileKey, "chat-1");
  assert.equal(registry.registerSurface(
    registration(file, 77, "agent-management", fileKey),
    7
  ), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(77).surfaceRole, "file");
  assert.equal(registry.resolveWebviewSurfaceTarget(77).surfaceType, "agent-management");

  const skillKey = "skill:pdf";
  const skill = createChatChildSurfaceIdentity("skill", skillKey, "chat-1");
  assert.equal(registry.registerSurface(
    registration(skill, 78, "agent-management", skillKey),
    7
  ), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(78).surfaceRole, "skill");
  assert.equal(registry.resolveWebviewSurfaceTarget(78).surfaceType, "agent-management");

  const projectKey = "agent:detached-project";
  const detachedProject = createSurfaceIdentity("project", projectKey);
  assert.equal(registry.registerSurface(
    registration(detachedProject, 74, "agent-project", projectKey),
    7
  ), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(74).surfaceType, "agent-project");

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
  assert.equal(registry.resolveWebviewSurfaceTarget(76), null);
  assert.equal(registry.resolveWebviewSurfaceTarget(77), null);
  assert.equal(registry.resolveWebviewSurfaceTarget(78), null);
  assert.equal(registry.resolveWebviewSurfaceTarget(74).surfaceId, detachedProject.surfaceId);
  registry.unregisterSurfacesForOwner(7);
  assert.equal(registry.resolveWebviewSurfaceTarget(74), null);
});

test("surface registry reports sanitized and deduplicated registration rejection reasons", async () => {
  const diagnostics = [];
  const guests = new Map([301, 302, 303, 304].map((id) => [
    id,
    { id, getType: () => "webview", isDestroyed: () => false },
  ]));
  const webEntries = ["webapp:a", "webapp:b", "webapp:recovery"].map((entryKey) => ({
    id: entryKey.slice("webapp:".length),
    entryKey,
    kind: "webapp",
    label: entryKey,
    url: "http://127.0.0.1:19001/",
  }));
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [...guests.values()],
      fromId: (id) => guests.get(id),
    },
    listWebEntries: () => ({ items: webEntries }),
    getCurrentPageSnapshot: () => null,
    reportRegistrationDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    registrationDiagnosticDedupWindowMs: 10,
  });
  const webappRegistration = (entryKey, guestId, registrationId) => ({
    registrationId,
    ...createWebEntrySurfaceIdentity("webapp", entryKey),
    surfaceIdentityKey: entryKey,
    surfaceKind: "webapp",
    surfaceType: "webapp",
    pageRoute: `/webs/${entryKey}`,
    presentationScope: "main-workspace",
    label: "Secret label must not be logged",
    url: "http://127.0.0.1:19001/?token=secret-token",
    active: true,
    tabs: [{
      tabId: `tab-${guestId}`,
      currentUrl: "http://127.0.0.1:19001/poster?token=secret-token",
      title: "Secret title must not be logged",
      webContentsId: guestId,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    }],
    activeTabId: `tab-${guestId}`,
  });
  const serviceRegistration = (identity, guestId, registrationId, surfaceType, identityKey = "") => ({
    registrationId,
    ...identity,
    ...(identityKey ? { surfaceIdentityKey: identityKey } : {}),
    surfaceKind: "service",
    surfaceType,
    serviceId: "agent-webclient",
    pageRoute: identity.surfaceRole === "main-chat" ? "/agent/agent-301" : "/chat",
    ...(identity.surfaceRole === "main-chat"
      ? { pageRouteIdentity: "/agent/agent-301?chatId=chat-private" }
      : {}),
    label: "Secret service label",
    url: "http://127.0.0.1:7788/?token=secret-token",
    active: true,
    tabs: [{
      tabId: `service-tab-${guestId}`,
      currentUrl: identity.surfaceRole === "main-chat"
        ? "http://127.0.0.1:7788/agent/agent-301?chatId=chat-private"
        : "http://127.0.0.1:7788/ui/?token=secret-token",
      title: "Secret service title",
      webContentsId: guestId,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    }],
    activeTabId: `service-tab-${guestId}`,
  });

  const appA = webappRegistration("webapp:a", 301, "app-a");
  assert.equal(registry.registerSurface(appA, 7), true);
  assert.equal(diagnostics.length, 0);

  const invalidRetry = {
    ...webappRegistration("webapp:recovery", 302, "invalid-retry"),
    surfaceId: "",
  };
  assert.equal(registry.registerSurface(invalidRetry, 7), false);
  assert.equal(registry.registerSurface(invalidRetry, 7), false);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].reason, "invalid_registration");
  assert.equal(diagnostics[0].invalidCheck, "invalid_surface_id");
  assert.equal(registry.registerSurface(webappRegistration("webapp:recovery", 302, "invalid-retry"), 7), true);
  const retrySummary = diagnostics.find((diagnostic) =>
    diagnostic.event === "surface-registration-rejection-summary" &&
    diagnostic.registrationId === "invalid-retry"
  );
  assert.equal(retrySummary.occurrenceCount, 2);
  assert.equal(retrySummary.resolution, "registered");

  assert.equal(registry.registerSurface(
    webappRegistration("webapp:missing", 304, "missing-entry"),
    7,
  ), false);
  assert.equal(diagnostics.at(-1).invalidCheck, "entry_not_found");

  assert.equal(registry.registerSurface({ ...appA, registrationId: "owner-conflict" }, 8), false);
  assert.equal(diagnostics.at(-1).reason, "owner_webcontents_conflict");

  const identityConflict = {
    ...webappRegistration("webapp:b", 304, "identity-conflict"),
    surfaceId: appA.surfaceId,
  };
  assert.equal(registry.registerSurface(identityConflict, 7), false);
  assert.equal(diagnostics.at(-1).reason, "surface_identity_conflict");
  assert.equal(diagnostics.at(-1).conflict.surfaceIdentityKeyMatches, false);

  assert.equal(registry.registerSurface(webappRegistration("webapp:b", 301, "guest-conflict"), 7), false);
  assert.equal(diagnostics.at(-1).reason, "guest_webcontents_claimed");
  assert.equal(diagnostics.at(-1).conflict.guestWebContentsId, 301);

  const main = createSurfaceIdentity("main-chat", "", { ownerChatId: "chat-private" });
  const mainRegistration = serviceRegistration(main, 303, "main-valid", "agent-chat");
  assert.equal(registry.registerSurface(mainRegistration, 7), true);
  const incoherentMain = serviceRegistration(
    createSurfaceIdentity("main-chat"),
    303,
    "main-transition",
    "agent-chat",
  );
  assert.equal(registry.registerSurface(incoherentMain, 7), false);
  assert.equal(diagnostics.at(-1).reason, "main_chat_owner_transition_rejected");

  const overviewKey = "overview:chat-private";
  const overview = createChatChildSurfaceIdentity("overview", overviewKey, "chat-private");
  assert.equal(registry.registerSurface(
    serviceRegistration(overview, 304, "parent-conflict", "agent-overview", overviewKey),
    8,
  ), false);
  assert.equal(diagnostics.at(-1).reason, "parent_surface_conflict");

  const rejectionReasons = new Set(
    diagnostics
      .filter((diagnostic) => diagnostic.event === "surface-registration-rejected")
      .map((diagnostic) => diagnostic.reason),
  );
  for (const reason of [
    "invalid_registration",
    "owner_webcontents_conflict",
    "surface_identity_conflict",
    "main_chat_owner_transition_rejected",
    "parent_surface_conflict",
    "guest_webcontents_claimed",
  ]) {
    assert.equal(rejectionReasons.has(reason), true, reason);
  }

  const expiredRetry = {
    ...webappRegistration("webapp:recovery", 302, "expired-retry"),
    surfaceId: "",
  };
  assert.equal(registry.registerSurface(expiredRetry, 7), false);
  assert.equal(registry.registerSurface(expiredRetry, 7), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const expiredSummary = diagnostics.find((diagnostic) =>
    diagnostic.event === "surface-registration-rejection-summary" &&
    diagnostic.registrationId === "expired-retry"
  );
  assert.equal(expiredSummary.occurrenceCount, 2);
  assert.equal(expiredSummary.resolution, "retry_window_expired");

  const serializedDiagnostics = JSON.stringify(diagnostics);
  assert.equal(serializedDiagnostics.includes("secret-token"), false);
  assert.equal(serializedDiagnostics.includes("chat-private"), false);
  assert.equal(serializedDiagnostics.includes("http://"), false);
});

test("Main Chat registry preserves canonical ownership and waits for coherent identity transitions", async () => {
  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  const guest = new EventEmitter();
  guest.id = 201;
  guest.hostWebContents = owner;
  guest.getType = () => "webview";
  guest.isDestroyed = () => false;
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [guest],
      fromId: (id) => id === guest.id ? guest : null
    },
    listWebEntries: () => ({ items: [] }),
    getCurrentPageSnapshot: () => null
  });
  const registration = ({
    registrationId = "generation-201",
    ownerChatId,
    active = true,
    pageRoute = "/agent/agent-201",
    pageRouteIdentity,
    currentUrl,
  }) => ({
    registrationId,
    ...createSurfaceIdentity("main-chat", "", ownerChatId ? { ownerChatId } : {}),
    surfaceKind: "service",
    surfaceType: "agent-chat",
    serviceId: "agent-webclient",
    pageRoute,
    pageRouteIdentity,
    label: "Chat",
    url: "http://127.0.0.1:7788/",
    active,
    tabs: [{
      tabId: "main-chat",
      currentUrl,
      title: "Chat",
      webContentsId: guest.id,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: "main-chat"
  });

  assert.equal(registry.registerSurface(registration({
    ownerChatId: "chat-201",
    pageRouteIdentity: "/agent/agent-201?chatId=chat-201",
    currentUrl: "http://127.0.0.1:7788/agent/agent-201?chatId=chat-201",
  }), 7), true);

  assert.equal(registry.registerSurface(registration({
    ownerChatId: undefined,
    pageRouteIdentity: "/agent/agent-201?chatId=chat-201",
    currentUrl: "http://127.0.0.1:7788/agent/agent-201?chatId=chat-201",
  }), 7), false);
  assert.equal(registry.resolveWebviewSurfaceTarget(guest.id).ownerChatId, "chat-201");

  assert.equal(registry.registerSurface(registration({
    ownerChatId: undefined,
    pageRouteIdentity: "/agent/agent-201?newChat=nonce-202",
    currentUrl: "http://127.0.0.1:7788/agent/agent-201?newChat=nonce-202",
  }), 7), true);
  const newChatTarget = registry.resolveWebviewSurfaceTarget(guest.id);
  assert.equal(newChatTarget.active, true);
  assert.equal(newChatTarget.ownerChatId, undefined);
  assert.equal(newChatTarget.pageRouteIdentity, "/agent/agent-201?newChat=nonce-202");

  const canonicalTarget = registry.waitForWebviewSurfaceTargetMatching(
    guest.id,
    (target) => target.ownerChatId === "chat-202",
    1_500,
  );
  let canonicalWaitSettled = false;
  void canonicalTarget.then(() => { canonicalWaitSettled = true; });
  await Promise.resolve();
  assert.equal(canonicalWaitSettled, false);

  assert.equal(registry.registerSurface(registration({
    ownerChatId: "chat-202",
    pageRouteIdentity: "/agent/agent-201?chatId=chat-202",
    currentUrl: "http://127.0.0.1:7788/agent/agent-201?newChat=nonce-202",
  }), 7), true);
  assert.equal((await canonicalTarget)?.ownerChatId, "chat-202");

  assert.equal(registry.registerSurface(registration({
    ownerChatId: undefined,
    active: false,
    pageRoute: "/browser",
    pageRouteIdentity: "/browser",
    currentUrl: "http://127.0.0.1:7788/agent/agent-201?chatId=chat-202",
  }), 7), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(guest.id).active, false);
  assert.equal(registry.resolveWebviewSurfaceTarget(guest.id).ownerChatId, "chat-202");
  assert.equal(
    registry.resolveWebviewSurfaceTarget(guest.id).pageRouteIdentity,
    "/agent/agent-201?chatId=chat-202",
  );

  const replacedGenerationTarget = registry.waitForWebviewSurfaceTargetMatching(
    guest.id,
    (target) => target.ownerChatId === "chat-never",
    1_500,
  );
  assert.equal(registry.registerSurface(registration({
    registrationId: "generation-201-replaced",
    ownerChatId: "chat-202",
    pageRouteIdentity: "/agent/agent-201?chatId=chat-202",
    currentUrl: "http://127.0.0.1:7788/agent/agent-201?chatId=chat-202",
  }), 7), true);
  assert.equal(await replacedGenerationTarget, null);

  assert.equal(await registry.waitForWebviewSurfaceTargetMatching(
    guest.id,
    (target) => target.ownerChatId === "chat-never",
    5,
  ), null);

  const destroyedGuestTarget = registry.waitForWebviewSurfaceTargetMatching(
    guest.id,
    (target) => target.ownerChatId === "chat-never",
    1_500,
  );
  guest.emit("destroyed");
  assert.equal(await destroyedGuestTarget, null);
});

test("surface registry resolves delayed guest targets and cleans timeout or abort waiters", async () => {
  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  const guests = new Map();
  for (const id of [91, 92, 93, 94]) {
    const guest = new EventEmitter();
    guest.id = id;
    guest.hostWebContents = owner;
    guest.getType = () => "webview";
    guest.isDestroyed = () => false;
    guests.set(id, guest);
  }
  const guest = guests.get(91);
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [...guests.values()],
      fromId: (id) => guests.get(id)
    },
    listWebEntries: () => ({ items: [] }),
    getCurrentPageSnapshot: () => null
  });
  const delayedTarget = registry.waitForWebviewSurfaceTarget(guest.id, 1_500);
  let settled = false;
  void delayedTarget.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  const identity = createSurfaceIdentity("main-chat");
  assert.equal(registry.registerSurface({
    registrationId: "generation-delayed-91",
    ...identity,
    surfaceKind: "service",
    surfaceType: "agent-chat",
    serviceId: "agent-webclient",
    pageRoute: "/agent/agent-91",
    pageRouteIdentity: "/agent/agent-91?newChat=nonce-91",
    label: "Chat",
    url: "http://127.0.0.1:7788/",
    active: true,
    tabs: [{
      tabId: "main-chat",
      currentUrl: "http://127.0.0.1:7788/agent/agent-91?newChat=nonce-91",
      title: "Chat",
      webContentsId: guest.id,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: "main-chat"
  }, 7), true);

  assert.equal((await delayedTarget)?.surfaceId, "main-chat");
  assert.equal((await registry.waitForWebviewSurfaceTarget(guest.id, 1_500))?.webContentsId, guest.id);
  assert.equal(await registry.waitForWebviewSurfaceTarget(92, 5), null);

  const abortController = new AbortController();
  const abortedTarget = registry.waitForWebviewSurfaceTarget(93, 1_500, abortController.signal);
  abortController.abort();
  assert.equal(await abortedTarget, null);

  const ownerDestroyedTarget = registry.waitForWebviewSurfaceTarget(94, 1_500);
  owner.emit("destroyed");
  assert.equal(await ownerDestroyedTarget, null);
});
