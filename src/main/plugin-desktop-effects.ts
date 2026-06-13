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

type DesktopPetBannerAsset = {
  label: string;
  url: string;
  source: "builtin" | "user" | "fallback";
};

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
