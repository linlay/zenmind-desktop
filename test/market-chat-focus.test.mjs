import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { matchPath } = require("react-router-dom");
const { createAgentWebclientAgentPath } = require("../dist-electron/shared/agent-webclient-routes.js");

// Run the real market handlers and shell navigation together. A bare router
// navigation would update the URL without creating the guest focus request.
function functionsFrom(file, names) {
  const source = ts.createSourceFile(file, fs.readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      found.set(node.name.text, node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(found.size, names.length);
  return [...found.values()].join("\n");
}

const code = ts.transpileModule([
  functionsFrom("../src/renderer/pages/functional-market/StorefrontMarket.tsx",
    ["isInstalledMarketItem", "useMarketSkill", "openSkillAssistant"]),
  functionsFrom("../src/renderer/app-shell/AppShell.tsx",
    ["resolveNavigationPathname", "resolveNavigationRoute", "isSingleAgentWebclientRoute", "requestNavigationWithAgentChatFocus"]),
  "const onRequestAgentChatNavigate = requestNavigationWithAgentChatFocus;",
  "({ useMarketSkill, openSkillAssistant });",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(overrides = {}) {
  const navigations = [], feedback = [];
  let pendingFocus = null;
  let detailClosed = false;
  const context = {
    URL, URLSearchParams, Date, Error, matchPath, createAgentWebclientAgentPath,
    currentRoute: "/market", agentChatFocusRequestIdRef: { current: 0 },
    setPendingAgentChatFocusRequest: request => { pendingFocus = request; },
    requestSidebarNavigation: route => {
      assert.equal(pendingFocus?.targetRoute, route, "focus must be requested before navigating");
      navigations.push({ route, focusId: pendingFocus.id });
      return true;
    },
    navigate: () => { throw new Error("market bypassed the shell's focus handoff"); },
    window: { electronAPI: { assistant: {
      getSettings: async () => ({ chatDefaultAgentKey: "cutej" }),
      listAgents: async () => [{ agentKey: "cutej" }],
      ...overrides,
    } } },
    skillLaunchInFlight: { current: false }, isOpeningSkillAssistant: false,
    setIsOpeningSkillAssistant() {},
    setSelectedDetailItem: value => { detailClosed = value === null; },
    setFeedback: value => feedback.push(value), setFeedbackType() {},
    normalizeError: error => error.message,
    t: (key, params) => params?.name ? `${key}: ${params.name}` : key,
    console: { warn() {} },
  };
  const handlers = vm.runInNewContext(code, context);
  return { ...handlers, navigations, feedback, context, get detailClosed() { return detailClosed; } };
}

test("using a market skill preserves the Composer intent and requests a new focus handoff on each visit", async () => {
  const fixture = setup();
  const item = { id: "report-helper", name: "报表 A & B", state: "installed" };
  for (const focusId of [1, 2]) {
    await fixture.useMarketSkill(item);
    const navigation = fixture.navigations.at(-1);
    const url = new URL(navigation.route, "http://desktop.invalid");
    assert.equal(url.pathname, "/agent/cutej");
    assert.equal(url.searchParams.get("composerSkill"), item.id);
    assert.equal(url.searchParams.get("composerDraft"), `market.discovery.useDraft: ${item.name}`);
    assert.ok(url.searchParams.has("newChat"));
    assert.equal(navigation.focusId, focusId);
    assert.equal(fixture.detailClosed, true);
  }
});

test("the skill creation assistant uses the same focus handoff", async () => {
  const fixture = setup();
  await fixture.openSkillAssistant();
  const url = new URL(fixture.navigations[0].route, "http://desktop.invalid");
  assert.equal(url.searchParams.get("composerSkill"), "skill-creator");
  assert.equal(url.searchParams.get("composerDraft"), "market.skill.assistant.draft");
  assert.equal(fixture.navigations[0].focusId, 1);
});

test("invalid skills or unavailable agents do not navigate or claim keyboard focus", async () => {
  const fixture = setup();
  for (const item of [
    { id: "not-installed", state: "not-installed" },
    { id: "a-package", state: "installed", skill: { kind: "package" } },
    { id: "../invalid", state: "installed" },
  ]) await fixture.useMarketSkill(item);
  assert.equal(fixture.navigations.length, 0);
  assert.equal(fixture.context.agentChatFocusRequestIdRef.current, 0);
  const unavailable = setup({ listAgents: async () => [] });
  await unavailable.useMarketSkill({ id: "demo", state: "installed" });
  assert.equal(unavailable.navigations.length, 0);
  assert.equal(unavailable.context.skillLaunchInFlight.current, false);
});
