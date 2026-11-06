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
        key: "acp", label: "External", engine: "acp", available: true,
        workspaceRequired: true, modelRequired: false, defaultModelAvailable: false,
        supportsGroups: false, groupsUnsupportedReason: "managed by the engine",
        baseTools: [], defaultGroups: [], engineDirectory: { apiVersion: 1, ready:true, catalogGeneration:"g", revision:1, engines: ["claude/agent", "codex/agent"].map(engineId => ({engineId, pluginId:engineId, pluginVersion:"1.0.0", enabled:true, syncState:"applied",dependencyState:"ready",authState:"unknown",runtimeState:"stopped",capabilities:{}})) },
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

test("switching type always restores capability and model defaults", () => {
  const options = creationOptions();
  let selection = initialProjectCreationSelection(options);

  // Untouched: every switch takes the new type's own defaults.
  selection = changeProjectCreationType(options, selection, "coder");
  assert.deepEqual(selection.groups, ["web-data"]);
  selection = changeProjectCreationType(options, selection, "kbase");
  assert.deepEqual(selection.groups, []);
  selection = changeProjectCreationType(options, selection, "general");
  assert.deepEqual(selection.groups, ["office", "web-data"]);

  // Manual edits do not override the next type preset.
  selection = toggleProjectCreationGroup(options, selection, "automation");
  selection = toggleProjectCreationGroup(options, selection, "office");
  assert.deepEqual(selection.groups, ["web-data", "automation"]);
  assert.equal(selection.groupsTouched, true);
  selection = changeProjectCreationType(options, { ...selection, modelKey: "other-model" }, "coder");
  assert.deepEqual(selection.groups, ["web-data"]);
  assert.equal(selection.groupsTouched, false);
  assert.equal(resolveProjectCreationModel(options, selection), "default-model");

  // External engines do not receive native capabilities or a model.
  const acp = changeProjectCreationType(options, selection, "acp");
  assert.deepEqual(acp.groups, []);
  assert.equal(acp.engineId, "claude/agent");

  // Deselecting everything is valid until switching type.
  let empty = toggleProjectCreationGroup(options, selection, "web-data");
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(changeProjectCreationType(options, empty, "general").groups, ["office", "web-data"]);

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
    definition: {},
    modelKey: "other-model",
  });

  // A model that Agent Platform does not list is not sent.
  assert.equal(resolveProjectCreationModel(options, { ...selection, modelKey: "ghost" }), "");
});

test("requests carry concrete configuration for native types and only the plugin identity for the external engine", () => {
  const options = creationOptions();
  const general = initialProjectCreationSelection(options);
  // The type default model is left for Agent Platform to apply.
  assert.deepEqual(buildProjectCreationRequest(options, general, "/project"), {
    projectType: "general",
    workspaceDir: "/project",
    definition: {},
  });
  assert.equal(projectCreationProblem(options, general, "  "), "directoryRequired");

  const acp = changeProjectCreationType(options, { ...general, modelKey: "other-model" }, "acp");
  assert.equal(projectCreationProblem(options, acp, "/project"), null);
  assert.deepEqual(buildProjectCreationRequest(options, { ...acp, engineId: "codex/agent" }, "/project"), {
    projectType: "acp",
    workspaceDir: "/project",
    definition: {},
    engineId: "codex/agent",
  });
  assert.equal(projectCreationProblem(options, { ...acp, engineId: "" }, "/project"), "engineRequired");

  options.types[3].available = false;
  assert.equal(projectCreationProblem(options, acp, "/project"), "typeUnavailable");
});


test("a revoked engine remains selected and cannot be submitted or silently replaced", () => {
 const options=creationOptions();
 const selected=changeProjectCreationType(options, initialProjectCreationSelection(options), "acp");
 options.types[3].engineDirectory.engines=options.types[3].engineDirectory.engines.filter(e=>e.engineId!==selected.engineId);
 assert.equal(projectCreationProblem(options,selected,"/project"), "engineUnavailable");
 assert.equal(changeProjectCreationType(options,selected,"acp").engineId, selected.engineId);
});
