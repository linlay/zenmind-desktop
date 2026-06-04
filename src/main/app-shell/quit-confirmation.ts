import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue
} from "electron";
import type { TranslateFunction } from "../../shared/i18n";

type QuitConfirmationShowMessageBox = (
  options: MessageBoxOptions,
  ownerWindow?: BrowserWindow | null
) => Promise<MessageBoxReturnValue>;

export type QuitConfirmationControllerOptions = {
  platform: NodeJS.Platform;
  appName: string;
  t: TranslateFunction;
  getOwnerWindow: () => BrowserWindow | null;
  showMessageBox: QuitConfirmationShowMessageBox;
  requestQuitWithoutConfirmation: () => void;
};

export function buildQuitConfirmationDialogOptions(options: {
  appName: string;
  t: TranslateFunction;
}): MessageBoxOptions {
  const title = options.t("quitConfirm.title", { appName: options.appName });
  return {
    type: "warning",
    buttons: [
      options.t("common.cancel"),
      options.t("quitConfirm.quit")
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title,
    message: title,
    detail: options.t("quitConfirm.detail", { appName: options.appName })
  };
}

export function createQuitConfirmationController(options: QuitConfirmationControllerOptions) {
  let confirmationPromise: Promise<void> | null = null;

  async function confirmAndRequestAppQuit() {
    if (options.platform !== "darwin") {
      options.requestQuitWithoutConfirmation();
      return;
    }

    if (confirmationPromise) {
      await confirmationPromise;
      return;
    }

    confirmationPromise = showConfirmationAndMaybeQuit().finally(() => {
      confirmationPromise = null;
    });
    await confirmationPromise;
  }

  async function showConfirmationAndMaybeQuit() {
    const ownerWindow = options.getOwnerWindow();
    const result = await options.showMessageBox(
      buildQuitConfirmationDialogOptions({
        appName: options.appName,
        t: options.t
      }),
      ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : null
    );

    if (result.response === 1) {
      options.requestQuitWithoutConfirmation();
    }
  }

  return {
    confirmAndRequestAppQuit
  };
}
