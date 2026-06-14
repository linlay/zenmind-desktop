import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, screen } from "electron";
import type { App } from "electron";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  listUserDesktopPets,
  readDesktopPetStoredState
} from "./copilot/pet-copilot/desktop-pet";
import { getRendererEntry } from "./renderer-route";

type DesktopPetBannerInput = {
  message?: unknown;
  durationMs?: unknown;
  appearanceId?: unknown;
  motion?: unknown;
};

type SystemUpdateOverlayInput = {
  title?: unknown;
  message?: unknown;
  durationMs?: unknown;
  allowEscape?: unknown;
};

type ActivityIslandTaskInput = {
  agentDisplayName?: unknown;
  title?: unknown;
  preview?: unknown;
  status?: unknown;
};

type ActivityIslandInput = {
  tasks?: unknown;
  runningTaskCount?: unknown;
  title?: unknown;
};

type ClipboardPaletteInput = {
  url?: unknown;
  width?: unknown;
  height?: unknown;
};

type DesktopPetBannerAsset = {
  label: string;
  url: string;
  source: "builtin" | "user" | "fallback";
};

let activityIslandWindow: BrowserWindow | null = null;
let clipboardPaletteWindow: BrowserWindow | null = null;
let clipboardPaletteOwnerPluginId = "";

function clampDurationMs(value: unknown, fallback: number, max: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(1000, Math.min(Math.trunc(numberValue), max));
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function clampWindowDimension(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(numberValue), max));
}

function loadHtml(window: BrowserWindow, html: string) {
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function readManifestText(manifest: Record<string, unknown>, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = manifest[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function toFileUrlIfExists(filePath: string) {
  return fs.existsSync(filePath) ? pathToFileURL(filePath).toString() : "";
}

function getBuiltinDesktopPetAssetUrl(appearanceId: string) {
  const normalized = appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID ? "" : appearanceId;
  const relativeParts = normalized
    ? ["desktop-pet", normalized, "pet-idle.png"]
    : ["desktop-pet", "pet-idle.png"];
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    return `${devServerUrl.replace(/\/$/u, "")}/${relativeParts.join("/")}`;
  }
  const rendererEntry = getRendererEntry();
  if (/^https?:\/\//iu.test(rendererEntry)) {
    return `${rendererEntry.replace(/\/$/u, "")}/${relativeParts.join("/")}`;
  }
  return toFileUrlIfExists(path.join(path.dirname(rendererEntry), ...relativeParts));
}

function resolveDesktopPetBannerAsset(app: App, appearanceRequest: unknown): DesktopPetBannerAsset {
  const settings = readDesktopPetStoredState(app, process.platform);
  const requestedDefault = appearanceRequest === "default";
  const selectedPetId = requestedDefault
    ? "builtin:zenmi"
    : settings.selectedPetId || (settings.appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
      ? "builtin:zenmi"
      : `builtin:${settings.appearanceId}`);

  if (!requestedDefault && selectedPetId.startsWith("user:")) {
    const userPet = listUserDesktopPets(app).find((pet) => pet.id === selectedPetId);
    if (userPet) {
      const relative = readManifestText(userPet.manifest, ["idleAssetPath", "idle", "previewAssetPath", "preview"], "pet-idle.png")
        .replace(/\\/gu, "/")
        .replace(/^\/+/u, "");
      const url = toFileUrlIfExists(path.join(userPet.rootPath, relative));
      if (url) {
        return {
          label: readManifestText(userPet.manifest, ["displayName", "name"], userPet.petId),
          url,
          source: "user"
        };
      }
    }
  }

  const selectedAppearanceId = requestedDefault
    ? DEFAULT_DESKTOP_PET_APPEARANCE_ID
    : settings.appearanceId;
  const option = DESKTOP_PET_APPEARANCE_OPTIONS.find((item) => item.id === selectedAppearanceId) ??
    DESKTOP_PET_APPEARANCE_OPTIONS[0];
  const url = getBuiltinDesktopPetAssetUrl(option.id);
  if (url) {
    return {
      label: option.displayName,
      url,
      source: "builtin"
    };
  }
  return {
    label: option.displayName,
    url: "",
    source: "fallback"
  };
}

function normalizeActivityIslandTask(value: ActivityIslandTaskInput) {
  const title = String(value.title || "").replace(/\s+/gu, " ").trim();
  const agentDisplayName = String(value.agentDisplayName || "").replace(/\s+/gu, " ").trim();
  const preview = String(value.preview || "").replace(/\s+/gu, " ").trim();
  const status = value.status === "awaiting" ? "awaiting" : "running";
  return {
    title: title || preview || "未命名任务",
    agentDisplayName: agentDisplayName || "Agent",
    preview,
    status
  };
}

function normalizeActivityIslandTasks(input: unknown) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item): item is ActivityIslandTaskInput => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map(normalizeActivityIslandTask)
    .slice(0, 10);
}

function getActivityIslandHtml(input: ActivityIslandInput) {
  const tasks = normalizeActivityIslandTasks(input.tasks);
  const runningTaskCount = Math.max(
    tasks.length,
    Math.max(0, Math.round(Number(input.runningTaskCount) || 0))
  );
  const visibleTasks = tasks.slice(0, 3);
  const hiddenCount = Math.max(0, runningTaskCount - visibleTasks.length);
  const title = String(input.title || "运行中的 Chat").trim() || "运行中的 Chat";
  const statusText = runningTaskCount > 0 ? `${runningTaskCount} 个运行中` : "空闲";
  const rows = visibleTasks.map((task) => `
    <li class="task is-${task.status}">
      <span class="dot"></span>
      <span class="copy">
        <strong>${escapeHtml(task.title)}</strong>
        <em>${escapeHtml(task.agentDisplayName)}${task.preview ? ` · ${escapeHtml(task.preview)}` : ""}</em>
      </span>
    </li>
  `).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f8fafc}
body{display:grid;place-items:start center}
.island{width:420px;margin-top:10px;border-radius:28px;background:rgba(8,11,18,.94);box-shadow:0 18px 55px rgba(0,0,0,.28),inset 0 0 0 1px rgba(255,255,255,.08);backdrop-filter:blur(22px);padding:13px 16px 14px}
.head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:9px}
.title{font-size:13px;font-weight:760}
.status{font-size:12px;color:#a7f3d0;font-weight:700;white-space:nowrap}
ul{list-style:none;margin:0;padding:0;display:grid;gap:7px}
.task{display:grid;grid-template-columns:10px minmax(0,1fr);gap:9px;align-items:center;min-height:34px}
.dot{width:8px;height:8px;border-radius:999px;background:#38bdf8;box-shadow:0 0 18px rgba(56,189,248,.75)}
.task.is-awaiting .dot{background:#fbbf24;box-shadow:0 0 18px rgba(251,191,36,.75)}
.copy{min-width:0;display:grid;gap:2px}
strong,em{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
strong{font-size:13px;line-height:1.2}
em{font-style:normal;font-size:11px;line-height:1.2;color:#aeb9c8}
.more{margin-top:7px;font-size:11px;color:#9ca3af;text-align:center}
</style>
</head>
<body>
<main class="island">
  <div class="head"><div class="title">${escapeHtml(title)}</div><div class="status">${escapeHtml(statusText)}</div></div>
  <ul>${rows}</ul>
  ${hiddenCount > 0 ? `<div class="more">还有 ${hiddenCount} 个任务</div>` : ""}
</main>
</body>
</html>`;
}

function getActivityIslandBounds() {
  const display = screen.getPrimaryDisplay();
  const bounds = process.platform === "darwin" ? display.bounds : display.workArea;
  const width = Math.min(460, Math.max(320, bounds.width - 48));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y),
    width,
    height: 198
  };
}

function ensureActivityIslandWindow() {
  if (activityIslandWindow && !activityIslandWindow.isDestroyed()) {
    return activityIslandWindow;
  }
  const bounds = getActivityIslandBounds();
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on("closed", () => {
    if (activityIslandWindow === win) {
      activityIslandWindow = null;
    }
  });
  activityIslandWindow = win;
  return win;
}

export function updateDesktopActivityIsland(input: ActivityIslandInput = {}) {
  if (process.platform !== "darwin") {
    return { shown: false, unsupported: true, platform: process.platform };
  }
  const tasks = normalizeActivityIslandTasks(input.tasks);
  const runningTaskCount = Math.max(
    tasks.length,
    Math.max(0, Math.round(Number(input.runningTaskCount) || 0))
  );
  if (runningTaskCount <= 0) {
    return hideDesktopActivityIsland();
  }
  const win = ensureActivityIslandWindow();
  win.setBounds(getActivityIslandBounds(), false);
  loadHtml(win, getActivityIslandHtml({ ...input, tasks, runningTaskCount }));
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.showInactive();
    }
  });
  if (!win.isVisible()) {
    win.showInactive();
  }
  win.setAlwaysOnTop(true, "screen-saver");
  return { shown: true, runningTaskCount, visibleTaskCount: Math.min(tasks.length, 3) };
}

export function hideDesktopActivityIsland() {
  if (activityIslandWindow && !activityIslandWindow.isDestroyed()) {
    activityIslandWindow.close();
  }
  activityIslandWindow = null;
  return { hidden: true };
}

function normalizeLocalHttpUrl(value: unknown) {
  const raw = String(value || "").trim();
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:") {
    throw new Error("clipboard palette URL must use http");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("clipboard palette URL must be local");
  }
  return parsed.toString();
}

function getClipboardPaletteBounds(input: ClipboardPaletteInput) {
  const display = screen.getPrimaryDisplay();
  const workArea = process.platform === "darwin" ? display.workArea : display.bounds;
  const width = Math.min(
    clampWindowDimension(input.width, 520, 360, 760),
    Math.max(320, workArea.width - 32)
  );
  const height = Math.min(
    clampWindowDimension(input.height, 520, 320, 760),
    Math.max(280, workArea.height - 32)
  );
  if (process.platform === "darwin") {
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + Math.max(16, (workArea.height - height) * 0.22)),
      width,
      height
    };
  }
  if (process.platform === "win32") {
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height
    };
  }
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height
  };
}

export function showDesktopClipboardPalette(pluginId: string, input: ClipboardPaletteInput = {}) {
  const url = normalizeLocalHttpUrl(input.url);
  const bounds = getClipboardPaletteBounds(input);
  if (clipboardPaletteWindow && !clipboardPaletteWindow.isDestroyed()) {
    clipboardPaletteOwnerPluginId = pluginId;
    clipboardPaletteWindow.setBounds(bounds, false);
    void clipboardPaletteWindow.loadURL(url);
    clipboardPaletteWindow.show();
    clipboardPaletteWindow.focus();
    return { shown: true, reused: true };
  }
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#111318",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  clipboardPaletteOwnerPluginId = pluginId;
  clipboardPaletteWindow = win;
  if (process.platform === "darwin") {
    win.setAlwaysOnTop(true, "floating");
  } else if (process.platform === "win32") {
    win.setAlwaysOnTop(true, "pop-up-menu");
  } else {
    win.setAlwaysOnTop(true);
  }
  win.on("blur", () => {
    if (!win.isDestroyed()) {
      win.hide();
    }
  });
  win.on("closed", () => {
    if (clipboardPaletteWindow === win) {
      clipboardPaletteWindow = null;
      clipboardPaletteOwnerPluginId = "";
    }
  });
  void win.loadURL(url).then(() => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
  return { shown: true, reused: false };
}

export function hideDesktopClipboardPalette(pluginId?: string) {
  if (
    pluginId &&
    clipboardPaletteOwnerPluginId &&
    clipboardPaletteOwnerPluginId !== pluginId
  ) {
    return { hidden: false, owner: clipboardPaletteOwnerPluginId };
  }
  if (clipboardPaletteWindow && !clipboardPaletteWindow.isDestroyed()) {
    clipboardPaletteWindow.hide();
  }
  return { hidden: true };
}

export function showDesktopPetBanner(app: App, input: DesktopPetBannerInput = {}) {
  const message = String(input.message || "该休息一下啦").trim() || "该休息一下啦";
  const durationMs = clampDurationMs(input.durationMs, 9000, 30000);
  if (input.motion && input.motion !== "center-cross") {
    throw new Error("desktopPet.runBanner only supports center-cross motion");
  }
  const asset = resolveDesktopPetBannerAsset(app, input.appearanceId);
  const display = screen.getPrimaryDisplay();
  let bounds: Electron.Rectangle;
  if (process.platform === "darwin") {
    bounds = display.workArea;
  } else if (process.platform === "win32") {
    bounds = display.bounds;
  } else {
    bounds = display.workArea;
  }
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  if (process.platform === "darwin") {
    win.setAlwaysOnTop(true, "screen-saver");
  } else if (process.platform === "win32") {
    win.setAlwaysOnTop(true, "pop-up-menu");
  } else {
    win.setAlwaysOnTop(true);
  }
  loadHtml(win, `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.runner{position:absolute;top:50%;left:-360px;display:flex;align-items:center;gap:18px;transform:translateY(-50%);animation:cross ${durationMs}ms linear forwards}
.figure{width:112px;height:112px;display:grid;place-items:center;filter:drop-shadow(0 18px 28px rgba(24,42,78,.26))}
.figure img{width:112px;height:112px;object-fit:contain}
.fallback{width:104px;height:104px;border-radius:32px;background:linear-gradient(135deg,#65d6ad,#4f7cff);display:grid;place-items:center;color:#fff;font-weight:800;font-size:30px}
.banner{min-width:280px;max-width:560px;padding:18px 26px;border-radius:18px;background:rgba(255,255,255,.94);box-shadow:0 18px 52px rgba(24,42,78,.24);color:#172033;font-size:30px;font-weight:700;white-space:nowrap}
.tag{font-size:11px;opacity:.52;margin-top:5px;font-weight:600}
@keyframes cross{0%{left:-380px}100%{left:calc(100% + 120px)}}
</style>
</head>
<body>
<div class="runner">
  <div class="figure">${asset.url ? `<img src="${escapeHtml(asset.url)}" alt="" />` : '<div class="fallback">Z</div>'}</div>
  <div><div class="banner">${escapeHtml(message)}</div><div class="tag">${escapeHtml(asset.label)}</div></div>
</div>
</body>
</html>`);
  win.once("ready-to-show", () => win.showInactive());
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.close();
    }
  }, durationMs + 500);
  return { shown: true, durationMs, appearanceId: asset.label, assetSource: asset.source };
}

export function showSystemUpdateOverlay(input: SystemUpdateOverlayInput = {}) {
  const title = String(input.title || "系统正在升级").trim() || "系统正在升级";
  const message = String(input.message || "请保持电源连接，系统正在应用更新。").trim() || "请保持电源连接，系统正在应用更新。";
  const durationMs = clampDurationMs(input.durationMs, 60000, 300000);
  const allowEscape = input.allowEscape !== false;
  const display = screen.getPrimaryDisplay();
  let bounds: Electron.Rectangle;
  if (process.platform === "darwin") {
    bounds = display.bounds;
  } else if (process.platform === "win32") {
    bounds = display.bounds;
  } else {
    bounds = display.bounds;
  }
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: true,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#05070d",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.platform === "darwin") {
    win.setAlwaysOnTop(true, "screen-saver");
  } else if (process.platform === "win32") {
    win.setAlwaysOnTop(true, "pop-up-menu");
  } else {
    win.setAlwaysOnTop(true);
  }
  win.webContents.on("before-input-event", (event, inputEvent) => {
    if (allowEscape && inputEvent.key === "Escape") {
      event.preventDefault();
      win.close();
    }
  });
  loadHtml(win, `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#05070d;color:#f7fbff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:grid;place-items:center}
.panel{text-align:center;width:min(760px,80vw)}
.spinner{width:96px;height:96px;margin:0 auto 34px;border-radius:50%;border:9px solid rgba(255,255,255,.16);border-top-color:#67e8f9;animation:spin 1.1s linear infinite}
h1{font-size:48px;line-height:1.16;margin:0 0 18px;font-weight:750}
p{font-size:22px;line-height:1.65;margin:0;color:#c6d3e1}
.bar{height:8px;border-radius:999px;margin:42px auto 0;background:rgba(255,255,255,.14);overflow:hidden}
.fill{height:100%;width:42%;border-radius:inherit;background:linear-gradient(90deg,#67e8f9,#a7f3d0);animation:progress ${durationMs}ms ease-in-out forwards}
.hint{margin-top:28px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#7d8ea5}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes progress{0%{width:12%}100%{width:100%}}
</style>
</head>
<body>
<main class="panel">
<div class="spinner"></div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<div class="bar"><div class="fill"></div></div>
${allowEscape ? '<div class="hint">Press Esc to close</div>' : ""}
</main>
</body>
</html>`);
  win.once("ready-to-show", () => win.show());
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.close();
    }
  }, durationMs);
  return { shown: true, durationMs };
}

export const __testInternals = {
  resolveDesktopPetBannerAsset
};
