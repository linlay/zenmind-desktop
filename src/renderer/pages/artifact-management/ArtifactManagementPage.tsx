import { EllipsisOutlined, FileOutlined, ReloadOutlined, SearchOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { Dropdown, Modal, Select } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { ARTIFACT_CATEGORIES, artifactExternalExtension, type DesktopArtifactActionError, type DesktopArtifactCategory, type DesktopArtifactActionInput, type DesktopArtifactListResult, type DesktopArtifactRecord } from "../../../shared/artifacts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";

const PAGE_SIZE = 50;
type ArtifactUiAction = DesktopArtifactActionInput["action"] | "details";

function orderedActions(item: DesktopArtifactRecord): ArtifactUiAction[] {
  const extension = artifactExternalExtension(item.name, item.mimeType);
  if (extension === ".html" || extension === ".htm" || extension === ".xhtml") {
    return ["view", "open-browser", "download", "details", "reveal", "open-default"];
  }
  if (extension) {
    return ["view", "open-default", "download", "details", "reveal", "open-browser"];
  }
  return ["view", "download", "details", "reveal"];
}

export function ArtifactManagementPage({ onOpenChat, onView }: {
  onView: (request: { agentKey: string; chatId: string; artifactId: string; relativePath: string; name: string }) => boolean;
  onOpenChat: (request: { agentKey: string; chatId: string }) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<DesktopArtifactListResult>({ records: [], total: 0, tags: [], sync: { phase: "idle", completed: 0, total: 0, failed: 0, denied: 0 } });
  const [category, setCategory] = useState<DesktopArtifactCategory | undefined>();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [tag, setTag] = useState<string | undefined>();
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<DesktopArtifactRecord | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<DesktopArtifactActionError | "restart" | null>(null);
  const [platform, setPlatform] = useState<string>("");
  async function act(item: DesktopArtifactRecord, action: DesktopArtifactActionInput["action"]) {
    setActionBusy(true);
    setActionError(null);
    try {
      if (typeof window.electronAPI.artifacts.act !== "function") {
        setActionError("restart");
        return;
      }
      const response = await window.electronAPI.artifacts.act({ chatId: item.chatId, runId: item.runId, artifactId: item.artifactId, action });
      if (!response.ok) { setActionError(response.error || "failed"); return; }
      if (action === "view" && !onView({ ...response, chatId: item.chatId, artifactId: item.artifactId, name: item.name })) setActionError("failed");
    } catch { setActionError("failed"); }
    finally { setActionBusy(false); }
  }
  function runAction(item: DesktopArtifactRecord, action: ArtifactUiAction) {
    if (action === "details") { setDraftTags(item.tags); setSelected(item); return; }
    void act(item, action);
  }
  async function openChat(chatId: string) {
    setActionError(null);
    try {
      const chat = result.records.find(item => item.chatId === chatId && item.agentKey) || await window.electronAPI.assistant.getChatInfo(chatId);
      if (!chat?.agentKey) { setActionError("failed"); return; }
      onOpenChat({ agentKey: chat.agentKey, chatId });
    } catch { setActionError("failed"); }
  }
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setError(false);
    try {
      const next = await window.electronAPI.artifacts.list({ search: query, offset, limit: PAGE_SIZE, category, favoritesOnly, tag });
      if (request === generation.current) {
        setResult(next);
        if (offset > 0 && offset >= next.total) setOffset(Math.max(0, Math.floor((next.total - 1) / PAGE_SIZE) * PAGE_SIZE));
        setSelected(previous => previous ? next.records.find(item => item.chatId === previous.chatId && item.runId === previous.runId && item.artifactId === previous.artifactId) ?? null : null);
      }
    } catch {
      if (request === generation.current) setError(true);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [query, offset, category, favoritesOnly, tag]);

  async function organize(item: DesktopArtifactRecord, patch: { favorite?: boolean; tags?: string[] }) {
    setActionBusy(true); setActionError(null);
    try {
      await window.electronAPI.artifacts.organize({ chatId: item.chatId, runId: item.runId, artifactId: item.artifactId, ...patch });
      await load();
    } catch { setActionError("failed"); }
    finally { setActionBusy(false); }
  }
  async function synchronize() {
    setActionError(null);
    try { const sync = await window.electronAPI.artifacts.sync(); setResult(previous => ({ ...previous, sync })); await load(); }
    catch { setActionError("failed"); }
  }
  function status(item: DesktopArtifactRecord) {
    if (item.sourceState !== "active") return item.sourceState;
    if (item.contentState !== "ready") return item.contentState;
    if (item.accessState === "denied" || item.accessState === "error") return item.accessState;
    return "ready";
  }

  useEffect(() => {
    void window.electronAPI.settings.getPlatform().then(setPlatform).catch(() => undefined);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const unsubscribe = window.electronAPI.artifacts.onChanged(() => void load());
    void load();
    return () => { generation.current++; unsubscribe(); };
  }, [load]);

  return <section className="artifact-management-page" aria-labelledby="artifact-management-title">
    <header className="artifact-management-header">
      <div>
        <h1 id="artifact-management-title">{t("nav.artifactManagement")}</h1>
        <p>{t("artifactManagement.description")}</p>
      </div>
      <button type="button" className="artifact-management-button" disabled={result.sync.phase === "syncing"} onClick={() => void synchronize()}>
        <ReloadOutlined spin={result.sync.phase === "syncing"} />{t("artifactManagement.sync")}
      </button>
    </header>
    <div className="artifact-management-toolbar">
      <label className="artifact-management-search">
        <SearchOutlined aria-hidden="true" />
        <input value={search} onChange={(event) => setSearch(event.target.value)}
          aria-label={t("artifactManagement.search")} placeholder={t("artifactManagement.search")} />
      </label>
      <div className="artifact-management-filters">
        <Select aria-label={t("artifactManagement.type")} value={category || "all"} onChange={value => { setCategory(value === "all" ? undefined : value as DesktopArtifactCategory); setOffset(0); }}
          options={[{ value: "all", label: t("artifactManagement.allTypes") }, ...ARTIFACT_CATEGORIES.map(value => ({ value, label: t(`artifactManagement.category.${value}`) }))]} />
        <Select allowClear aria-label={t("artifactManagement.tags")} placeholder={t("artifactManagement.tags")} value={tag} onChange={value => { setTag(value); setOffset(0); }} options={result.tags.map(value => ({ value, label: value }))} />
        <button type="button" className="artifact-management-button" aria-pressed={favoritesOnly} onClick={() => { setFavoritesOnly(!favoritesOnly); setOffset(0); }}>
          {favoritesOnly ? <StarFilled /> : <StarOutlined />}{t("artifactManagement.favorites")}
        </button>
        <span aria-live="polite">{t("artifactManagement.count", { count: result.total })}</span>
      </div>
    </div>
    <div className="artifact-management-sync" role="status">
      {t(`artifactManagement.sync.${result.sync.phase}`, { completed: result.sync.completed, total: result.sync.total, failed: result.sync.failed, denied: result.sync.denied })}
      {result.sync.lastSyncedAt && <span>{t("artifactManagement.lastSynced", { time: formatEpochMillis(result.sync.lastSyncedAt) })}</span>}
    </div>
    <p className="artifact-management-scope">{t("artifactManagement.scope")}</p>
    {actionBusy && <p role="status">{t("artifactManagement.preparing")}</p>}
    {actionError && <p role="alert">{t(actionError === "restart" ? "artifactManagement.restartRequired" : actionError === "failed" ? "artifactManagement.actionFailed" : `artifactManagement.status.${actionError}`)}</p>}
    {error ? <div className="artifact-management-empty" role="alert">{t("artifactManagement.loadFailed")}</div>
      : result.records.length === 0 ? <div className="artifact-management-empty" role="status">
        <FileOutlined /><p>{t(busy ? "artifactManagement.loading" : query || category || favoritesOnly || tag ? "artifactManagement.noResults" : "artifactManagement.empty")}</p>
      </div> : <div className="artifact-management-table-scroll" aria-busy={busy}>
        <table className="artifact-management-table">
          <thead><tr>
            <th>{t("artifactManagement.name")}</th><th>{t("artifactManagement.type")}</th><th>{t("artifactManagement.source")}</th>
            <th>{t("artifactManagement.size")}</th><th>{t("artifactManagement.pushedAt")}</th><th>{t("artifactManagement.actions")}</th>
          </tr></thead>
          <tbody>{result.records.map((item) => {
            const chat = item;
            const unavailable = item.sourceState !== "active" || ["unresolved", "ambiguous"].includes(item.contentState);
            const labels: Record<ArtifactUiAction, string> = {
              download: t("artifactManagement.download"),
              view: t("artifactManagement.view"),
              details: t("artifactManagement.details"),
              reveal: t(platform === "win32" ? "artifactManagement.revealExplorer" : "artifactManagement.revealFinder"),
              "open-default": t("artifactManagement.openDefault"),
              "open-browser": t("artifactManagement.openBrowser"),
            };
            const actions = orderedActions(item).map((key) => ({ key, label: labels[key] }));
            return <tr key={JSON.stringify([item.chatId, item.runId, item.artifactId])}>
              <td><div className="artifact-management-title-row">
                <button type="button" className="artifact-management-star" disabled={actionBusy} aria-pressed={item.favorite} aria-label={t(item.favorite ? "artifactManagement.unfavorite" : "artifactManagement.favorite")} onClick={() => void organize(item, { favorite: !item.favorite })}>{item.favorite ? <StarFilled /> : <StarOutlined />}</button>
                <button type="button" className="artifact-management-name artifact-management-clamp" title={item.name} onClick={() => runAction(item, "details")}>{item.name}</button>
              </div>
                <div className="artifact-management-tags">{item.tags.map(value => <span key={value}>{value}</span>)}</div>
                {status(item) !== "ready" && <span className="artifact-management-status">{t(`artifactManagement.status.${status(item)}`)}</span>}
              </td>
              <td><span className="artifact-management-clamp" title={item.mimeType}>{t(`artifactManagement.category.${item.category}`)}</span></td>
              <td><button type="button" title={chat?.chatName || item.chatId} className="artifact-management-chat artifact-management-clamp" onClick={() => void openChat(item.chatId)}>
                {chat?.chatName || item.chatId}
              </button></td>
              <td className="artifact-management-size">{formatSize(item.sizeBytes)}</td>
              <td><time className="artifact-management-clamp">{formatEpochMillis(item.pushedAt)}</time></td>
              <td><div className="artifact-management-actions">
                {actions.slice(0, 2).map((action) => <button key={action.key} type="button" disabled={actionBusy || unavailable} onClick={() => runAction(item, action.key)}>{action.label}</button>)}
                <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: actions.slice(2).map(action => ({ ...action, disabled: action.key !== "details" && unavailable })), onClick: ({ key }) => runAction(item, key as ArtifactUiAction) }}>
                  <button type="button" disabled={actionBusy} className="artifact-management-extra-menu" aria-label={t("artifactManagement.extraMenuButton")} title={t("artifactManagement.extraMenuButton")}><EllipsisOutlined /></button>
                </Dropdown>
              </div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    <Modal open={selected !== null} title={t("artifactManagement.details")} footer={null} onCancel={() => setSelected(null)}>
      {selected && <dl className="artifact-management-details">
        <dt>{t("artifactManagement.name")}</dt><dd>{selected.name}</dd>
        <dt>{t("artifactManagement.type")}</dt><dd>{selected.mimeType || t("artifactManagement.unknownType")}</dd>
        <dt>{t("artifactManagement.source")}</dt><dd>{selected.chatName || selected.chatId}</dd>
        <dt>{t("artifactManagement.size")}</dt><dd>{formatSize(selected.sizeBytes)}</dd>
        <dt>{t("artifactManagement.pushedAt")}</dt><dd>{formatEpochMillis(selected.pushedAt)}</dd>
        <dt>{t("artifactManagement.artifactId")}</dt><dd>{selected.artifactId}</dd>
        <dt>{t("artifactManagement.runId")}</dt><dd>{selected.runId || t("artifactManagement.status.unresolved")}</dd>
        <dt>{t("artifactManagement.status")}</dt><dd>{t(`artifactManagement.status.${status(selected)}`)}</dd>
        <dt>{t("artifactManagement.checksum")}</dt><dd>{selected.sha256 || "—"}</dd>
        <dt>{t("artifactManagement.tags")}</dt><dd>
          <Select mode="tags" aria-label={t("artifactManagement.tags")} className="artifact-management-tag-editor" value={draftTags} onChange={setDraftTags} maxCount={20}
            options={result.tags.map(value => ({ value, label: value }))} />
          <p>{t("artifactManagement.tagsHelp")}</p>
          <button type="button" className="artifact-management-button" disabled={actionBusy || draftTags.some(value => !value.trim() || value.length > 64)} onClick={() => void organize(selected, { tags: draftTags })}>{t("artifactManagement.saveTags")}</button>
        </dd>
      </dl>}
    </Modal>
    <footer className="artifact-management-pagination">
      <button type="button" className="artifact-management-button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t("artifactManagement.previous")}</button>
      <span>{Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(result.total / PAGE_SIZE))}</span>
      <button type="button" className="artifact-management-button" disabled={busy || offset + PAGE_SIZE >= result.total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("artifactManagement.next")}</button>
    </footer>
  </section>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
