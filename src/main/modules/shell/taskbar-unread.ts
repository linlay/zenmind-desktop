import { nativeImage, type BrowserWindow } from "electron";
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
  onError: (message: string, error: unknown) => void;
}) {
  let lastWindow: BrowserWindow | null = null;
  let lastCount = -1;

  return {
    refresh(snapshot: AssistantNavAgentItemsResult | undefined, force = false) {
      // macOS retains its existing Dock behavior; overlays are Windows-only.
      if (options.platform === "darwin") return;
      if (options.platform !== "win32") return;
      const window = options.getWindow();
      if (!window || window.isDestroyed()) return;
      const count = summarizeAssistantNavigationAttention(snapshot?.ok ? snapshot : {}).total.unreadCount;
      if (!force && window === lastWindow && count === lastCount) return;
      try {
        window.setOverlayIcon(count > 0 ? createTaskbarUnreadIcon(count) : null, count > 0 ? `${count} 个未读会话` : "");
        lastWindow = window;
        lastCount = count;
      } catch (error) {
        // A native badge failure must not interrupt the navigation projection.
        options.onError("[taskbar] Failed to update unread badge", error);
      }
    }
  };
}
