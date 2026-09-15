import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "antd";
import type { ConnectorAuthBrowserDialog } from "../../shared/contracts/agent-webclient-bridge";
import { useI18n } from "../i18n/useI18n";

export function ConnectorAuthBrowser() {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<ConnectorAuthBrowserDialog | null>(null);
  const [error, setError] = useState(false);
  const guest = useRef<HTMLElement | null>(null);
  useEffect(() => window.electronAPI.connectorAuthBrowser.onDialog(input => {
    if ("closed" in input) setDialog(previous => previous?.dialogId === input.dialogId ? null : previous);
    else { setError(false); setDialog(input); }
  }), []);
  const failed = useCallback((event: Event) => {
    const load = event as Event & { isMainFrame?: boolean; errorCode?: number };
    if (load.isMainFrame !== false && load.errorCode !== -3) setError(true);
  }, []);
  const bindGuest = useCallback((view: HTMLElement | null) => {
    guest.current?.removeEventListener("did-fail-load", failed);
    guest.current = view;
    view?.addEventListener("did-fail-load", failed);
  }, [failed]);
  return <Modal open={!!dialog} title={t("connectorAuth.title")} footer={null} width={600}
    maskClosable={false} destroyOnClose onCancel={() => {
      if (dialog) void window.electronAPI.connectorAuthBrowser.close(dialog.dialogId).catch(() => setError(true));
    }}>
    {error && <p role="alert">{t("connectorAuth.failed")}</p>}
    {dialog && createElement("webview", { ref: bindGuest, key: dialog.dialogId, src: dialog.url,
      partition: dialog.partition, title: t("connectorAuth.title"),
      style: { width: "100%", height: "min(640px, 70vh)", border: "none" } })}
  </Modal>;
}
