import type { KanbanCurrentUser } from "../shared/contracts";
import { t } from "./i18n/main-i18n";

type AppPathProvider = {
  getPath: (name: "userData") => string;
};

type WsRequester = {
  isOpen: () => boolean;
  request: <T = unknown>(messageType: string, payload: unknown) => Promise<T>;
};

export type DesktopCloudSyncOptions = {
  app: AppPathProvider;
  getCurrentUser: () => KanbanCurrentUser;
  getDeviceId: () => string;
  wsClient: WsRequester;
  onChanged?: () => void;
  onDebug?: (message: string) => void;
};

export type DesktopCloudSyncRunResult = {
  ok: boolean;
  message: string;
  attempted: number;
  synced: number;
  conflicts: number;
  errors: number;
};

// Desktop V1 treats cloud issue bodies as read-only. Runtime keeps this engine
// as a no-op compatibility shell so older callers cannot upload issue changes.
export class DesktopCloudSyncEngine {
  constructor(_options: DesktopCloudSyncOptions) {}

  stop() {}

  async run(): Promise<DesktopCloudSyncRunResult> {
    return { ok: true, message: t("kanban.cloudSync.uploadDisabled"), attempted: 0, synced: 0, conflicts: 0, errors: 0 };
  }
}
