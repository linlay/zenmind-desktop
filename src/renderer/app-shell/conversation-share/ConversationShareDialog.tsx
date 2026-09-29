import { useEffect, useRef, useState } from "react";
import { CloseOutlined, CopyOutlined, GlobalOutlined, QrcodeOutlined } from "@ant-design/icons";
import { QRCode, Spin } from "antd";
import type { TranslateFunction } from "../../../shared/i18n";
import { useConversationShareDialog, type ConversationShareAction } from "./useConversationShareDialog";

declare const __DESKTOP_BRAND_ICON_DATA_URL__: string;

const QR_CODE_SIZE = 224;
const QR_BRAND_ICON_SIZE = 36;

type ConversationShareDialogProps = {
  chatId: string;
  chatName: string;
  tunnelHubEnabled: boolean;
  t: TranslateFunction;
  onClose: () => void;
  onOpenTunnelSettings: () => void;
};

const ACTIONS = [
  { id: "copy", icon: CopyOutlined, label: "sidebar.chat.shareCopyLink" },
  { id: "qr", icon: QrcodeOutlined, label: "sidebar.chat.shareGenerateQr" },
  { id: "browser", icon: GlobalOutlined, label: "sidebar.chat.shareOpenBrowser" },
] as const;

async function readQrPngBase64(container: HTMLDivElement | null): Promise<string> {
  const brandIcon = container?.querySelector("img");
  if (brandIcon) {
    await brandIcon.decode();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  const source = container?.querySelector("canvas");
  if (!source || !source.width || !source.height) throw new Error("QR canvas unavailable");
  const padding = Math.ceil(source.width * 0.1);
  const output = document.createElement("canvas");
  output.width = source.width + padding * 2;
  output.height = source.height + padding * 2;
  const context = output.getContext("2d");
  if (!context) throw new Error("QR canvas unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(source, padding, padding);
  if (brandIcon) {
    const iconSize = source.width * QR_BRAND_ICON_SIZE / QR_CODE_SIZE;
    const iconX = padding + (source.width - iconSize) / 2;
    const iconY = padding + (source.height - iconSize) / 2;
    context.fillRect(iconX, iconY, iconSize, iconSize);
    context.drawImage(brandIcon, iconX, iconY, iconSize, iconSize);
  }
  return output.toDataURL("image/png").split(",", 2)[1] || "";
}

async function copyQrPng(dataBase64: string): Promise<void> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      const bytes = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
      return;
    }
  } catch {
    // Electron's clipboard bridge also works when the browser clipboard API is unavailable.
  }
  const result = await window.electronAPI.clipboard.writePng(dataBase64);
  if (!result.ok) throw new Error(result.message || "QR clipboard write failed");
}

export function ConversationShareDialog({
  chatId,
  chatName,
  tunnelHubEnabled,
  t,
  onClose,
  onOpenTunnelSettings,
}: ConversationShareDialogProps) {
  const { state, run, notify } = useConversationShareDialog({ chatId }, t);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const qrCodeRef = useRef<HTMLDivElement | null>(null);
  const qrActionRef = useRef<"copy" | "save" | null>(null);
  const [qrAction, setQrAction] = useState<"copy" | "save" | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chatId, state.phase]);

  useEffect(() => {
    if (state.phase !== "done") return;
    const timer = window.setTimeout(() => onCloseRef.current(), 1_800);
    return () => window.clearTimeout(timer);
  }, [state.phase]);

  async function exportQr(action: "copy" | "save") {
    if (qrActionRef.current) return;
    qrActionRef.current = action;
    setQrAction(action);
    notify({ kind: "loading", message: t(action === "copy" ? "sidebar.chat.shareQrCopying" : "sidebar.chat.shareQrSaving") });
    try {
      const dataBase64 = await readQrPngBase64(qrCodeRef.current);
      if (!dataBase64) throw new Error("QR canvas unavailable");
      if (action === "copy") {
        await copyQrPng(dataBase64);
      } else {
        const result = await window.electronAPI.desktopDownloads.saveFile({
          filename: `${chatName.trim() || chatId}.png`,
          mimeType: "image/png",
          dataBase64,
        });
        if (!result.ok) throw new Error(result.message || t("sidebar.chat.shareQrSaveFailed"));
      }
      notify({ kind: "success", message: t(action === "copy" ? "sidebar.chat.shareQrCopied" : "sidebar.chat.shareQrSaved") });
    } catch {
      notify({ kind: "error", message: t(action === "copy" ? "sidebar.chat.shareQrCopyFailed" : "sidebar.chat.shareQrSaveFailed") });
    } finally {
      qrActionRef.current = null;
      setQrAction(null);
    }
  }

  const closeButton = (
    <button
      ref={closeButtonRef}
      type="button"
      className={`conversation-share-icon-button${!tunnelHubEnabled ? " is-corner" : state.phase === "qr" ? " is-qr" : ""}`}
      aria-label={t("common.close")}
      onClick={onClose}
    >
      <CloseOutlined aria-hidden="true" />
    </button>
  );

  return (
    <div
      className="conversation-share-dialog-layer"
      data-phase={state.phase}
      role="presentation"
      onMouseDown={onClose}
    >
      {state.feedback ? (
        <div className="conversation-share-toast" data-kind={state.feedback.kind} role={state.feedback.kind === "error" ? "alert" : "status"}>
          {state.feedback.kind === "loading" ? <Spin size="small" aria-hidden="true" /> : null}
          <span>{state.feedback.message}</span>
          {state.phase === "done" && state.warning ? <small>{state.warning}</small> : null}
        </div>
      ) : null}

      {state.phase !== "done" ? (
        <section
          className="conversation-share-dialog"
          data-phase={state.phase}
          role="dialog"
          aria-modal="true"
          aria-busy={Boolean(state.workingAction)}
          aria-label={t(state.phase === "qr" ? "sidebar.chat.shareQrTitle" : "sidebar.chat.shareTitle")}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {!tunnelHubEnabled ? (
            <section className="conversation-share-tunnel-gate">
              {closeButton}
              <h3>{t("shareManagement.tunnelRequiredTitle")}</h3>
              <p>{t("assistant.chatShareTunnelRequired")}</p>
              <button type="button" className="conversation-share-button" onClick={onOpenTunnelSettings}>
                {t("shareManagement.openTunnelSettings")}
              </button>
            </section>
          ) : state.phase === "qr" && state.createdRecord ? (
            <div className="conversation-share-qr-view">
              <div className="conversation-share-qr-head">
                <h2>{t("sidebar.chat.shareQrTitle")}</h2>
                {closeButton}
              </div>
              <div className="conversation-share-qr-stage">
                <div className="conversation-share-qr-code" ref={qrCodeRef}>
                  <QRCode
                    value={state.createdRecord.url}
                    type="canvas"
                    size={QR_CODE_SIZE}
                    bordered={false}
                    icon={__DESKTOP_BRAND_ICON_DATA_URL__}
                    iconSize={QR_BRAND_ICON_SIZE}
                    errorLevel="H"
                  />
                </div>
                <p>{t("sidebar.chat.shareQrScanHint")}</p>
              </div>
              <div className="conversation-share-qr-actions">
                <button type="button" disabled={Boolean(qrAction)} onClick={() => void exportQr("copy")}>{qrAction === "copy" ? <Spin size="small" /> : null}{t("sidebar.chat.shareQrCopy")}</button>
                <button type="button" disabled={Boolean(qrAction)} onClick={() => void exportQr("save")}>{qrAction === "save" ? <Spin size="small" /> : null}{t("sidebar.chat.shareQrSave")}</button>
              </div>
              {state.warning ? <p className="conversation-share-warning" role="note">{state.warning}</p> : null}
            </div>
          ) : (
            <div className="conversation-share-sheet-body">
              <div className="conversation-share-actions">
                {ACTIONS.map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    className="conversation-share-action"
                    disabled={Boolean(state.workingAction)}
                    onClick={() => void run(id as ConversationShareAction)}
                  >
                    <span className="conversation-share-action-icon">
                      {state.workingAction === id ? <Spin size="small" aria-hidden="true" /> : <Icon aria-hidden="true" />}
                    </span>
                    <span>{t(label)}</span>
                  </button>
                ))}
              </div>
              {closeButton}
              {state.warning ? <p className="conversation-share-warning" role="note">{state.warning}</p> : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
