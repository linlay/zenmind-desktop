import { CheckOutlined, FolderOutlined, InboxOutlined } from "@ant-design/icons";
import { Modal } from "antd";
import { useEffect, useState } from "react";
import type { DesktopArtifactFolder, DesktopArtifactIdentity, DesktopArtifactRecord } from "../../../shared/artifacts";
import { useI18n } from "../../i18n/useI18n";
import { artifactName, folderTrail } from "./library-model";

export type LibraryDialog = { kind: "create"; parentId: string | null } | { kind: "rename-folder" | "delete-folder"; folder: DesktopArtifactFolder } | { kind: "rename-item"; item: DesktopArtifactRecord } | { kind: "move"; items: DesktopArtifactIdentity[]; folderId: string | null } | { kind: "about" };
export function LibraryDialogs({ dialog, folders, busy, error, onCancel, onConfirm }: {
  dialog: LibraryDialog | null; folders: DesktopArtifactFolder[]; busy: boolean; error: string | null;
  onCancel(): void; onConfirm(name: string, folderId: string | null): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    setName(dialog?.kind === "rename-folder" ? dialog.folder.name : dialog?.kind === "rename-item" ? artifactName(dialog.item) : "");
    setTarget(dialog?.kind === "move" ? dialog.folderId : null);
  }, [dialog]);
  const title = dialog ? t(`library.dialog.${dialog.kind}`) : "";
  const naming = dialog && ["create", "rename-folder", "rename-item"].includes(dialog.kind);
  const destinationExists = target === null || folders.some(folder => folder.id === target);
  const parent = dialog?.kind === "create" ? folderTrail(folders, dialog.parentId).map(folder => folder.name).join(" / ") || t("library.myFolders") : "";
  const rows: { folder: DesktopArtifactFolder; depth: number }[] = [];
  function walk(parentId: string | null, depth = 0) { if (depth >= 20) return; folders.filter(folder => folder.parentId === parentId).forEach(folder => { rows.push({ folder, depth }); walk(folder.id, depth + 1); }); }
  if (dialog?.kind === "move") walk(null);
  return <Modal open={!!dialog} title={title} footer={null} onCancel={() => { if (!busy) onCancel(); }} destroyOnHidden className="library-dialog" maskClosable={!busy} closable={!busy} width={440}>
    {dialog?.kind === "about" ? <><p>{t("artifactManagement.scope")}</p><p>{t("library.folderNote")}</p></> : <form onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(name.trim(), target); }}>
      <p>{dialog?.kind === "create" ? t("library.createHelp", { parent }) : dialog?.kind === "rename-item" ? t("library.renameHelp") : dialog?.kind === "delete-folder" ? t("library.deleteHelp", { name: dialog.folder.name }) : dialog?.kind === "move" ? t("library.moveHelp", { count: dialog.items.length }) : t("library.folderNote")}</p>
      {naming && <label className="library-dialog-field"><span>{t(dialog.kind === "rename-item" ? "library.displayName" : "library.folderName")}</span><input autoFocus maxLength={dialog.kind === "rename-item" ? 256 : 64} value={name} onChange={event => setName(event.target.value)} disabled={busy} required /></label>}
      {dialog?.kind === "move" && <div className="library-move-targets" role="group" aria-label={t("library.destination")}><button type="button" className={`library-move-target${target === null ? " is-active" : ""}`} onClick={() => setTarget(null)} disabled={busy}><InboxOutlined /><span>{t("library.view.unfiled")}</span>{target === null && <CheckOutlined />}</button>{rows.map(({ folder, depth }) => <button type="button" key={folder.id} className={`library-move-target${target === folder.id ? " is-active" : ""}`} style={{ paddingLeft: 12 + depth * 17 }} onClick={() => setTarget(folder.id)} disabled={busy}><FolderOutlined /><span>{folder.name}</span>{target === folder.id && <CheckOutlined />}</button>)}</div>}
      {error && <p className="library-dialog-error" role="alert">{error}</p>}
      <div className="library-dialog-actions"><button type="button" className="library-button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button><button type="submit" className={`library-button ${dialog?.kind === "delete-folder" ? "is-danger" : "is-primary"}`} disabled={busy || (!!naming && !name.trim()) || (dialog?.kind === "move" && !destinationExists)}>{t(dialog?.kind === "move" ? "library.moveHere" : dialog?.kind === "create" ? "library.create" : dialog?.kind === "delete-folder" ? "library.deleteFolder" : "library.save")}</button></div>
    </form>}
  </Modal>;
}
