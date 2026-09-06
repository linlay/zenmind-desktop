import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions
} from "electron";

export type NativeDialogVisibilityControllerOptions = {
  platform: NodeJS.Platform;
  getTargetWindows: () => Array<BrowserWindow | null>;
};

export class NativeDialogVisibilityController {
  private visibilityDepth = 0;

  constructor(private readonly options: NativeDialogVisibilityControllerOptions) {}

  isOpen() {
    return this.visibilityDepth > 0;
  }

  async showFileDialog(options: OpenDialogOptions, ownerWindow: BrowserWindow | null) {
    const endNativeDialogVisibility = this.beginVisibility();
    try {
      if (this.options.platform === "darwin") {
        // macOS sheets can appear below transparent-window renderer overlays; let the UI hide them first.
        await waitForNativeDialogLayout();
      } else if (this.options.platform === "win32") {
        // Windows dialogs are top-level native windows and do not need the overlay handoff.
      }
      if (ownerWindow) {
        return await dialog.showOpenDialog(ownerWindow, options);
      }
      return await dialog.showOpenDialog(options);
    } finally {
      endNativeDialogVisibility();
    }
  }

  async showSaveDialog(options: SaveDialogOptions, ownerWindow: BrowserWindow | null) {
    const endNativeDialogVisibility = this.beginVisibility();
    try {
      if (this.options.platform === "darwin") {
        await waitForNativeDialogLayout();
      } else if (this.options.platform === "win32") {
        // Windows keeps the dialog above the owner window without hiding renderer overlays.
      }
      if (ownerWindow) {
        return await dialog.showSaveDialog(ownerWindow, options);
      }
      return await dialog.showSaveDialog(options);
    } finally {
      endNativeDialogVisibility();
    }
  }

  async showMessageBox(options: MessageBoxOptions, ownerWindow: BrowserWindow | null = null) {
    if (ownerWindow) {
      return dialog.showMessageBox(ownerWindow, options);
    }
    return dialog.showMessageBox(options);
  }

  private beginVisibility() {
    if (this.options.platform !== "darwin") {
      return () => undefined;
    }

    this.visibilityDepth += 1;
    if (this.visibilityDepth === 1) {
      this.emitVisibility(true);
    }

    return () => {
      this.visibilityDepth = Math.max(0, this.visibilityDepth - 1);
      if (this.visibilityDepth === 0) {
        this.emitVisibility(false);
      }
    };
  }

  private emitVisibility(open: boolean) {
    const payload = {
      open,
      platform: this.options.platform
    };

    for (const targetWindow of this.options.getTargetWindows()) {
      if (!targetWindow || targetWindow.isDestroyed()) {
        continue;
      }
      targetWindow.webContents.send("app.nativeDialogVisibility", payload);
    }
  }
}

function waitForNativeDialogLayout() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 16);
  });
}
