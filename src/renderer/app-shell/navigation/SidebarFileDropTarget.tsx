import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Modal } from "antd";
import { useI18n } from "../../i18n/useI18n";

type DropZone = "webapp" | "project";
type DropKind = DropZone | "unknown" | "unsupported" | "multiple";

function readDropKind(data: DataTransfer): DropKind {
  const items = Array.from(data.items).filter((item) => item.kind === "file");
  if (items.length > 1 || data.files.length > 1) return "multiple";
  const item = items[0];
  const entry = item?.webkitGetAsEntry();
  if (entry?.isDirectory) return "project";
  const file = item?.getAsFile() ?? data.files[0];
  if (entry?.isFile || file) {
    return (entry?.name ?? file?.name ?? "").toLowerCase().endsWith(".zip") ? "webapp" : "unsupported";
  }
  // Chromium can protect file names and entries until drop, on both platforms.
  // An empty MIME type is also valid for files; never guess that it is a folder.
  if (["application/zip", "application/x-zip-compressed", "application/x-zip"].includes(item?.type ?? "")) return "webapp";
  if (item?.type && item.type !== "application/octet-stream") return "unsupported";
  return "unknown";
}

function accepts(zone: DropZone, kind: DropKind) {
  return kind === "unknown" || kind === zone;
}

export function SidebarFileDropTarget({ children, className, enabled, projectDisabled, webappDisabled, onProject, onWebapp }: {
  children: ReactNode;
  className: string;
  enabled: boolean;
  projectDisabled: boolean;
  webappDisabled: boolean;
  onProject: (file: File) => Promise<void>;
  onWebapp: (file: File) => Promise<void>;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState<DropZone | null>(null);
  const [kind, setKind] = useState<DropKind>("unknown");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const depth = useRef(0);

  function clear() {
    depth.current = 0;
    setVisible(false);
    setHovered(null);
    setKind("unknown");
  }

  useEffect(() => {
    // Native file drags use Chromium events on both macOS and Windows.
    // Reset even when the drag finishes outside this sidebar or is cancelled.
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => { if (!enabled) clear(); }, [enabled]);

  function isFileDrag(event: DragEvent) {
    return enabled && event.dataTransfer.types.includes("Files");
  }

  function zoneAt(event: DragEvent): DropZone | null {
    const zone = (event.target as Element).closest<HTMLElement>("[data-file-drop-zone]")?.dataset.fileDropZone;
    return zone === "webapp" || zone === "project" ? zone : null;
  }

  function unavailable(zone: DropZone | null) {
    return !zone || busy.current || (zone === "project" ? projectDisabled : webappDisabled);
  }

  function disabled(zone: DropZone | null, dropKind = kind) {
    return unavailable(zone) || (zone !== null && !accepts(zone, dropKind));
  }

  async function drop(event: DragEvent) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const zone = zoneAt(event);
    const files = Array.from(event.dataTransfer.files);
    const dropKind = readDropKind(event.dataTransfer);
    clear();
    if (!zone || unavailable(zone)) return;
    if (files.length !== 1) {
      setError(t("sidebar.drop.singleItem"));
      return;
    }
    if (!accepts(zone, dropKind) || (zone === "webapp" && !files[0].name.toLowerCase().endsWith(".zip"))) {
      setError(t(`sidebar.drop.${zone}Hint`));
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await (zone === "webapp" ? onWebapp : onProject)(files[0]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <aside
    className={className}
    onDragEnterCapture={(event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depth.current += 1;
      setKind(readDropKind(event.dataTransfer));
      setVisible(true);
    }}
    onDragOverCapture={(event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const zone = zoneAt(event);
      const dropKind = readDropKind(event.dataTransfer);
      setKind(dropKind);
      setVisible(true);
      setHovered(zone);
      event.dataTransfer.dropEffect = disabled(zone, dropKind) ? "none" : "copy";
    }}
    onDragLeaveCapture={(event) => {
      if (!isFileDrag(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) clear();
    }}
    onDropCapture={(event) => { void drop(event); }}
  >
    {children}
    {visible || pending ? <div className="sidebar-file-drop-overlay" aria-busy={pending}>
      {pending ? <div className="sidebar-file-drop-progress" role="status">{t("sidebar.drop.processing")}</div> :
        (["project", "webapp"] as const).map((zone) => <div
          key={zone}
          data-file-drop-zone={zone}
          className={`sidebar-file-drop-zone${hovered === zone ? " is-hovered" : ""}${disabled(zone) ? " is-disabled" : ""}`}
          aria-disabled={disabled(zone)}
        >
          <strong>{t(`sidebar.drop.${zone}`)}</strong>
          <span>{t(`sidebar.drop.${zone}Hint`)}</span>
        </div>)}
    </div> : null}
    <Modal centered open={Boolean(error)} title={t("sidebar.drop.failed")}
      okText={t("common.close")} cancelButtonProps={{ style: { display: "none" } }}
      onOk={() => setError("")} onCancel={() => setError("")}>
      <p role="alert">{error}</p>
    </Modal>
  </aside>;
}
