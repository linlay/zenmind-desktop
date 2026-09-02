import { useEffect, useMemo, useState } from "react";
import { Button, Space } from "antd";
import { ExportOutlined, FolderOpenOutlined } from "@ant-design/icons";
import type { WorkPanelResourceImageSelection } from "../../shared/work-panel-resource-image";
import { useI18n } from "../i18n/useI18n";

function imageBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  return null;
}

export function WorkPanelDocumentImageReadonly({
  ownerChatId,
  rendererGeneration,
  resource,
}: {
  ownerChatId: string;
  rendererGeneration: string;
  resource: WorkPanelResourceImageSelection;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const handleRequest = useMemo(() => ({
    ownerChatId,
    rendererGeneration,
    handleId: resource.handleId,
  }), [ownerChatId, rendererGeneration, resource.handleId]);

  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    setError("");
    void window.electronAPI.chatWorkPanel.resourceImages.read(handleRequest).then((result) => {
      const bytes = imageBytes(result.data);
      if (disposed) return;
      if (!result.ok || !bytes) {
        setError(result.message || t("chatWorkPanel.document.imageReadFailed"));
        return;
      }
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.displayMimeType || resource.mimeType }));
      setUrl(objectUrl);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [handleRequest, resource.mimeType, t]);

  const open = async (mode: "default" | "choose") => {
    const result = await window.electronAPI.chatWorkPanel.resourceImages.openExternal({ ...handleRequest, mode });
    if (!result.ok && result.message) setError(result.message);
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: 8, borderBottom: "1px solid var(--border-color)" }}>
        <span>{resource.fileName} · {resource.mimeType} · {t("chatWorkPanel.document.readOnly")}</span>
        <Space>
          <Button icon={<FolderOpenOutlined />} onClick={() => void open("choose")}>
            {t("chatWorkPanel.document.openWith")}
          </Button>
          <Button type="primary" icon={<ExportOutlined />} onClick={() => void open("default")}>
            {t("chatWorkPanel.document.openDefault")}
          </Button>
        </Space>
      </div>
      {error ? <div role="alert" style={{ padding: 8, color: "#cf1322" }}>{error}</div> : null}
      <div style={{ display: "grid", placeItems: "center", flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg-secondary)" }}>
        {url ? (
          <img
            src={url}
            alt={resource.fileName}
            onError={() => setError(t("chatWorkPanel.document.decoderFailed"))}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        ) : null}
      </div>
    </div>
  );
}
