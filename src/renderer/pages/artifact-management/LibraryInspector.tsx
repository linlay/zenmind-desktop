import { CloseOutlined, EllipsisOutlined, EyeOutlined, FolderOutlined, InfoCircleOutlined, MessageOutlined, PlusOutlined, RightOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import type { DesktopArtifactFolder, DesktopArtifactRecord } from "../../../shared/artifacts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";
import { LibraryFileVisual } from "./LibraryFileVisual";
import { artifactCanOpen, artifactName, artifactStatus, folderTrail, formatArtifactSize } from "./library-model";

export function LibraryInspector({ item, count, folders, busy, focusTags, onClose, onOpen, onFavorite, onMenu, onMove, onNavigate, onSource, onTags }: {
  item: DesktopArtifactRecord | null; count: number; folders: DesktopArtifactFolder[]; busy: boolean; focusTags: number;
  onClose(): void; onOpen(): void; onFavorite(): void; onMenu(event: React.MouseEvent<HTMLElement>): void; onMove(): void;
  onNavigate(id: string | null): void; onSource(): void; onTags(tags: string[]): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [tag, setTag] = useState("");
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setTag(""); setAdding(false); }, [item?.chatId, item?.runId, item?.artifactId]);
  useEffect(() => { if (focusTags) setAdding(true); }, [focusTags]);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);
  const path = folderTrail(folders, item?.folderId ?? null);
  return <aside className="library-inspector" aria-label={t("artifactManagement.details")}>
    <div className="library-inspector-head"><span>{t("artifactManagement.details")}</span><button type="button" className="library-icon-button" onClick={onClose} aria-label={t("library.closeDetails")}><CloseOutlined /></button></div>
    {!item ? <div className="library-no-selection"><InfoCircleOutlined /><p>{t(count ? "library.multipleDetails" : "library.noSelection", { count })}</p></div> : <div className="library-inspector-body">
      <LibraryFileVisual item={item} detail />
      <h2>{artifactName(item)}</h2><p className="library-detail-type">{t(`artifactManagement.category.${item.category}`)} · {formatArtifactSize(item.sizeBytes)}</p>
      <div className="library-detail-actions"><button type="button" className="library-button is-primary" disabled={busy || !artifactCanOpen(item)} onClick={onOpen}><EyeOutlined />{t("library.openItem")}</button><button type="button" className="library-icon-button" disabled={busy} aria-label={t(item.favorite ? "artifactManagement.unfavorite" : "artifactManagement.favorite")} aria-pressed={item.favorite} onClick={onFavorite}>{item.favorite ? <StarFilled /> : <StarOutlined />}</button><button type="button" className="library-icon-button" disabled={busy} aria-label={t("library.itemMenu", { name: artifactName(item) })} onClick={onMenu}><EllipsisOutlined /></button></div>
      <div className="library-detail-label"><span>{t("library.location")}</span><button type="button" disabled={busy} onClick={onMove}>{t("library.move")}</button></div>
      <div className="library-location"><FolderOutlined />{path.length ? path.map((folder, index) => <span key={folder.id}>{index > 0 && <RightOutlined />}<button type="button" onClick={() => onNavigate(folder.id)}>{folder.name}</button></span>) : <button type="button" onClick={() => onNavigate(null)}>{t("library.view.unfiled")}</button>}</div>
      <div className="library-detail-label">{t("artifactManagement.tags")}</div>
      <div className="library-detail-tags">{item.tags.map(value => <span className="library-tag" key={value}>{value}<button type="button" aria-label={t("library.removeTag", { name: value })} disabled={busy} onClick={() => void onTags(item.tags.filter(other => other !== value))}><CloseOutlined /></button></span>)}<button type="button" className="library-add-tag" disabled={busy || item.tags.length >= 20} onClick={() => setAdding(true)}><PlusOutlined />{t("library.addTag")}</button></div>
      {adding && <form className="library-add-tag-form" onSubmit={event => { event.preventDefault(); const value = tag.trim(); if (value && !item.tags.includes(value)) void onTags([...item.tags, value]).then(ok => { if (ok) { setTag(""); setAdding(false); } }); }}><input ref={input} value={tag} maxLength={64} onChange={event => setTag(event.target.value)} aria-label={t("library.tagName")} placeholder={t("library.tagName")} /><button type="submit" className="library-icon-button" aria-label={t("library.save")} disabled={busy || !tag.trim() || item.tags.includes(tag.trim())}><PlusOutlined /></button><button type="button" className="library-icon-button" aria-label={t("common.cancel")} onClick={() => setAdding(false)}><CloseOutlined /></button></form>}
      <div className="library-detail-label">{t("artifactManagement.source")}</div>
      <div className="library-source"><button type="button" onClick={onSource} disabled={item.sourceState !== "active"}><MessageOutlined /><span>{item.chatName || item.chatId}</span></button><p>{item.agentKey || item.chatId}</p></div>
      <dl className="library-detail-metadata"><dt>{t("artifactManagement.pushedAt")}</dt><dd>{formatEpochMillis(item.pushedAt)}</dd><dt>{t("artifactManagement.size")}</dt><dd>{formatArtifactSize(item.sizeBytes)}</dd><dt>{t("artifactManagement.type")}</dt><dd>{item.mimeType || t("artifactManagement.unknownType")}</dd><dt>{t("artifactManagement.status")}</dt><dd className={artifactStatus(item) === "ready" ? "is-ready" : ""}>{t(`artifactManagement.status.${artifactStatus(item)}`)}</dd>{item.displayName && item.displayName !== item.name && <><dt>{t("library.originalName")}</dt><dd>{item.name}</dd></>}<dt>{t("artifactManagement.runId")}</dt><dd>{item.runId || t("artifactManagement.status.unresolved")}</dd></dl>
      <p className="library-detail-note">{t("library.pointerNote")}</p>
    </div>}
  </aside>;
}
