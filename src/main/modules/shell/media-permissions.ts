import type { MediaPermissionWindowLike } from "./window-model";
import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";

export function configureMediaPermissions<TWindow extends MediaPermissionWindowLike>(options: {
  platform: DesktopPlatform;
  permissionSession: {
    setPermissionRequestHandler(
      handler: (
        contents: { id: number },
        permission: string,
        callback: (granted: boolean) => void,
        details: unknown
      ) => void
    ): void;
  };
  getMainWindow(): TWindow | null;
  askForMicrophoneAccess(): Promise<boolean>;
  isAllowedWebappMicrophoneRequest?: (
    contents: { id: number },
    details: unknown
  ) => boolean;
}) {
  options.permissionSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mainWindow = options.getMainWindow();
    const mainContentsId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null;
    const mediaTypes = details && typeof details === "object" && "mediaTypes" in details &&
      Array.isArray((details as { mediaTypes?: unknown }).mediaTypes)
      ? (details as { mediaTypes: string[] }).mediaTypes
      : undefined;

    const isMainWindowRequest = contents.id === mainContentsId;
    const isMainWindowAudioRequest = !mediaTypes || mediaTypes.includes("audio");
    const isWebappAudioOnlyRequest = mediaTypes !== undefined &&
      mediaTypes.includes("audio") &&
      !mediaTypes.includes("video");
    const allowed = permission === "media" &&
      (
        (isMainWindowRequest && isMainWindowAudioRequest) ||
        (
          !isMainWindowRequest &&
          isWebappAudioOnlyRequest &&
          options.isAllowedWebappMicrophoneRequest?.(contents, details) === true
        )
      );
    if (!allowed) {
      callback(false);
      return;
    }

    if (options.platform === "darwin") {
      void options.askForMicrophoneAccess()
        .then((granted) => {
          callback(granted);
        })
        .catch(() => {
          callback(false);
        });
      return;
    }

    callback(true);
  });
}
