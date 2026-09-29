import { useEffect, useRef, useState } from "react";
import { QRCode, Spin } from "antd";
import type { TranslateFunction } from "../../../shared/i18n";

declare const __DESKTOP_BRAND_ICON_DATA_URL__: string;

const QR_CODE_SIZE = 224;
const QR_BRAND_ICON_SIZE = 36;

type ShareFeedback = { kind: "loading" | "success" | "error"; message: string };

type ConversationShareQrDialogProps = {
  url: string;
  chatId: string;
  chatName: string;
  warning: string;
  t: TranslateFunction;
  onClose: () => void;
  onFeedback: (feedback: ShareFeedback) => void;
};

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

export function ConversationShareQrDialog({
  url,
  chatId,
  chatName,
  warning,
  t,
  onClose,
  onFeedback,
}: ConversationShareQrDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const qrCodeRef = useRef<HTMLDivElement | null>(null);
  const qrActionRef = useRef<"copy" | "save" | null>(null);
  const [qrAction, setQrAction] = useState<"copy" | "save" | null>(null);

  useEffect(() => { closeButtonRef.current?.focus(); }, []);

  async function exportQr(action: "copy" | "save") {
    if (qrActionRef.current) return;
    qrActionRef.current = action;
    setQrAction(action);
    onFeedback({ kind: "loading", message: t(action === "copy" ? "sidebar.chat.shareQrCopying" : "sidebar.chat.shareQrSaving") });
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
      onFeedback({ kind: "success", message: t(action === "copy" ? "sidebar.chat.shareQrCopied" : "sidebar.chat.shareQrSaved") });
    } catch {
      onFeedback({ kind: "error", message: t(action === "copy" ? "sidebar.chat.shareQrCopyFailed" : "sidebar.chat.shareQrSaveFailed") });
    } finally {
      qrActionRef.current = null;
      setQrAction(null);
    }
  }

  return (
    <section
      className="conversation-share-qr-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={t("sidebar.chat.shareQrTitle")}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="conversation-share-dialog-head">
        <h2>{t("sidebar.chat.shareQrTitle")}</h2>
        <button ref={closeButtonRef} type="button" className="conversation-share-icon-button" aria-label={t("common.close")} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 7 10 10M17 7 7 17" /></svg>
        </button>
      </div>
      <div className="conversation-share-qr-view">
        <div className="conversation-share-qr-stage">
          <div className="conversation-share-qr-code" ref={qrCodeRef}>
            <QRCode
              value={url}
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
        {warning ? <p className="conversation-share-warning" role="note">{warning}</p> : null}
      </div>
    </section>
  );
}
