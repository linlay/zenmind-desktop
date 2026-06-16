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
  DEFAULT_DESKTOP_PET_BUILTIN_ID,
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
    "idle.webp",
    "jumping.webp",
    "moving-left.webp",
    "dragging.webp",
    "done.webp",
    "failed.webp",
    "running.webp",
    "awaiting.webp",
    "review.webp"
  ]) {
    fs.writeFileSync(path.join(petRoot, fileName), "fake asset", "utf8");
  }
  fs.writeFileSync(path.join(petRoot, "signature", "dance.webp"), "fake webp", "utf8");
  const manifest = {
    id: "pony",
    displayName: "小凌",
    version: "1.0.0",
    description: "Strict user pet",
    preview: "idle.webp",
    states: {
      idle: { path: "idle.webp", frameCount: 4, durationMs: 6000, loop: true },
      jumping: { path: "jumping.webp", frameCount: 4, durationMs: 1000, loop: false },
      "moving-left": {
        path: "moving-left.webp",
        frameCount: 8,
        durationMs: 900,
        loop: true,
        mirror: true
      },
      dragging: { path: "dragging.webp", frameCount: 4, durationMs: 900, loop: true },
      done: { path: "done.webp", frameCount: 6, durationMs: 1200, loop: false, holdMs: 2500 },
      failed: { path: "failed.webp", frameCount: 4, durationMs: 1000, loop: false, holdMs: 3000 },
      running: { path: "running.webp", frameCount: 8, durationMs: 1600, loop: true },
      awaiting: { path: "awaiting.webp", frameCount: 4, durationMs: 1200, loop: true },
      review: { path: "review.webp", frameCount: 4, durationMs: 1400, loop: true }
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
    activeStandardAction: null,
    hasActiveSignature: true,
    canShowHoverReaction: true,
    isReviewing: false,
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
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  }), "hover");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  }), "hover");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "idle",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "idle-random",
    canShowHoverReaction: true,
    isReviewing: false,
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
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isReviewing: false,
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
    activeStandardAction: null,
    hasActiveSignature: true,
    activeSignatureTrigger: "manual",
    canShowHoverReaction: true,
    isReviewing: false,
    isHovering: true,
    isKeyboardFocused: false
  }), "signature");
});

test("desktop pet context menu exposes manual signature actions", () => {
  if (DEFAULT_DESKTOP_PET_BUILTIN_ID === "cutej") {
    assert.deepEqual(getDesktopPetContextMenuItems("classic")[0], {
      action: "hide",
      label: "关闭宠物"
    });
  } else {
    assert.deepEqual(getDesktopPetContextMenuItems("classic")[0], {
      action: "signature",
      signatureId: "chant",
      label: "念经"
    });
  }

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

test("desktop pet exposes brand-specific built-in appearance defaults", () => {
  const isCuteJ = DEFAULT_DESKTOP_PET_BUILTIN_ID === "cutej";
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS.map((option) => option.id), ["classic"]);
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].displayName, isCuteJ ? "小君" : "小禅");
  assert.equal(DESKTOP_PET_APPEARANCE_OPTIONS[0].preview, "idle.webp");
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.idle, {
    path: "idle.webp",
    frameCount: isCuteJ ? 6 : 4,
    durationMs: 6000,
    loop: true
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.jumping, {
    path: "jumping.webp",
    frameCount: isCuteJ ? 5 : 4,
    durationMs: 1000,
    loop: false
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states["moving-left"], {
    path: "moving-left.webp",
    frameCount: 8,
    durationMs: 900,
    loop: true,
    mirror: true
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.dragging, {
    path: "dragging.webp",
    frameCount: isCuteJ ? 8 : 4,
    durationMs: 900,
    loop: true
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.done, {
    path: "done.webp",
    frameCount: isCuteJ ? 5 : 6,
    durationMs: 1200,
    loop: false,
    holdMs: 2500
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.failed, {
    path: "failed.webp",
    frameCount: isCuteJ ? 8 : 4,
    durationMs: 1000,
    loop: false,
    holdMs: 3000
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.running, {
    path: "running.webp",
    frameCount: isCuteJ ? 6 : 8,
    durationMs: 1600,
    loop: true
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.awaiting, {
    path: "awaiting.webp",
    frameCount: isCuteJ ? 6 : 4,
    durationMs: 1200,
    loop: true
  });
  assert.deepEqual(DESKTOP_PET_APPEARANCE_OPTIONS[0].states.review, {
    path: "review.webp",
    frameCount: isCuteJ ? 6 : 4,
    durationMs: 1400,
    loop: true
  });
  if (isCuteJ) {
    assert.deepEqual(resolveDesktopPetSignatureActions("classic", []), []);
  } else {
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
  }

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
    assert.equal(options[0].previewUrl, `${DESKTOP_PET_USER_ASSET_PROTOCOL}://pony/idle.webp`);
    assert.deepEqual(options[0].states, {
      idle: { path: "idle.webp", frameCount: 4, durationMs: 6000, loop: true },
      jumping: { path: "jumping.webp", frameCount: 4, durationMs: 1000, loop: false },
      "moving-left": {
        path: "moving-left.webp",
        frameCount: 8,
        durationMs: 900,
        loop: true,
        mirror: true
      },
      dragging: { path: "dragging.webp", frameCount: 4, durationMs: 900, loop: true },
      done: { path: "done.webp", frameCount: 6, durationMs: 1200, loop: false, holdMs: 2500 },
      failed: { path: "failed.webp", frameCount: 4, durationMs: 1000, loop: false, holdMs: 3000 },
      running: { path: "running.webp", frameCount: 8, durationMs: 1600, loop: true },
      awaiting: { path: "awaiting.webp", frameCount: 4, durationMs: 1200, loop: true },
      review: { path: "review.webp", frameCount: 4, durationMs: 1400, loop: true }
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

test("desktop pet visual maps dragging hold and movement onto standard states", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const base = {
    displayStatus: "idle",
    isDragging: true,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isReviewing: false,
    isHovering: false,
    isKeyboardFocused: false
  };

  assert.equal(deriveDesktopPetVisualStatus(base), "dragging");
  assert.equal(deriveDesktopPetVisualStatus({ ...base, dragDirection: "left" }), "moving-left");
  assert.equal(deriveDesktopPetVisualStatus({ ...base, dragDirection: "right" }), "moving-left");
});

test("desktop pet visual keeps running as the running state", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  assert.equal(deriveDesktopPetVisualStatus({
    displayStatus: "running",
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isReviewing: false,
    isHovering: false,
    isKeyboardFocused: false
  }), "running");
});

test("desktop pet visual maps review, failed, and rare idle jumping onto standard states", () => {
  const {
    deriveDesktopPetVisualStatus
  } = require("../dist-electron/shared/desktop-pet-visual.js");

  const base = {
    isDragging: false,
    dragDirection: null,
    activeStandardAction: null,
    hasActiveSignature: false,
    canShowHoverReaction: false,
    isHovering: false,
    isKeyboardFocused: false
  };

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "running",
    isReviewing: true
  }), "review");

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "error",
    isReviewing: false
  }), "failed");

  assert.equal(deriveDesktopPetVisualStatus({
    ...base,
    displayStatus: "idle",
    activeStandardAction: "jumping",
    isReviewing: false
  }), "jumping");
});
