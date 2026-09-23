import type { App } from "electron";
import type {
  EnterpriseChatDesktopAction,
  EnterpriseChatScreenshotMode,
  EnterpriseChatSnapshot
} from "../../../shared/contracts";
import type { DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { FetchLike, WebSocketLike } from "./connection-transport";

export type EnterpriseChatRuntimeOptions = {
  app: App;
  serverUrl?: string;
  getServerUrl?: () => string;
  initialEnabled?: boolean;
  fetchImpl?: FetchLike;
  createWebSocket?: (url: string) => WebSocketLike;
  getIdentityToken?: () => string | null;
  refreshIdentityToken?: () => Promise<string | null>;
  getDeviceInfo?: () => { deviceId: string; deviceName: string };
  platform?: NodeJS.Platform;
  selectFiles?: () => Promise<string[]>;
  selectAvatar?: () => Promise<string[]>;
  showSaveDialog?: (options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled?: boolean; filePath?: string }>;
  createSupportBundle?: () => Promise<{ filename: string; bytes: Buffer }>;
  captureScreenshot?: (mode: EnterpriseChatScreenshotMode) => Promise<{
    ok: boolean;
    message?: string;
    dataBase64?: string;
    mimeType?: string;
    cancelled?: boolean;
  }>;
  createSupportArtifact?: (
    action: string,
    args: Record<string, unknown>
  ) => Promise<{ filename: string; contentType: string; bytes: Buffer }>;
  executeDesktopAction?: (
    request: EnterpriseChatDesktopAction & {
      messageId: string;
      conversationId: string;
      senderId: string;
    }
  ) => Promise<{ response?: DesktopActionCallResponse; message: string }>;
  onStateChanged?: (snapshot: EnterpriseChatSnapshot) => void;
};
