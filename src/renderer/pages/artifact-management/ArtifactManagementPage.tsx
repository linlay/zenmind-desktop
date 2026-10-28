import { AppstoreOutlined, BarsOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, DownOutlined, EditOutlined, EllipsisOutlined, EyeOutlined, FolderAddOutlined, FolderOpenOutlined, InfoCircleOutlined, InboxOutlined, LinkOutlined, MenuOutlined, MessageOutlined, ReadOutlined, ReloadOutlined, RightOutlined, SearchOutlined, StarFilled, StarOutlined, SyncOutlined, TagOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ARTIFACT_CATEGORIES, artifactExternalExtension, type DesktopArtifactActionInput, type DesktopArtifactFolder, type DesktopArtifactIdentity, type DesktopArtifactListResult, type DesktopArtifactMutationResult, type DesktopArtifactOrganizeInput, type DesktopArtifactRecord } from "../../../shared/artifacts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";
import { LibraryDialogs, type LibraryDialog } from "./LibraryDialogs";
import { createLibraryThumbnailLoader, LibraryThumbnailContext } from "./LibraryFileVisual";
import { LibraryInspector } from "./LibraryInspector";
import { LibraryFileCard, LibraryFolderCard } from "./LibraryItems";
import { LibraryMenu, type LibraryMenuItem, type LibraryMenuState } from "./LibraryMenu";
import { LibrarySidebar } from "./LibrarySidebar";
import { LIBRARY_DRAG_TYPE, artifactCanOpen, artifactIdentity, artifactKey, artifactName, folderTrail, libraryScope, readLibraryLayout, type LibraryLayout, type LibraryView } from "./library-model";
import { useLibrarySelection, type LibrarySelectionGesture } from "./useLibrarySelection";

const PAGE_SIZE = 50;
const EMPTY: DesktopArtifactListResult = { records: [], total: 0, tags: [], folders: [], categories: {}, counts: { all: 0, starred: 0, unfiled: 0, recent: 0 }, sync: { phase: "idle", completed: 0, total: 0, failed: 0, denied: 0 } };

export function ArtifactManagementPage({ onOpenChat, onView }: {
  onView(request: { agentKey: string; chatId: string; artifactId: string; relativePath: string; name: string }): boolean;
  onOpenChat(request: { agentKey: string; chatId: string }): void;
}) {
  const { t } = useI18n();
  const page = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<LibraryView>({ kind: "all" });
  const [result, setResult] = useState<DesktopArtifactListResult>(EMPTY);
  const [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState<DesktopArtifactRecord["category"] | undefined>();
  const [sort, setSort] = useState<"date" | "name" | "type">("date");
  const [layout, setLayout] = useState<LibraryLayout>(readLibraryLayout);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [mutating, setMutating] = useState(false);
  const [loadError, setLoadError] = useState(false), [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<LibraryMenuState | null>(null), [dialog, setDialog] = useState<LibraryDialog | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false), [detailsOpen, setDetailsOpen] = useState(false), [sidebarOpen, setSidebarOpen] = useState(false);
  const [narrow, setNarrow] = useState(false), [focusTags, setFocusTags] = useState(0);
  const [platform, setPlatform] = useState("");
  const generation = useRef(0), mounted = useRef(true);
  const thumbnails = useMemo(createLibraryThumbnailLoader, []);
  const input = useMemo(() => ({ ...libraryScope(view), search: query, category, offset, limit: PAGE_SIZE, sort }), [view, query, category, offset, sort]);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true); setLoadError(false);
    try {
      const next = await window.electronAPI.artifacts.list(input);
      if (!mounted.current || request !== generation.current) return;
      setResult(next);
      const visible = new Set(next.records.map(artifactKey));
      setSelected(previous => previous.filter(key => visible.has(key)));
      if (offset > 0 && offset >= next.total) setOffset(Math.max(0, Math.floor((next.total - 1) / PAGE_SIZE) * PAGE_SIZE));
      if (typeof input.folderId === "string" && !next.folders.some(folder => folder.id === input.folderId)) { setView({ kind: "all" }); setSelected([]); }
    } catch { if (mounted.current && request === generation.current) setLoadError(true); }
    finally { if (mounted.current && request === generation.current) setBusy(false); }
  }, [input, offset]);
  const refresh = useRef(load); refresh.current = load;
  useEffect(() => {
    mounted.current = true; thumbnails.activate();
    return () => { mounted.current = false; generation.current++; thumbnails.dispose(); };
  }, [thumbnails]);
  useEffect(() => {
    const unsubscribe = window.electronAPI.artifacts.onChanged(() => void load());
    void load(); return () => { generation.current++; unsubscribe(); };
  }, [load]);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => { setQuery(search.trim()); setOffset(0); setSelected([]); }, 200);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  useEffect(() => { void window.electronAPI.settings.getPlatform().then(value => { if (mounted.current) setPlatform(value); }).catch(() => undefined); }, []);
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const update = () => { if (mounted.current) setNarrow(element.clientWidth <= 1050); };
    update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 3000); return () => window.clearTimeout(timer); }, [toast]);
  const closeMenu = useCallback(() => setMenu(null), []);
  const selectedItems = result.records.filter(item => selected.includes(artifactKey(item)));
  const current = selectedItems.length === 1 ? selectedItems[0] : null;
  const path = view.kind === "folder" ? folderTrail(result.folders, view.id) : [];
  const title = view.kind === "folder" ? path.at(-1)?.name || t("library.myFolders") : view.kind === "tag" ? view.tag : t(`library.view.${view.kind}`);
  const childFolders = !query && !category && (view.kind === "all" || view.kind === "folder") ? result.folders.filter(folder => folder.parentId === (view.kind === "folder" ? view.id : null)) : [];
  const isWindows = platform === "win32", isMac = platform === "darwin";
  const selection = useLibrarySelection({ keys: result.records.map(artifactKey), selected, setSelected, platform,
    scope: JSON.stringify([input, layout]), enabled: !busy && !mutating && !loadError && !dialog && !menu });
  useEffect(() => {
    if (!selection.selecting && !selectedItems.length) { setDetailsVisible(false); setDetailsOpen(false); }
  }, [selection.selecting, selectedItems.length, detailsVisible, detailsOpen]);

  function navigate(next: LibraryView) {
    setView(next); setSearch(""); setQuery(""); setCategory(undefined); setOffset(0); setSelected([]); setError(null); setMenu(null); setSidebarOpen(false); setDetailsOpen(false); setDetailsVisible(false);
    if (next.kind === "folder") setExpanded(previous => new Set([...previous, ...folderTrail(result.folders, next.id).map(folder => folder.id)]));
  }
  function openDialog(next: LibraryDialog) { setError(null); setMenu(null); setDialog(next); }
  async function mutate(operation: () => Promise<void | DesktopArtifactMutationResult>, message?: string) {
    if (mutating) return false;
    setMutating(true); setError(null);
    try {
      const response = await operation();
      if (!mounted.current) return false;
      if (response && !response.ok) { setError(t(`library.error.${response.error}`)); return false; }
      await refresh.current();
      if (mounted.current && message) setToast(message);
      return true;
    } catch { if (mounted.current) setError(t("library.mutationFailed")); return false; }
    finally { if (mounted.current) setMutating(false); }
  }
  function organize(item: DesktopArtifactRecord, patch: Omit<DesktopArtifactOrganizeInput, keyof DesktopArtifactIdentity>) {
    return mutate(() => window.electronAPI.artifacts.organize({ ...artifactIdentity(item), ...patch }));
  }
  function move(items: DesktopArtifactIdentity[], folderId: string | null) {
    return mutate(() => window.electronAPI.artifacts.organizeMany({ items, folderId }), t("library.moved", { count: items.length }));
  }
  async function act(item: DesktopArtifactRecord, action: DesktopArtifactActionInput["action"]) {
    if (mutating) return;
    setMutating(true); setError(null);
    try {
      const response = await window.electronAPI.artifacts.act({ ...artifactIdentity(item), action });
      if (!mounted.current) return;
      if (!response.ok) setError(t(response.error && response.error !== "failed" ? `artifactManagement.status.${response.error}` : "artifactManagement.actionFailed"));
      else if (action === "view" && !onView({ ...response, chatId: item.chatId, artifactId: item.artifactId, name: artifactName(item) })) setError(t("artifactManagement.actionFailed"));
    } catch { if (mounted.current) setError(t("artifactManagement.actionFailed")); }
    finally { if (mounted.current) setMutating(false); }
  }
  async function openChat(item: DesktopArtifactRecord) {
    setError(null);
    try {
      const chat = item.agentKey ? item : await window.electronAPI.assistant.getChatInfo(item.chatId);
      if (!mounted.current) return;
      if (!chat?.agentKey) setError(t("artifactManagement.actionFailed")); else onOpenChat({ agentKey: chat.agentKey, chatId: item.chatId });
    } catch { if (mounted.current) setError(t("artifactManagement.actionFailed")); }
  }
  async function synchronize() {
    setError(null);
    try { const sync = await window.electronAPI.artifacts.sync(); if (mounted.current) setResult(previous => ({ ...previous, sync })); }
    catch { if (mounted.current) setError(t("artifactManagement.actionFailed")); }
  }
  function showMenu(event: MouseEvent<HTMLElement>, items: LibraryMenuItem[]) {
    const anchor = event.currentTarget, rect = anchor.getBoundingClientRect();
    setMenu({ anchor, x: event.type === "contextmenu" ? event.clientX : rect.right - 228, y: event.type === "contextmenu" ? event.clientY : rect.bottom + 5, items });
  }
  function showDetails(item: DesktopArtifactRecord) { selection.point(artifactKey(item)); setSelected([artifactKey(item)]); setDetailsVisible(true); setDetailsOpen(true); }
  function fileMenu(item: DesktopArtifactRecord, event: MouseEvent<HTMLElement>) {
    selection.point(artifactKey(item));
    setSelected([artifactKey(item)]);
    const canOpen = artifactCanOpen(item), external = !!artifactExternalExtension(item.name, item.mimeType);
    showMenu(event, [
      { key: "view", label: t("library.openItem"), icon: <EyeOutlined />, disabled: !canOpen || mutating, run: () => void act(item, "view") },
      { key: "favorite", label: t(item.favorite ? "artifactManagement.unfavorite" : "artifactManagement.favorite"), icon: item.favorite ? <StarFilled /> : <StarOutlined />, disabled: mutating, run: () => void organize(item, { favorite: !item.favorite }) },
      { key: "separator-1", separator: true },
      { key: "move", label: t("library.moveTo"), icon: <FolderOpenOutlined />, disabled: mutating, run: () => openDialog({ kind: "move", items: [artifactIdentity(item)], folderId: item.folderId }) },
      { key: "rename", label: t("library.rename"), icon: <EditOutlined />, disabled: mutating, run: () => openDialog({ kind: "rename-item", item }) },
      { key: "tags", label: t("library.editTags"), icon: <TagOutlined />, run: () => { showDetails(item); setFocusTags(value => value + 1); } },
      { key: "details", label: t("artifactManagement.details"), icon: <InfoCircleOutlined />, run: () => showDetails(item) },
      { key: "separator-2", separator: true },
      { key: "source", label: t("library.backToSource"), icon: <MessageOutlined />, disabled: item.sourceState !== "active", run: () => void openChat(item) },
      { key: "download", label: t("artifactManagement.download"), icon: <LinkOutlined />, disabled: !canOpen || mutating, run: () => void act(item, "download") },
      ...((isMac || isWindows) ? [{ key: "reveal", label: t(isWindows ? "artifactManagement.revealExplorer" : "artifactManagement.revealFinder"), icon: <FolderOpenOutlined />, disabled: !canOpen || mutating, run: () => void act(item, "reveal") }] : []),
      ...(external ? [{ key: "default", label: t("artifactManagement.openDefault"), icon: <ReadOutlined />, disabled: !canOpen || mutating, run: () => void act(item, "open-default") }, { key: "browser", label: t("artifactManagement.openBrowser"), icon: <EyeOutlined />, disabled: !canOpen || mutating, run: () => void act(item, "open-browser") }] : []),
    ]);
  }
  function folderMenu(folder: DesktopArtifactFolder, event: MouseEvent<HTMLElement>) {
    showMenu(event, [
      { key: "open", label: t("library.openFolder"), icon: <FolderOpenOutlined />, run: () => navigate({ kind: "folder", id: folder.id }) },
      { key: "create", label: t("library.newChildFolder"), icon: <FolderAddOutlined />, run: () => openDialog({ kind: "create", parentId: folder.id }) },
      { key: "separator", separator: true },
      { key: "rename", label: t("library.rename"), icon: <EditOutlined />, disabled: mutating, run: () => openDialog({ kind: "rename-folder", folder }) },
      { key: "delete", label: t("library.deleteEmptyFolder"), icon: <DeleteOutlined />, danger: true, disabled: mutating || folder.childCount > 0 || folder.totalCount > 0, run: () => openDialog({ kind: "delete-folder", folder }) },
    ]);
  }
  function workspaceMenu(event: MouseEvent<HTMLElement>) {
    showMenu(event, [
      { key: "create", label: t("library.newRootFolder"), icon: <FolderAddOutlined />, run: () => openDialog({ kind: "create", parentId: null }) },
      { key: "select", label: t("library.selectPage"), icon: <CheckOutlined />, disabled: !result.records.length, run: () => setSelected(result.records.map(artifactKey)) },
      { key: "sync", label: t("artifactManagement.sync"), icon: <SyncOutlined />, disabled: result.sync.phase === "syncing", run: () => void synchronize() },
      { key: "separator", separator: true },
      { key: "about", label: t("library.about"), icon: <InfoCircleOutlined />, run: () => openDialog({ kind: "about" }) },
    ]);
  }
  async function confirmDialog(name: string, folderId: string | null) {
    if (!dialog) return;
    let ok = false;
    if (dialog.kind === "create") ok = await mutate(() => window.electronAPI.artifacts.folder({ action: "create", parentId: dialog.parentId, name }), t("library.created"));
    if (dialog.kind === "rename-folder") ok = await mutate(() => window.electronAPI.artifacts.folder({ action: "rename", id: dialog.folder.id, name }), t("library.renamed"));
    if (dialog.kind === "delete-folder") ok = await mutate(() => window.electronAPI.artifacts.folder({ action: "delete", id: dialog.folder.id }), t("library.deleted"));
    if (dialog.kind === "rename-item") ok = await organize(dialog.item, { displayName: name });
    if (dialog.kind === "move") ok = await move(dialog.items, folderId);
    if (ok && mounted.current) setDialog(null);
  }
  function select(item: DesktopArtifactRecord, gesture: LibrarySelectionGesture) {
    selection.select(artifactKey(item), gesture);
    setDetailsVisible(true);
  }
  function drag(event: DragEvent, item: DesktopArtifactRecord) {
    const items = selected.includes(artifactKey(item)) ? selectedItems : [item];
    if (!selected.includes(artifactKey(item))) setSelected([artifactKey(item)]);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify(items.map(artifactIdentity)));
  }
  function changeLayout(next: LibraryLayout) { setLayout(next); try { localStorage.setItem("desktop.library.layout", next); } catch { /* Optional local presentation preference. */ } }
  const syncText = t(`artifactManagement.sync.${result.sync.phase}`, { completed: result.sync.completed, total: result.sync.total, failed: result.sync.failed, denied: result.sync.denied });

  return <LibraryThumbnailContext.Provider value={thumbnails}><section ref={page} className={`artifact-management-page library-page${sidebarOpen ? " is-sidebar-open" : ""}${detailsOpen ? " is-details-open" : ""}${!detailsVisible ? " is-details-hidden" : ""}`} aria-label={t("nav.artifactManagement")} onKeyDown={event => {
    if (dialog || menu || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
    if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchInput.current?.focus(); }
    if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(result.records.map(artifactKey)); }
    if (event.key === "Escape") { setSidebarOpen(false); setDetailsOpen(false); setSelected([]); }
  }}>
    {sidebarOpen && <button type="button" className="library-sidebar-mask" aria-label={t("library.closeNavigation")} onClick={() => setSidebarOpen(false)} />}
    <LibrarySidebar view={view} folders={result.folders} counts={result.counts} tags={result.tags} expanded={expanded} syncing={result.sync.phase === "syncing"} onNavigate={navigate} onExpand={id => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onCreate={parentId => openDialog({ kind: "create", parentId })} onFolderMenu={folderMenu} onWorkspaceMenu={workspaceMenu} onMove={(items, folderId) => { if (!mutating) void move(items, folderId); }} onSync={() => void synchronize()} />
    <main className="library-workspace">
      <header className="library-topbar"><button type="button" className="library-icon-button library-navigation-toggle" aria-label={t("library.navigation")} onClick={() => setSidebarOpen(!sidebarOpen)}><MenuOutlined /></button><nav className="library-breadcrumbs" aria-label={t("library.breadcrumb")}><button type="button" onClick={() => navigate({ kind: "all" })}>{t("nav.artifactManagement")}</button>{path.length ? path.map(folder => <span key={folder.id}><RightOutlined /><button type="button" onClick={() => navigate({ kind: "folder", id: folder.id })}>{folder.name}</button></span>) : <span><RightOutlined /><strong>{title}</strong></span>}</nav><button type="button" className="library-icon-button" aria-label={t("library.toggleDetails")} disabled={!selected.length} aria-pressed={narrow ? detailsOpen : detailsVisible} onClick={() => { if (narrow) setDetailsOpen(!detailsOpen); else setDetailsVisible(!detailsVisible); }}><InfoCircleOutlined /></button></header>
      <div className="library-main-columns"><section className="library-content" aria-label={t("library.files")}>
        <h1 className="library-view-title">{title}</h1>
        <div className="library-content-head">
        <div className="library-search-row"><label className="library-search"><SearchOutlined /><input ref={searchInput} value={search} onChange={event => setSearch(event.target.value)} type="search" aria-label={t("artifactManagement.search")} placeholder={t(view.kind === "folder" ? "library.searchFolder" : "artifactManagement.search", { name: title })} /><kbd>{isMac ? "⌘ K" : "Ctrl K"}</kbd></label><div className="library-display-controls"><button type="button" className="library-sort" aria-label={t("library.sort")} onClick={event => showMenu(event, (["date", "name", "type"] as const).map(value => ({ key: value, label: t(`library.sort.${value}`), checked: sort === value, run: () => { setSort(value); setOffset(0); } })))}>{t(`library.sort.${sort}`)}<DownOutlined /></button><div className="library-layout-switcher" role="group" aria-label={t("library.layout")}>
          {(["small", "large", "list"] as const).map(value => <button type="button" key={value} className={layout === value ? "is-active" : ""} aria-label={t(`library.layout.${value}`)} title={t(`library.layout.${value}`)} aria-pressed={layout === value} onClick={() => changeLayout(value)}>{value === "list" ? <BarsOutlined /> : <AppstoreOutlined className={`library-layout-${value}`} />}</button>)}
        </div></div></div>
        <div className="library-filters" aria-label={t("artifactManagement.type")}><button type="button" className={!category ? "is-active" : ""} aria-pressed={!category} onClick={() => { setCategory(undefined); setOffset(0); setSelected([]); }}>{t("library.allTypes")}<small>{Object.values(result.categories).reduce((sum, value) => sum + value, 0)}</small></button>{ARTIFACT_CATEGORIES.map(value => <button type="button" key={value} className={category === value ? "is-active" : ""} aria-pressed={category === value} onClick={() => { setCategory(value); setOffset(0); setSelected([]); }}>{t(`artifactManagement.category.${value}`)}{result.categories[value] ? <small>{result.categories[value]}</small> : null}</button>)}</div></div>
        {error && !dialog && <p role="alert" className="library-error">{error}<button type="button" className="library-icon-button" aria-label={t("common.close")} onClick={() => setError(null)}><CloseOutlined /></button></p>}
        <div className={`library-browse${selection.selecting ? " is-selecting" : ""}`} tabIndex={-1} onPointerDown={selection.begin} aria-busy={busy || mutating}>
          {loadError ? <div className="library-empty" role="alert"><p>{t("artifactManagement.loadFailed")}</p><button type="button" className="library-button" onClick={() => void load()}><ReloadOutlined />{t("artifactManagement.refresh")}</button></div> : <>
            {childFolders.length > 0 && <section><div className="library-section-head"><h2>{t("library.folders")}<small>{childFolders.length}</small></h2><span>{t("library.dragHint")}</span></div><div className="library-folders">{childFolders.map(folder => <LibraryFolderCard key={folder.id} folder={folder} onNavigate={() => navigate({ kind: "folder", id: folder.id })} onMenu={event => folderMenu(folder, event)} onMove={(items, id) => { if (!mutating) void move(items, id); }} />)}</div></section>}
            <div className={`library-section-head library-files-header${selected.length > 1 ? " library-selectionbar" : ""}`}>{selected.length > 1 ? <><span>{t("library.selected", { count: selected.length })}</span><div className="library-selection-actions"><button type="button" className="library-button" disabled={mutating} onClick={() => openDialog({ kind: "move", items: selectedItems.map(artifactIdentity), folderId: view.kind === "folder" ? view.id : null })}><FolderOpenOutlined />{t("library.moveTo")}</button><button type="button" className="library-button" disabled={mutating} onClick={() => void mutate(() => window.electronAPI.artifacts.organizeMany({ items: selectedItems.map(artifactIdentity), favorite: true }))}><StarOutlined />{t("artifactManagement.favorite")}</button><button type="button" className="library-icon-button" aria-label={t("library.clearSelection")} onClick={() => setSelected([])}><CloseOutlined /></button></div></> : <><h2>{t(query ? "library.searchResults" : "library.files")}<small>{result.total}</small></h2><span>{t("library.openHint")}</span></>}</div>
            {result.records.length ? <div className={`library-files layout-${layout}`}>{result.records.map(item => <LibraryFileCard key={artifactKey(item)} item={item} selected={selected.includes(artifactKey(item))} layout={layout} busy={mutating} onSelect={additive => select(item, additive)} onOpen={() => { if (artifactCanOpen(item)) void act(item, "view"); }} onMenu={event => fileMenu(item, event)} onDrag={drag} />)}</div> : <div className="library-empty" role="status"><InboxOutlined /><h2>{t(busy ? "artifactManagement.loading" : query || category || view.kind === "tag" || view.kind === "starred" ? "artifactManagement.noResults" : "library.emptyView")}</h2><p>{t(view.kind === "folder" ? "library.emptyFolderHelp" : "library.emptyLibraryHelp")}</p></div>}
          </>}
        </div>
        <footer className="library-statusbar"><span>{t("artifactManagement.count", { count: result.total })}{selected.length > 0 && ` · ${t("library.selected", { count: selected.length })}`}</span><span className={`library-sync-summary phase-${result.sync.phase}`} title={result.sync.lastSyncedAt ? `${syncText} · ${formatEpochMillis(result.sync.lastSyncedAt)}` : syncText}>{result.sync.phase === "syncing" ? <SyncOutlined spin /> : <LinkOutlined />}<span>{syncText}</span></span>{result.total > PAGE_SIZE && <div className="library-pagination"><button type="button" className="library-icon-button" disabled={busy || offset === 0} aria-label={t("artifactManagement.previous")} onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setSelected([]); }}><RightOutlined style={{ transform: "rotate(180deg)" }} /></button><span>{Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(result.total / PAGE_SIZE))}</span><button type="button" className="library-icon-button" disabled={busy || offset + PAGE_SIZE >= result.total} aria-label={t("artifactManagement.next")} onClick={() => { setOffset(offset + PAGE_SIZE); setSelected([]); }}><RightOutlined /></button></div>}</footer>
      </section>
      <LibraryInspector item={current} count={selected.length} folders={result.folders} busy={mutating} focusTags={focusTags} onClose={() => { if (narrow) setDetailsOpen(false); else setDetailsVisible(false); }} onOpen={() => { if (current) void act(current, "view"); }} onFavorite={() => { if (current) void organize(current, { favorite: !current.favorite }); }} onMenu={event => { if (current) fileMenu(current, event); }} onMove={() => { if (current) openDialog({ kind: "move", items: [artifactIdentity(current)], folderId: current.folderId }); }} onNavigate={id => navigate(id ? { kind: "folder", id } : { kind: "unfiled" })} onSource={() => { if (current) void openChat(current); }} onTags={tags => current ? organize(current, { tags }) : Promise.resolve(false)} />
      </div>
    </main>
    {selection.box && createPortal(<div className="library-selection-box" style={selection.box} aria-hidden="true" />, document.body)}
    {menu && <LibraryMenu menu={menu} onClose={closeMenu} />}
    <LibraryDialogs dialog={dialog} folders={result.folders} busy={mutating} error={error} onCancel={() => { if (!mutating) { setDialog(null); setError(null); } }} onConfirm={(name, folderId) => void confirmDialog(name, folderId)} />
    {(toast || mutating) && <div className="library-toast" role="status">{mutating ? <SyncOutlined spin /> : <CheckOutlined />}<span>{mutating ? t("library.saving") : toast}</span></div>}
  </section></LibraryThumbnailContext.Provider>;
}
