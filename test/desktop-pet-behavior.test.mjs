import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  createDesktopPetState,
  createDefaultDesktopPetLocalStatus,
  getDesktopPetContextMenuItems,
  listUserDesktopPetAppearanceOptions
} = require("../dist-electron/main/copilot/pet-copilot/desktop-pet.js");
const { getDesktopPetsDataRoot } = require("../dist-electron/main/user-paths.js");
const {
  DESKTOP_PET_APPEARANCE_OPTIONS,
  DESKTOP_PET_USER_ASSET_PROTOCOL,
  resolveDesktopPetSignatureActions
} = require("../dist-electron/shared/desktop-pet.js");

function createApp(root) {
  return {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "desktop") return path.join(root, "home", "Desktop");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "userData") return path.join(root, "user-data");
      if (name === "temp") return path.join(root, "temp");
      throw new Error(`unexpected getPath(${name})`);
    }
  };
}

function createSettings(overrides = {}) {
  return {
    enabled: true,
    unreadCount: 0,
    boundAgentKey: "zenmi",
    appearanceId: "classic",
    ...overrides
  };
}

function createAgentStatus(overrides = {}) {
  return {
    agentKey: "zenmi",
    displayName: "小宅",
    role: "assistant",
    presence: "busy",
    unreadCount: 0,
    latestPreview: "",
    chatId: "chat-1",
    hasPendingAwaiting: false,
    stale: false,
    updatedAt: "2026-06-13T00:00:00.000Z",
    ...overrides
  };
}

function writeStrictUserPet(petRoot, overrides = {}) {
  fs.mkdirSync(path.join(petRoot, "signature"), { recursive: true });
  for (const fileName of [
    "idle.png",
    "running.png",
    "awaiting.png",
    "done.png",
    "error.png",
    "hover.png",
    "dragging.png",
    "drag-moving.webp"
  ]) {
    fs.writeFileSync(path.join(petRoot, fileName), "fake asset", "utf8");
  }
  fs.writeFileSync(path.join(petRoot, "signature", "dance.webp"), "fake webp", "utf8");
  const manifest = {
    id: "pony",
    displayName: "小凌",
    version: "1.0.0",
    description: "Strict user pet",
    preview: "idle.png",
    states: {
      idle: { path: "idle.png" },
      running: { path: "running.png" },
      awaiting: { path: "awaiting.png" },
      done: { path: "done.png", holdMs: 2500 },
      error: { path: "error.png", holdMs: 3000 },
      hover: { path: "hover.png" },
      dragging: { path: "dragging.png" },
      "drag-moving": {
        path: "drag-moving.webp",
        frameCount: 15,
        durationMs: 900,
        loop: true,
        mirror: true
      }
    },
    signature: [
      {
        id: "dance",
        label: "跳舞",
        trigger: ["manual"],
        variants: [
          {
            path: "signature/dance.webp",
            frameCount: 30,
            durationMs: 5200
          }
        ]
      }
    ],
    ...overrides
  };
  fs.writeFileSync(path.join(petRoot, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("desktop pet state exposes awaiting when the bound agent has a pending awaiting prompt", () => {
  const state = createDesktopPetState(createSettings(), {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: createAgentStatus({
      presence: "busy",
      hasPendingAwaiting: true,
      latestPreview: "需要你确认计划"
    })
  });

  assert.equal(state.status, "awaiting");
  assert.equal(state.hint, "需要你确认计划");
});

test("desktop pet state exposes awaiting when any active task is awaiting", () => {
  const state = createDesktopPetState(createSettings(), {
    supported: true,
    visible: true,
    localStatus: createDefaultDesktopPetLocalStatus(),
    agentStatus: createAgentStatus({
      presence: "busy",
      hasPendingAwaiting: false
    }),
    activeTasks: [
      {
        id: "task-1",
        agentKey: "zenmi",
        agentDisplayName: "小宅",
        chatId: "chat-1",
        runId: "run-1",
        title: "确认计划",
        preview: "等待你审批",
        status: "awaiting",
        awaitingMode: "approval",
        updatedAt: "2026-06-13T00:00:00.000Z"
      }
    ]
  });

  assert.equal(state.status, "awaiting");
});

test("desktop pet visual arbitration keeps awaiting above hover and signature", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const visualStatus = deriveDesktopPetVisualStatus({
    displayStatus: "awaiting",
    isDragging: false,
    dragDirection: null,
    hasActiveSignature: true,
    canShowHoverReaction: true,
    isHovering: true,
    isKeyboardFocused: false
  });

  assert.equal(visualStatus, "awaiting");
});

test("desktop pet visual arbitration keeps idle-random signature below idle reactions", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isHovering: true,
    isKeyboardFocused: false
  }), "hover");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isHovering: true,
    isKeyboardFocused: false
  }), "hover");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isHovering: false,
    isKeyboardFocused: false
  }), "signature");
});

test("desktop pet visual arbitration does not emit thinking or message states", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const base = {
    isDragging: false,
    dragDirection: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isHovering: false,
    isKeyboardFocused: false
  };

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "running"
  }), "running");

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "idle"
  }), "idle");
});

test("desktop pet visual arbitration lets manual signature surface over hover", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "manual",
    canShowHoverReaction: true,
    isHovering: true,
    isKeyboardFocused: false
  }), "signature");
});

test("desktop pet context menu exposes manual signature actions", () => {
  assert.deepEqual(getDesktopPetContextMenuItems("classic")[0], {
    action: "signature",
    signatureId: "chant",
    label: "念经"
  });

  assert.deepEqual(getDesktopPetContextMenuItems("user:desk-cat", [
    {
      id: "chant",
      label: "念经",
      trigger: ["manual", "idle-random"],
      variants: [
        {
          path: "signatures/chant-1.webp",
          frameCount: 30,
          durationMs: 4200,
          weight: 2
        }
      ]
    },
    {
      id: "sleep",
      label: "打盹",
      trigger: ["idle-random"],
      variants: [
        {
          path: "signatures/sleep-1.webp",
          frameCount: 18,
          durationMs: 3000
        }
      ]
    }
  ]), [
    {
      action: "signature",
      signatureId: "chant",
      label: "念经"
    },
    {
      action: "hide",
      label: "关闭宠物"
    }
  ]);
});

test("desktop pet keeps built-in chant available only for the default pet", () => {
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS.map((option) => option.id), ["classic"]);
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].displayName, "小禅");
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].preview, "idle.webp");
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.idle, {
    path: "idle.webp",
    frameCount: 3,
    durationMs: 6000,
    loop: true
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.running, {
    path: "running.webp",
    frameCount: 12,
    durationMs: 1800,
    loop: true
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.done, {
    path: "done.webp",
    frameCount: 6,
    durationMs: 1200,
    loop: false,
    holdMs: 2500
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states["drag-moving"], {
    path: "drag-moving.webp",
    frameCount: 15,
    durationMs: 900,
    loop: true,
    mirror: true
  });
  assert.deepEqual(resolveDesktopPetSignatureActions("classic", [])[0], {
    id: "chant",
    label: "念经",
    trigger: ["manual", "idle-random"],
    variants: [
      {
        path: "signature/chant.webp",
        frameCount: 30,
        durationMs: 5200,
        weight: 1
      }
    ]
  });

  assert.deepEqual(resolveDesktopPetSignatureActions("user:pony", []), []);
  const ponyDanceAction = {
    id: "dance",
    label: "跳舞",
    trigger: ["manual", "idle-random"],
    variants: [
      {
        path: "signature/dance.webp",
        frameCount: 30,
        durationMs: 5200,
        weight: 1
      }
    ]
  };
  assert.deepEqual(resolveDesktopPetSignatureActions("user:pony", [ponyDanceAction]), [ponyDanceAction]);
  assert.deepEqual(getDesktopPetContextMenuItems("user:pony", [ponyDanceAction])[0], {
    action: "signature",
    signatureId: "dance",
    label: "跳舞"
  });
});

test("user desktop pet appearances expose strict renderer-safe asset protocol URLs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-pet-assets-"));
  try {
    const app = createApp(root);
    const petRoot = path.join(getDesktopPetsDataRoot(app), "pony");
    fs.mkdirSync(petRoot, { recursive: true });
    writeStrictUserPet(petRoot);

    const options = listUserDesktopPetAppearanceOptions(app);
    assert.equal(options.length, 1);
    assert.equal(options[0].id, "user:pony");
    assert.equal(options[0].assetBasePath, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/`);
    assert.equal(options[0].previewUrl, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/idle.png`);
    assert.deepEqual(options[0].states, {
      idle: { path: "idle.png" },
      running: { path: "running.png" },
      awaiting: { path: "awaiting.png" },
      done: { path: "done.png", holdMs: 2500 },
      error: { path: "error.png", holdMs: 3000 },
      hover: { path: "hover.png" },
      dragging: { path: "dragging.png" },
      "drag-moving": {
        path: "drag-moving.webp",
        frameCount: 15,
        durationMs: 900,
        loop: true,
        mirror: true
      }
    });
    assert.equal(options[0].signature?.[0]?.variants[0]?.path, "signature/dance.webp");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("user desktop pet appearances reject legacy manifest fields and state names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-user-pet-legacy-"));
  try {
    const app = createApp(root);
    const petRoot = path.join(getDesktopPetsDataRoot(app), "legacy");
    fs.mkdirSync(petRoot, { recursive: true });
    fs.writeFileSync(path.join(petRoot, "pet-idle.png"), "fake png", "utf8");
    fs.writeFileSync(path.join(petRoot, "pet.json"), `${JSON.stringify({
      id: "legacy",
      displayName: "Legacy",
      previewAssetPath: "pet-idle.png",
      states: {
        idle: { path: "pet-idle.png" },
        thinking: { path: "pet-thinking.png" },
        "dragging-moving": { path: "task-run-left.webp" }
      },
      signatureActions: []
    }, null, 2)}\n`, "utf8");

    assert.deepEqual(listUserDesktopPetAppearanceOptions(app), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop pet visual maps dragging movement onto a single mirrored state", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const base = {
    displayStatus: "idle",
    isDragging: true,
    dragDirection: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isHovering: false,
    isKeyboardFocused: false
  };

  assert.equal(deriveDesktopPetVisualStatus(base), "drag-moving");
  assert.equal(deriveDesktopPetVisualStatus({ ...base, dragDirection: "left" }), "drag-moving");
  assert.equal(deriveDesktopPetVisualStatus({ ...base, dragDirection: "right" }), "drag-moving");
});

test("desktop pet visual keeps running as the running state", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "running",
    isDragging: false,
    dragDirection: null,
    hasActiveSignature: false,
    hasMessageReaction: false,
    canShowHoverReaction: false,
    isHovering: false,
    isKeyboardFocused: false
  }), "running");
});
