import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button } from "antd";
import type { DesktopPetState } from "../../../shared/contracts";
import { useI18n } from "../../i18n/useI18n";
import "./PetImportControls.css";

export function PetImportControls({ onImported, onNotice }: {
  onImported: (state: DesktopPetState) => void;
  onNotice: (message: string, tone: "success" | "error") => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const busy = useRef(false);
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };
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

  async function importPet(kind: "zip" | "drop", file?: File) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const api = window.electronAPI.desktopPet;
      const result = kind === "drop"
        ? await api.importDroppedPackage(file!)
        : await api.importPackage();
      if (!result.ok) {
        onNotice(t(`settings.desktopPet.import.${result.error}`), "error");
        return;
      }
      if (result.cancelled) return;
      onImported(result.state);
      onNotice(t("settings.desktopPet.import.success"), "success");
    } catch {
      onNotice(t("settings.desktopPet.import.storageFailed"), "error");
    } finally {
      busy.current = false;
      setPending(false);
      reset();
    }
  }

  function captureFileDrag(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  function enter(event: DragEvent) {
    if (!captureFileDrag(event)) return;
    depth.current += 1;
    if (!busy.current) setDragging(true);
  }
  function leave(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return;
    depth.current = Math.max(0, depth.current - 1);
    if (!depth.current) setDragging(false);
  }
  function drop(event: DragEvent) {
    if (!captureFileDrag(event)) return;
    reset();
    if (busy.current) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      onNotice(t("settings.desktopPet.import.single"), "error");
      return;
    }
    const entry = Array.from(event.dataTransfer.items).find((item) => item.kind === "file")?.webkitGetAsEntry();
    if (entry?.isDirectory || !files[0].name.toLowerCase().endsWith(".zip")) {
      onNotice(t("settings.desktopPet.import.hint"), "error");
      return;
    }
    void importPet("drop", files[0]);
  }

  return (
    <div className="pet-import-controls" aria-busy={pending}
      onDragOver={captureFileDrag}
      onDrop={(event) => { if (captureFileDrag(event)) reset(); }}>
      <Button disabled={pending} onClick={() => void importPet("zip")}>{t("settings.desktopPet.import.zip")}</Button>
      <div className={`pet-import-drop${dragging ? " is-dragging" : ""}`} aria-disabled={pending}
        onDragEnter={enter}
        onDragLeave={leave}
        onDragOver={(event) => {
          if (captureFileDrag(event)) event.dataTransfer.dropEffect = busy.current ? "none" : "copy";
        }}
        onDrop={drop}>
        <span role="status">{t(pending ? "settings.desktopPet.import.pending" : "settings.desktopPet.import.hint")}</span>
      </div>
    </div>
  );
}
