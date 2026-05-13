import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AssistantAttachment } from "../../shared/contracts";

type AttachmentImagePreviewProps = {
  attachment: AssistantAttachment | null;
  onClose: () => void;
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function formatAttachmentSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const sizeKb = sizeBytes / 1024;
  if (sizeKb < 1024) {
    return `${sizeKb.toFixed(sizeKb >= 100 ? 0 : 1)} KB`;
  }
  const sizeMb = sizeKb / 1024;
  return `${sizeMb.toFixed(sizeMb >= 100 ? 0 : 1)} MB`;
}

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M8.5 11h5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M8.5 11h5" />
      <path d="M11 8.5v5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 5l14 14" />
      <path d="M19 5 5 19" />
    </svg>
  );
}

export function AttachmentImagePreview({ attachment, onClose }: AttachmentImagePreviewProps) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setZoom(1);
  }, [attachment?.id]);

  useEffect(() => {
    if (!attachment) {
      return undefined;
    }
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setZoom((current) => clampZoom(current + ZOOM_STEP));
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        setZoom((current) => clampZoom(current - ZOOM_STEP));
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        setZoom(1);
      }
    };
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [attachment, onClose]);

  if (!attachment?.dataUrl) {
    return null;
  }

  const formattedSize = formatAttachmentSize(attachment.sizeBytes);

  function handleDownload() {
    if (!attachment?.dataUrl) {
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = attachment.dataUrl;
    anchor.download = attachment.name || "image";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  const preview = (
    <div
      className="attachment-image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`预览图片 ${attachment.name}`}
      onMouseDown={onClose}
    >
      <div className="attachment-image-preview-topbar" onMouseDown={(event) => event.stopPropagation()}>
        <div className="attachment-image-preview-toolbar" aria-label="图片预览工具">
          <button
            type="button"
            onClick={() => setZoom((current) => clampZoom(current - ZOOM_STEP))}
            disabled={zoom <= MIN_ZOOM}
            aria-label="缩小图片"
            title="缩小"
          >
            <ZoomOutIcon />
          </button>
          <button
            type="button"
            onClick={() => setZoom((current) => clampZoom(current + ZOOM_STEP))}
            disabled={zoom >= MAX_ZOOM}
            aria-label="放大图片"
            title="放大"
          >
            <ZoomInIcon />
          </button>
          <span className="attachment-image-preview-toolbar-divider" aria-hidden="true" />
          <button type="button" onClick={handleDownload} aria-label="下载图片" title="下载">
            <DownloadIcon />
          </button>
        </div>
        <button
          type="button"
          className="attachment-image-preview-close"
          onClick={onClose}
          aria-label="关闭图片预览"
          title="关闭"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="attachment-image-preview-stage" onMouseDown={(event) => event.stopPropagation()}>
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          draggable={false}
          style={{ transform: `scale(${zoom})` }}
        />
      </div>
      <div className="attachment-image-preview-filmstrip" onMouseDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="is-active"
          aria-label={`当前预览：${attachment.name}`}
          title={formattedSize ? `${attachment.name} · ${formattedSize}` : attachment.name}
        >
          <img src={attachment.dataUrl} alt="" draggable={false} />
        </button>
      </div>
    </div>
  );

  return createPortal(preview, document.body);
}
