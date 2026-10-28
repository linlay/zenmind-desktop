import { CheckCircleOutlined, ClockCircleOutlined, EllipsisOutlined, FolderOpenOutlined, FolderOutlined, InboxOutlined, PlusOutlined, ReadOutlined, RightOutlined, StarOutlined, SyncOutlined, TagOutlined } from "@ant-design/icons";
import { useState, type DragEvent, type MouseEvent } from "react";
import type { DesktopArtifactFolder, DesktopArtifactIdentity, DesktopArtifactListResult } from "../../../shared/artifacts";
import { useI18n } from "../../i18n/useI18n";
import { LIBRARY_DRAG_TYPE, readLibraryDrag, type LibraryView } from "./library-model";

export interface LibrarySidebarProps {
  view: LibraryView;
  folders: DesktopArtifactFolder[];
  counts: DesktopArtifactListResult["counts"];
  tags: string[];
  expanded: Set<string>;
  syncing: boolean;
  onNavigate(view: LibraryView): void;
  onExpand(id: string): void;
  onCreate(parentId: string | null): void;
  onFolderMenu(folder: DesktopArtifactFolder, event: MouseEvent<HTMLElement>): void;
  onWorkspaceMenu(event: MouseEvent<HTMLElement>): void;
  onMove(items: DesktopArtifactIdentity[], folderId: string): void;
  onSync(): void;
}
export function LibrarySidebar(props: LibrarySidebarProps) {
  const { t } = useI18n();
  const [dropId, setDropId] = useState<string | null>(null);
  function drop(event: DragEvent, id: string) {
    if (!event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return;
    event.preventDefault(); event.stopPropagation(); setDropId(null);
    const items = readLibraryDrag(event.dataTransfer.getData(LIBRARY_DRAG_TYPE));
    if (items.length) props.onMove(items, id);
  }
  function tree(parentId: string | null, depth = 0) {
    if (depth >= 20) return null;
    return props.folders.filter(folder => folder.parentId === parentId).map(folder => {
      const hasChildren = folder.childCount > 0;
      const open = props.expanded.has(folder.id);
      const active = props.view.kind === "folder" && props.view.id === folder.id;
      return <div className="library-tree-node" key={folder.id}>
        <div className={`library-tree-row${active ? " is-active" : ""}${dropId === folder.id ? " is-drop-target" : ""}`} style={{ paddingLeft: depth * 13 }}
          onDragOver={event => { if (event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropId(folder.id); } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropId(null); }} onDrop={event => drop(event, folder.id)}
          onContextMenu={event => { event.preventDefault(); props.onFolderMenu(folder, event); }}>
          <button type="button" className={`library-tree-chevron${open ? " is-open" : ""}${!hasChildren ? " is-leaf" : ""}`} disabled={!hasChildren} aria-label={t(open ? "library.collapseFolder" : "library.expandFolder", { name: folder.name })} aria-expanded={hasChildren ? open : undefined} onClick={() => props.onExpand(folder.id)}><RightOutlined /></button>
          <button type="button" className="library-tree-label" aria-current={active ? "page" : undefined} title={folder.name} onClick={() => props.onNavigate({ kind: "folder", id: folder.id })}>
            {open ? <FolderOpenOutlined /> : <FolderOutlined />}<span>{folder.name}</span><small>{folder.totalCount}</small>
          </button>
          <button type="button" className="library-tree-more" aria-label={t("library.folderMenu", { name: folder.name })} onClick={event => props.onFolderMenu(folder, event)}><EllipsisOutlined /></button>
        </div>
        {hasChildren && open && <div className="library-tree-children">{tree(folder.id, depth + 1)}</div>}
      </div>;
    });
  }
  const views = [
    { kind: "all" as const, icon: <ReadOutlined />, count: props.counts.all },
    { kind: "recent" as const, icon: <ClockCircleOutlined />, count: props.counts.recent },
    { kind: "starred" as const, icon: <StarOutlined />, count: props.counts.starred },
    { kind: "unfiled" as const, icon: <InboxOutlined />, count: props.counts.unfiled },
  ];
  return <aside className="library-sidebar" aria-label={t("library.navigation")}>
    <div className="library-brand"><ReadOutlined /><strong>{t("nav.artifactManagement")}</strong><button type="button" className="library-icon-button" onClick={props.onWorkspaceMenu} aria-label={t("library.workspaceMenu")}><EllipsisOutlined /></button></div>
    <div className="library-sidebar-scroll">
      <nav aria-label={t("library.quickViews")}>{views.map(view => <button type="button" key={view.kind} className={`library-nav-row${props.view.kind === view.kind ? " is-active" : ""}`} aria-current={props.view.kind === view.kind ? "page" : undefined} onClick={() => props.onNavigate({ kind: view.kind })}>{view.icon}<span>{t(`library.view.${view.kind}`)}</span><small>{view.count}</small></button>)}</nav>
      <div className="library-side-label"><span>{t("library.myFolders")}</span><button type="button" className="library-icon-button" aria-label={t("library.newRootFolder")} onClick={() => props.onCreate(null)}><PlusOutlined /></button></div>
      <nav aria-label={t("library.myFolders")}>{tree(null)}</nav>
      {!props.folders.length && <button type="button" className="library-empty-folders" onClick={() => props.onCreate(null)}>{t("library.emptyFolders")}</button>}
      <div className="library-side-label"><span>{t("artifactManagement.tags")}</span><TagOutlined /></div>
      {props.tags.map(tag => <button type="button" key={tag} className={`library-tag-nav${props.view.kind === "tag" && props.view.tag === tag ? " is-active" : ""}`} onClick={() => props.onNavigate({ kind: "tag", tag })}><span aria-hidden="true" className="library-tag-dot" />{tag}</button>)}
      {!props.tags.length && <p className="library-empty-tags">{t("library.emptyTags")}</p>}
    </div>
    <div className="library-sidebar-sync"><CheckCircleOutlined /><span>{t(props.syncing ? "library.syncing" : "library.referenceIndex")}</span><button type="button" className="library-icon-button" aria-label={t("artifactManagement.sync")} disabled={props.syncing} onClick={props.onSync}><SyncOutlined spin={props.syncing} /></button></div>
  </aside>;
}
