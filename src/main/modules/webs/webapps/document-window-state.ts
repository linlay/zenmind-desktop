import fs from "node:fs";
import path from "node:path";
import type { App, Rectangle } from "electron";
import { getDesktopWebappStateRoot } from "../../../infrastructure/filesystem/user-paths";
import { documentIdSchema } from "../../../../shared/webapp-document-windows";

export type DocumentWindowPreference = {
  bounds: Rectangle;
  open: boolean;
  alwaysOnTop: boolean;
  color: string;
};
export type DocumentWindowPreferences = Record<string, DocumentWindowPreference>;

export function fitDocumentBounds(bounds: Rectangle, displays: Rectangle[]): Rectangle {
  const area = displays.find(area => bounds.x + bounds.width > area.x && bounds.x < area.x + area.width &&
    bounds.y + bounds.height > area.y && bounds.y < area.y + area.height) ?? displays[0]!;
  const width = Math.min(Math.max(240, bounds.width), area.width);
  const height = Math.min(Math.max(180, bounds.height), area.height);
  return { width, height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height) };
}

export function readDocumentWindows(app: App, webappId: string): DocumentWindowPreferences {
  try {
    const stored: unknown = JSON.parse(fs.readFileSync(path.join(getDesktopWebappStateRoot(app, webappId), "document-windows.json"), "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const result: DocumentWindowPreferences = {};
    for (const [id, raw] of Object.entries(stored)) {
      if (!documentIdSchema.safeParse(id).success || !raw || typeof raw !== "object") continue;
      const { bounds, open, alwaysOnTop, color } = raw;
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) continue;
      result[id] = { bounds, open: open === true, alwaysOnTop: alwaysOnTop === true,
        color: typeof color === "string" && /^#[a-fA-F0-9]{6}$/u.test(color) ? color : "#fff1ad" };
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Unable to read document window positions", error);
    return {};
  }
}

export function writeDocumentWindows(app: App, webappId: string, state: DocumentWindowPreferences) {
  const file = path.join(getDesktopWebappStateRoot(app, webappId), "document-windows.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function documentWindowOptions(platform: string, bounds: Rectangle, color: string) {
  const common = { ...bounds, minWidth: 240, minHeight: 180, show: false, frame: false,
    resizable: true, maximizable: false, fullscreenable: false, hasShadow: true, backgroundColor: color };
  if (platform === "darwin") return { ...common, roundedCorners: true, type: "normal" as const };
  if (platform === "win32") return { ...common, thickFrame: true, autoHideMenuBar: true, skipTaskbar: false };
  return common;
}
