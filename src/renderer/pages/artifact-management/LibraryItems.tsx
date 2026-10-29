import { EllipsisOutlined, ExclamationCircleFilled, FolderOutlined, StarFilled } from "@ant-design/icons";
import { useState, type DragEvent, type MouseEvent } from "react";
import type { DesktopArtifactFolder, DesktopArtifactIdentity, DesktopArtifactRecord } from "../../../shared/artifacts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";
import { LibraryFileVisual } from "./LibraryFileVisual";
import { LIBRARY_DRAG_TYPE, artifactCanOpen, artifactIdentity, artifactKey, artifactName, artifactStatus, formatArtifactSize, readLibraryDrag, type LibraryLayout } from "./library-model";
import type { LibrarySelectionGesture } from "./useLibrarySelection";

export function LibraryFolderCard({ folder, onNavigate, onMenu, onMove }: {
  folder: DesktopArtifactFolder; onNavigate(): void; onMenu(event: MouseEvent<HTMLElement>): void; onMove(items: DesktopArtifactIdentity[], id: string): void;
}) {
  const { t } = useI18n();
  const [drop, setDrop] = useState(false);
  return <div className={`library-folder-card${drop ? " is-drop-target" : ""}`} onContextMenu={event => { event.preventDefault(); onMenu(event); }}
    onDragOver={event => { if (event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDrop(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(false); }} onDrop={event => {
      if (!event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return;
      event.preventDefault(); setDrop(false); const items = readLibraryDrag(event.dataTransfer.getData(LIBRARY_DRAG_TYPE)); if (items.length) onMove(items, folder.id);
    }}>
    <button type="button" className="library-folder-open" onClick={onNavigate} title={folder.name}><FolderOutlined /><span><strong>{folder.name}</strong><small>{folder.childCount ? t("library.folderSummary", { folders: folder.childCount, count: folder.totalCount }) : t("artifactManagement.count", { count: folder.totalCount })}</small></span></button>
    <button type="button" className="library-folder-more library-icon-button" aria-label={t("library.folderMenu", { name: folder.name })} onClick={onMenu}><EllipsisOutlined /></button>
  </div>;
}
export function LibraryFileCard({ item, selected, layout, busy, onSelect, onOpen, onMenu, onDrag }: {
  item: DesktopArtifactRecord; selected: boolean; layout: LibraryLayout; busy: boolean;
  onSelect(gesture: LibrarySelectionGesture): void; onOpen(): void; onMenu(event: MouseEvent<HTMLElement>): void; onDrag(event: DragEvent, item: DesktopArtifactRecord): void;
}) {
  const { t } = useI18n();
  const status = artifactStatus(item), name = artifactName(item);
  return <article className={`library-file${selected ? " is-selected" : ""}`} data-library-key={artifactKey(item)} tabIndex={0} aria-label={name} aria-describedby={status !== "ready" ? `library-status-${encodeURIComponent(artifactKey(item))}` : undefined} draggable={!busy}
    onClick={event => onSelect({ shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey })} onDoubleClick={event => { if (!(event.target as HTMLElement).closest("button,input")) onOpen(); }}
    onContextMenu={event => { event.preventDefault(); onMenu(event); }} onDragStart={event => onDrag(event, item)}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" && artifactCanOpen(item)) { event.preventDefault(); onOpen(); }
      if (event.key === " ") { event.preventDefault(); onSelect({ toggle: true, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey }); }
    }}>
    <input type="checkbox" className="library-file-check" checked={selected} aria-label={t("library.selectItem", { name })} onClick={event => event.stopPropagation()} onChange={event => { const native = event.nativeEvent as WindowEventMap["click"]; onSelect({ toggle: true, shiftKey: native.shiftKey, metaKey: native.metaKey, ctrlKey: native.ctrlKey }); }} />
    {item.favorite && <span className="library-file-star" aria-label={t("artifactManagement.favorite")}><StarFilled /></span>}
    <LibraryFileVisual item={item} />
    <div className="library-file-body"><strong title={name}>{name}</strong>{layout !== "small" && <div className="library-file-meta"><span>{t(`artifactManagement.category.${item.category}`)}</span><time dateTime={new Date(item.pushedAt).toISOString()}>{formatEpochMillis(item.pushedAt).split(" ")[0]}</time>{layout === "list" && <span>{formatArtifactSize(item.sizeBytes)}</span>}</div>}
      {status !== "ready" && <span className="library-file-state" title={t(`artifactManagement.status.${status}`)} id={`library-status-${encodeURIComponent(artifactKey(item))}`}>{layout === "small" && <ExclamationCircleFilled aria-hidden="true" />}<span className="library-file-state-label">{t(`artifactManagement.status.${status}`)}</span></span>}
    </div>
    <button type="button" className="library-file-more library-icon-button" aria-label={t("library.itemMenu", { name })} disabled={busy} onClick={event => { event.stopPropagation(); onMenu(event); }}><EllipsisOutlined /></button>
  </article>;
}
