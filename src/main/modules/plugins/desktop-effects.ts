import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, screen } from "electron";
import type { App } from "electron";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_SELECTED_ID,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  listUserDesktopPets,
  readDesktopPetStoredState
} from "../pet";
import { t } from "../../support/i18n/main-i18n";
import { getRendererEntry } from "../../infrastructure/electron/renderer-route";

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
  maxVisibleTasks?: unknown;
};

type CalendarOverlayEventInput = {
  title?: unknown;
  time?: unknown;
  status?: unknown;
};

type CalendarOverlayDayInput = {
  date?: unknown;
  label?: unknown;
  events?: unknown;
};

type CalendarOverlayInput = {
  title?: unknown;
  days?: unknown;
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
let calendarOverlayWindow: BrowserWindow | null = null;
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

function getBuiltinDesktopPetAssetUrl(appearanceId: string, preview: string) {
  const normalized = appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID ? "" : appearanceId;
  const safePreview = preview.replace(/\\/gu, "/").replace(/^\/+/u, "") || "idle.webp";
  const relativeParts = normalized
    ? ["desktop-pet", normalized, safePreview]
    : ["desktop-pet", safePreview];
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
    ? DEFAULT_DESKTOP_PET_SELECTED_ID
    : settings.selectedPetId || (settings.appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID
      ? DEFAULT_DESKTOP_PET_SELECTED_ID
      : `builtin:${settings.appearanceId}`);

  if (!requestedDefault && selectedPetId.startsWith("user:")) {
    const userPet = listUserDesktopPets(app).find((pet) => pet.id === selectedPetId);
    if (userPet) {
      const preview = readManifestText(userPet.manifest, ["preview"]);
      const safeRelative = preview.replace(/\\/gu, "/").replace(/^\/+/u, "");
      const url = safeRelative ? toFileUrlIfExists(path.join(userPet.rootPath, safeRelative)) : "";
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
  const url = getBuiltinDesktopPetAssetUrl(option.id, option.preview);
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
    title: title || preview || t("desktopPet.task.untitled"),
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
  const maxVisibleTasks = Math.max(1, Math.min(10, Math.round(Number(input.maxVisibleTasks) || 3)));
  const visibleTasks = tasks.slice(0, maxVisibleTasks);
  const hiddenCount = Math.max(0, runningTaskCount - visibleTasks.length);
  const defaultTitle = t("desktopPet.activity.defaultTitle");
  const title = String(input.title || defaultTitle).trim() || defaultTitle;
  const statusText = runningTaskCount > 0 ? t("desktopPet.activity.runningCount", { count: runningTaskCount }) : t("desktopPet.activity.idle");
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
.island{width:calc(100% - 24px);max-width:420px;margin-top:10px;border-radius:28px;background:rgba(8,11,18,.94);box-shadow:0 18px 55px rgba(0,0,0,.28),inset 0 0 0 1px rgba(255,255,255,.08);backdrop-filter:blur(22px);padding:13px 16px 14px}
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
  ${hiddenCount > 0 ? `<div class="more">${escapeHtml(t("desktopPet.activity.moreTasks", { count: hiddenCount }))}</div>` : ""}
</main>
</body>
</html>`;
}

function getActivityIslandBounds(visibleTaskCount = 3) {
  const display = screen.getPrimaryDisplay();
  const taskCount = Math.max(1, Math.min(10, visibleTaskCount));
  if (process.platform === "darwin") {
    const bounds = display.bounds;
    const width = Math.max(220, Math.min(460, bounds.width - 36));
    return {
      x: Math.round(bounds.x + (bounds.width - width) / 2),
      y: Math.round(bounds.y),
      width,
      height: Math.min(Math.max(198, 86 + taskCount * 42), Math.max(180, bounds.height - 24))
    };
  }
  if (process.platform === "win32") {
    const bounds = display.workArea;
    const width = Math.max(220, Math.min(388, bounds.width - 36));
    return {
      x: Math.round(bounds.x + bounds.width - width - 18),
      y: Math.round(bounds.y + 18),
      width,
      height: Math.min(Math.max(198, 86 + taskCount * 42), Math.max(180, bounds.height - 36))
    };
  }
  const bounds = display.workArea;
  const width = Math.max(220, Math.min(420, bounds.width - 36));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + 12),
    width,
    height: Math.min(Math.max(198, 86 + taskCount * 42), Math.max(180, bounds.height - 24))
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
  const tasks = normalizeActivityIslandTasks(input.tasks);
  const maxVisibleTasks = Math.max(1, Math.min(10, Math.round(Number(input.maxVisibleTasks) || 3)));
  const runningTaskCount = Math.max(
    tasks.length,
    Math.max(0, Math.round(Number(input.runningTaskCount) || 0))
  );
  if (runningTaskCount <= 0) {
    return hideDesktopActivityIsland();
  }
  const win = ensureActivityIslandWindow();
  win.setBounds(getActivityIslandBounds(Math.min(tasks.length, maxVisibleTasks)), false);
  loadHtml(win, getActivityIslandHtml({ ...input, tasks, runningTaskCount, maxVisibleTasks }));
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.showInactive();
    }
  });
  if (!win.isVisible()) {
    win.showInactive();
  }
  if (process.platform === "darwin") {
    win.setAlwaysOnTop(true, "screen-saver");
  } else if (process.platform === "win32") {
    win.setAlwaysOnTop(true, "pop-up-menu");
  } else {
    win.setAlwaysOnTop(true);
  }
  return {
    shown: true,
    platform: process.platform,
    mode: process.platform === "darwin" ? "dynamic-island" : "desktop-widget",
    runningTaskCount,
    visibleTaskCount: Math.min(tasks.length, maxVisibleTasks)
  };
}

export function hideDesktopActivityIsland() {
  if (activityIslandWindow && !activityIslandWindow.isDestroyed()) {
    activityIslandWindow.close();
  }
  activityIslandWindow = null;
  return { hidden: true };
}

function normalizeCalendarOverlayEvent(value: CalendarOverlayEventInput) {
  const title = String(value.title ?? "").replace(/\s+/gu, " ").trim().slice(0, 120);
  if (!title) {
    return null;
  }
  const time = String(value.time ?? "").replace(/\s+/gu, " ").trim().slice(0, 32);
  const status = value.status === "done" || value.status === "skipped"
    ? value.status
    : "planned";
  return { title, time, status };
}

function normalizeCalendarOverlayDays(input: unknown) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item): item is CalendarOverlayDayInput => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const date = String(item.date ?? "").trim().slice(0, 10);
      const label = String(item.label ?? date).replace(/\s+/gu, " ").trim().slice(0, 32);
      const events = Array.isArray(item.events)
        ? item.events
          .filter((event): event is CalendarOverlayEventInput => Boolean(event) && typeof event === "object" && !Array.isArray(event))
          .map(normalizeCalendarOverlayEvent)
          .filter((event): event is NonNullable<ReturnType<typeof normalizeCalendarOverlayEvent>> => Boolean(event))
          .slice(0, 6)
        : [];
      return { date, label: label || date, events };
    })
    .filter((day) => day.date || day.label)
    .slice(0, 3);
}

function getCalendarOverlayHtml(input: CalendarOverlayInput) {
  const title = String(input.title ?? "最近三天").replace(/\s+/gu, " ").trim().slice(0, 64) || "最近三天";
  const days = normalizeCalendarOverlayDays(input.days);
  const columns = days.map((day) => {
    const rows = day.events.length > 0
      ? day.events.map((event) => `
        <li class="event is-${event.status}">
          <span class="time">${escapeHtml(event.time || "全天")}</span>
          <span class="event-title">${escapeHtml(event.title)}</span>
        </li>
      `).join("")
      : '<li class="empty">暂无安排</li>';
    return `
      <section class="day">
        <header><strong>${escapeHtml(day.label)}</strong><span>${escapeHtml(day.date)}</span></header>
        <ul>${rows}</ul>
      </section>
    `;
  }).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182033}
body{padding:12px}
.panel{height:calc(100% - 24px);border:1px solid rgba(118,132,160,.22);border-radius:22px;background:rgba(250,252,255,.94);box-shadow:0 20px 60px rgba(30,48,82,.22);backdrop-filter:blur(24px);padding:15px;overflow:hidden}
h1{margin:0 0 12px;font-size:15px;line-height:1.2}
.days{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;height:calc(100% - 30px)}
.day{min-width:0;border-radius:14px;background:rgba(235,240,248,.8);padding:10px;overflow:hidden}
.day header{display:grid;gap:2px;margin-bottom:8px}.day strong{font-size:12px}.day header span{font-size:10px;color:#768197}
ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}.event{display:grid;gap:2px;padding:7px;border-radius:9px;background:#fff;box-shadow:inset 3px 0 #4f7cff}.event.is-done{opacity:.62;box-shadow:inset 3px 0 #35a875}.event.is-skipped{opacity:.48;box-shadow:inset 3px 0 #a3aab8}.time{font-size:9px;color:#707b90}.event-title{font-size:11px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.empty{padding:14px 4px;color:#8c95a7;font-size:10px;text-align:center}
</style>
</head>
<body><main class="panel"><h1>${escapeHtml(title)}</h1><div class="days">${columns}</div></main></body>
</html>`;
}

function getCalendarOverlayBounds() {
  const display = screen.getPrimaryDisplay();
  const bounds = display.workArea;
  const width = Math.max(240, Math.min(560, bounds.width - 36));
  const height = Math.max(180, Math.min(300, bounds.height - 36));
  if (process.platform === "darwin") {
    return {
      x: Math.round(bounds.x + bounds.width - width - 18),
      y: Math.round(bounds.y + 18),
      width,
      height
    };
  }
  if (process.platform === "win32") {
    return {
      x: Math.round(bounds.x + bounds.width - width - 18),
      y: Math.round(bounds.y + 18),
      width,
      height
    };
  }
  return {
    x: Math.round(bounds.x + bounds.width - width - 18),
    y: Math.round(bounds.y + 18),
    width,
    height
  };
}

function ensureCalendarOverlayWindow() {
  if (calendarOverlayWindow && !calendarOverlayWindow.isDestroyed()) {
    return calendarOverlayWindow;
  }
  const win = new BrowserWindow({
    ...getCalendarOverlayBounds(),
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
    if (calendarOverlayWindow === win) {
      calendarOverlayWindow = null;
    }
  });
  calendarOverlayWindow = win;
  return win;
}

export function updateDesktopCalendarOverlay(input: CalendarOverlayInput = {}) {
  const days = normalizeCalendarOverlayDays(input.days);
  if (days.length === 0) {
    return hideDesktopCalendarOverlay();
  }
  const win = ensureCalendarOverlayWindow();
  win.setBounds(getCalendarOverlayBounds(), false);
  loadHtml(win, getCalendarOverlayHtml({ ...input, days }));
  if (process.platform === "darwin") {
    win.setAlwaysOnTop(true, "floating");
  } else if (process.platform === "win32") {
    win.setAlwaysOnTop(true, "pop-up-menu");
  } else {
    win.setAlwaysOnTop(true);
  }
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.showInactive();
    }
  });
  if (!win.isVisible()) {
    win.showInactive();
  }
  return { shown: true, dayCount: days.length, platform: process.platform };
}

export function hideDesktopCalendarOverlay() {
  if (calendarOverlayWindow && !calendarOverlayWindow.isDestroyed()) {
    calendarOverlayWindow.close();
  }
  calendarOverlayWindow = null;
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
  const defaultMessage = t("desktopPet.banner.defaultMessage");
  const message = String(input.message || defaultMessage).trim() || defaultMessage;
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
  const defaultTitle = t("desktopPet.systemUpdate.title");
  const defaultMessage = t("desktopPet.systemUpdate.message");
  const title = String(input.title || defaultTitle).trim() || defaultTitle;
  const message = String(input.message || defaultMessage).trim() || defaultMessage;
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
  getActivityIslandHtml,
  getCalendarOverlayHtml,
  normalizeActivityIslandTasks,
  normalizeCalendarOverlayDays,
  normalizeLocalHttpUrl,
  resolveDesktopPetBannerAsset
};
