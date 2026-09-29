import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useI18n } from "../../i18n/useI18n";

export function WebappImportDropTarget({ children, pending, onImport, onError }: {
  children: ReactNode;
  pending: boolean;
  onImport: (file: File) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const reset = () => { depth.current = 0; setDragging(false); };
  useEffect(() => {
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  return <section
    className={`control-center-page workspace-wide service-workspace-page web-settings-page is-webapps webapp-import-drop-target${dragging ? " is-dragging" : ""}`}
    aria-label={t("settings.webapps.label")}
    aria-busy={pending}
    onDragEnter={(event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depth.current += 1;
      if (!pending) setDragging(true);
    }}
    onDragOver={(event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = pending ? "none" : "copy";
    }}
    onDragLeave={(event) => {
      if (!isFileDrag(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    }}
    onDrop={(event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      reset();
      if (pending) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length !== 1) {
        onError(t("sidebar.drop.singleItem"));
        return;
      }
      // Finder and Explorer can hide metadata until drop; main also validates the archive path.
      const entry = Array.from(event.dataTransfer.items).find((item) => item.kind === "file")?.webkitGetAsEntry();
      if (entry?.isDirectory || !files[0].name.toLowerCase().endsWith(".zip")) {
        onError(t("sidebar.drop.webappHint"));
        return;
      }
      void onImport(files[0]);
    }}
  >
    {children}
    {dragging ? <div className="webapp-import-drop-hint" role="status">{t("sidebar.drop.webappHint")}</div> : null}
  </section>;
}
