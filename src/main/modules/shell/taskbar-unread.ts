import { t } from "../../support/i18n/main-i18n";
import { nativeImage, type BrowserWindow, type Dock } from "electron";
import type { AssistantNavAgentItemsResult } from "../../../shared/contracts";
import { summarizeAssistantNavigationAttention } from "../../../shared/assistant-navigation-attention";

export function createTaskbarUnreadIcon(count: number) {
  // Load the existing rasterizer only on Windows when a badge is needed.
  const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const canvas = createCanvas(32, 32);
  const context = canvas.getContext("2d");
  const label = count > 99 ? "99+" : String(count);
  context.fillStyle = "#dc2626";
  context.beginPath();
  context.arc(16, 16, 16, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `bold ${label.length > 2 ? 16 : label.length > 1 ? 20 : 24}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 16, 16);
  return nativeImage.createFromBuffer(canvas.toBuffer("image/png"));
}

export function createTaskbarUnreadController(options: {
  platform: NodeJS.Platform;
  getWindow: () => BrowserWindow | null;
  getDock: () => Pick<Dock, "setBadge"> | undefined;
  onError: (message: string, error: unknown) => void;
}) {
  let lastWindow: BrowserWindow | null = null;
  let lastDock: ReturnType<typeof options.getDock>;
  let lastCount = -1;
  let lastDescription = "";

  return {
    refresh(snapshot: AssistantNavAgentItemsResult | undefined, force = false) {
      if (options.platform === "darwin") {
        // The Dock badge belongs to the app and keeps updating without a window.
        const dock = options.getDock();
        if (!dock) return;
        const count = summarizeAssistantNavigationAttention(snapshot?.ok ? snapshot : {}).total.unreadCount;
        if (!force && dock === lastDock && count === lastCount) return;
        try {
          dock.setBadge(count > 99 ? "99+" : count > 0 ? String(count) : "");
          lastDock = dock;
          lastCount = count;
        } catch (error) {
          // Retry on the next snapshot without interrupting navigation updates.
          options.onError("[dock] Failed to update unread badge", error);
        }
        return;
      }
      if (options.platform !== "win32") return;
      const window = options.getWindow();
      if (!window || window.isDestroyed()) return;
      const count = summarizeAssistantNavigationAttention(snapshot?.ok ? snapshot : {}).total.unreadCount;
      const description = count > 0 ? t("shell.unreadConversations", { count }) : "";
      if (!force && window === lastWindow && count === lastCount && description === lastDescription) return;
      try {
        window.setOverlayIcon(count > 0 ? createTaskbarUnreadIcon(count) : null, description);
        lastWindow = window;
        lastCount = count;
        lastDescription = description;
      } catch (error) {
        // A native badge failure must not interrupt the navigation projection.
        options.onError("[taskbar] Failed to update unread badge", error);
      }
    }
  };
}
