import { Modal } from "antd";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";

type ConfirmationOptions = {
  title?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
};

type PendingDialog = { cancel(): void };
export const THEMED_DIALOG_Z_INDEX = 10000;

// Keep the holder inside the caller's appearance provider. In particular, do
// not use Modal's static methods: their detached roots lose the selected skin.
export function useThemedDialogs() {
  const { t } = useI18n();
  const [modal, contextHolder] = Modal.useModal();
  const alive = useRef(true);
  const pending = useRef(new Set<PendingDialog>());
  const confirming = useRef(false);
  const cancelPending = useCallback(() => {
    for (const dialog of Array.from(pending.current)) dialog.cancel();
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelPending();
    };
  }, [cancelPending]);

  const confirm = useCallback((content: ReactNode, options: ConfirmationOptions = {}): Promise<boolean> => {
    // A second click must never share a positive answer with another action.
    if (!alive.current || confirming.current) return Promise.resolve(false);
    confirming.current = true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let handle: ReturnType<typeof modal.confirm> | undefined;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        confirming.current = false;
        pending.current.delete(dialog);
        resolve(accepted && alive.current);
      };
      const dialog: PendingDialog = { cancel: () => { finish(false); handle?.destroy(); } };
      pending.current.add(dialog);
      handle = modal.confirm({
        title: options.title ?? t("common.confirm"),
        content,
        okText: options.okText ?? t("common.confirm"),
        cancelText: options.cancelText ?? t("common.cancel"),
        okButtonProps: { danger: options.danger },
        centered: true,
        zIndex: THEMED_DIALOG_Z_INDEX,
        autoFocusButton: "cancel",
        maskClosable: false,
        onOk: () => finish(true),
        onCancel: () => finish(false),
        afterClose: () => finish(false),
      });
    });
  }, [modal, t]);

  const notify = useCallback((content: ReactNode, kind: "error" | "info" | "success" | "warning" = "error") => {
    if (!alive.current) return;
    let handle: ReturnType<typeof modal.info> | undefined;
    const dialog: PendingDialog = { cancel: () => { pending.current.delete(dialog); handle?.destroy(); } };
    pending.current.add(dialog);
    handle = modal[kind]({
      content,
      okText: t("common.confirm"),
      centered: true,
      zIndex: THEMED_DIALOG_Z_INDEX,
      afterClose: () => pending.current.delete(dialog),
    });
  }, [modal, t]);

  return { confirm, notify, modal, contextHolder, cancelPending };
}
