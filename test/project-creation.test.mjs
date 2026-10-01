import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  buildProjectCreationRequest,
  changeProjectCreationType,
  initialProjectCreationSelection,
  projectCreationProblem,
  resolveProjectCreationModel,
  selectableProjectCreationGroups,
  toggleProjectCreationGroup,
} = require("../dist-electron/shared/project-creation.js");

function nativeType(key, overrides = {}) {
  return {
    key,
    label: key,
    mode: key.toUpperCase(),
    engine: "native",
    available: true,
    workspaceRequired: true,
    modelRequired: true,
    defaultModelKey: "default-model",
    defaultModelAvailable: true,
    supportsGroups: true,
    baseTools: [],
    defaultGroups: [],
    ...overrides,
  };
}

function creationOptions() {
  const group = (key, available = true) => ({
    key, name: key, skills: [], tools: [], connectors: [], available,
    ...(available ? {} : { unavailableReason: "missing skill x" }),
  });
  return {
    types: [
      nativeType("general", { defaultGroups: ["office", "web-data"] }),
      nativeType("coder", { defaultGroups: ["web-data"] }),
      nativeType("kbase", { defaultModelKey: "", defaultModelAvailable: false }),
      {
        key: "acp", label: "External", mode: "CODER", engine: "acp", available: true,
        workspaceRequired: true, modelRequired: false, defaultModelAvailable: false,
        supportsGroups: false, groupsUnsupportedReason: "managed by the engine",
        baseTools: [], defaultGroups: [], acpBridges: [{ id: "claude" }, { id: "codex" }],
      },
    ],
    groups: [group("office"), group("web-data"), group("automation"), group("broken", false)],
    models: [{ key: "default-model" }, { key: "other-model" }],
  };
}

test("the dialog starts on the first available type with its default groups", () => {
  const options = creationOptions();
  const selection = initialProjectCreationSelection(options);
  assert.equal(selection.typeKey, "general");
  assert.deepEqual(selection.groups, ["office", "web-data"]);
  assert.equal(selection.groupsTouched, false);

  options.types[0].available = false;
  assert.equal(initialProjectCreationSelection(options).typeKey, "coder");
  assert.deepEqual(
    selectableProjectCreationGroups(options, "general").map((group) => group.key),
    ["office", "web-data", "automation"],
  );
  assert.deepEqual(selectableProjectCreationGroups(options, "acp"), []);
});

test("switching type applies defaults until the user edits the groups", () => {
  const options = creationOptions();
  let selection = initialProjectCreationSelection(options);

  // Untouched: every switch takes the new type's own defaults.
  selection = changeProjectCreationType(options, selection, "coder");
  assert.deepEqual(selection.groups, ["web-data"]);
  selection = changeProjectCreationType(options, selection, "kbase");
  assert.deepEqual(selection.groups, []);
  selection = changeProjectCreationType(options, selection, "general");
  assert.deepEqual(selection.groups, ["office", "web-data"]);

  // Touched: the user's choice survives a switch, in configured order.
  selection = toggleProjectCreationGroup(options, selection, "automation");
  selection = toggleProjectCreationGroup(options, selection, "office");
  assert.deepEqual(selection.groups, ["web-data", "automation"]);
  assert.equal(selection.groupsTouched, true);
  selection = changeProjectCreationType(options, selection, "coder");
  assert.deepEqual(selection.groups, ["web-data", "automation"]);

  // A type that takes no groups shows none, but the choice is not lost.
  const acp = changeProjectCreationType(options, selection, "acp");
  assert.deepEqual(acp.groups, []);
  assert.equal(acp.acpBridgeId, "claude");

  // Deselecting everything is a valid, kept choice.
  let empty = toggleProjectCreationGroup(options, selection, "web-data");
  empty = toggleProjectCreationGroup(options, empty, "automation");
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(changeProjectCreationType(options, empty, "general").groups, []);

  // An unavailable group can never be selected.
  assert.equal(toggleProjectCreationGroup(options, selection, "broken"), selection);
});

test("an unusable default model must be replaced by an explicit choice", () => {
  const options = creationOptions();
  let selection = changeProjectCreationType(options, initialProjectCreationSelection(options), "kbase");
  assert.equal(resolveProjectCreationModel(options, selection), "");
  assert.equal(projectCreationProblem(options, selection, "/project"), "modelRequired");

  selection = { ...selection, modelKey: "other-model" };
  assert.equal(projectCreationProblem(options, selection, "/project"), null);
  assert.deepEqual(buildProjectCreationRequest(options, selection, " /project "), {
    projectType: "kbase",
    workspaceDir: "/project",
    capabilityGroups: [],
    modelKey: "other-model",
  });

  // A model that Agent Platform does not list is not sent.
  assert.equal(resolveProjectCreationModel(options, { ...selection, modelKey: "ghost" }), "");
});

test("requests carry groups for native types and only the bridge for the external engine", () => {
  const options = creationOptions();
  const general = initialProjectCreationSelection(options);
  // The type default model is left for Agent Platform to apply.
  assert.deepEqual(buildProjectCreationRequest(options, general, "/project"), {
    projectType: "general",
    workspaceDir: "/project",
    capabilityGroups: ["office", "web-data"],
  });
  assert.equal(projectCreationProblem(options, general, "  "), "directoryRequired");

  const acp = changeProjectCreationType(options, { ...general, modelKey: "other-model" }, "acp");
  assert.equal(projectCreationProblem(options, acp, "/project"), null);
  assert.deepEqual(buildProjectCreationRequest(options, { ...acp, acpBridgeId: "codex" }, "/project"), {
    projectType: "acp",
    workspaceDir: "/project",
    capabilityGroups: [],
    acpBridgeId: "codex",
  });
  assert.equal(projectCreationProblem(options, { ...acp, acpBridgeId: "" }, "/project"), "acpBridgeRequired");

  options.types[3].available = false;
  assert.equal(projectCreationProblem(options, acp, "/project"), "typeUnavailable");
});
