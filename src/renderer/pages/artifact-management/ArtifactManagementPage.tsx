import { FileOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Modal } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopArtifactListResult, DesktopArtifactRecord } from "../../../shared/artifacts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";

const PAGE_SIZE = 50;

export function ArtifactManagementPage({ onOpenChat, onView }: {
  onView: (request: { agentKey: string; chatId: string; artifactId: string; relativePath: string; name: string }) => boolean;
  onOpenChat: (request: { agentKey: string; chatId: string }) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<DesktopArtifactListResult>({ records: [], total: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [chats, setChats] = useState<Record<string, { agentKey: string; chatName: string }>>({});
  const [selected, setSelected] = useState<DesktopArtifactRecord | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<"failed" | "restart" | null>(null);
  async function act(item: DesktopArtifactRecord, action: "view" | "download") {
    setActionBusy(true);
    setActionError(null);
    try {
      if (typeof window.electronAPI.artifacts.act !== "function") {
        setActionError("restart");
        return;
      }
      const response = await window.electronAPI.artifacts.act({ chatId: item.chatId, artifactId: item.artifactId, action });
      if (!response.ok) { setActionError("failed"); return; }
      if (action === "view" && !onView({ ...response, chatId: item.chatId, artifactId: item.artifactId, name: item.name })) setActionError("failed");
    } catch { setActionError("failed"); }
    finally { setActionBusy(false); }
  }
  async function openChat(chatId: string) {
    setActionError(null);
    try {
      const chat = chats[chatId] || await window.electronAPI.assistant.getChatInfo(chatId);
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
      const next = await window.electronAPI.artifacts.list({ search: query, offset, limit: PAGE_SIZE });
      if (request === generation.current) setResult(next);
    } catch {
      if (request === generation.current) setError(true);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [query, offset]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const unsubscribe = window.electronAPI.artifacts.onChanged(() => void load());
    void load();
    return () => { generation.current++; unsubscribe(); };
  }, [load]);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.assistant.listHistoryChats().then((history) => {
      if (cancelled || !history.ok) return;
      setChats(Object.fromEntries(history.items.map((chat) => [chat.chatId, {
        agentKey: chat.agentKey, chatName: chat.chatName || chat.chatId,
      }])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [result.total]);

  return <section className="artifact-management-page" aria-labelledby="artifact-management-title">
    <header className="artifact-management-header">
      <div>
        <h1 id="artifact-management-title">{t("nav.artifactManagement")}</h1>
        <p>{t("artifactManagement.description")}</p>
      </div>
      <button type="button" className="artifact-management-button" disabled={busy} onClick={() => void load()}>
        <ReloadOutlined spin={busy} />{t("artifactManagement.refresh")}
      </button>
    </header>
    <div className="artifact-management-toolbar">
      <label className="artifact-management-search">
        <SearchOutlined aria-hidden="true" />
        <input value={search} onChange={(event) => setSearch(event.target.value)}
          aria-label={t("artifactManagement.search")} placeholder={t("artifactManagement.search")} />
      </label>
      <span aria-live="polite">{t("artifactManagement.count", { count: result.total })}</span>
    </div>
    {actionBusy && <p role="status">{t("artifactManagement.preparing")}</p>}
    {actionError && <p role="alert">{t(actionError === "restart" ? "artifactManagement.restartRequired" : "artifactManagement.actionFailed")}</p>}
    {error ? <div className="artifact-management-empty" role="alert">{t("artifactManagement.loadFailed")}</div>
      : result.records.length === 0 ? <div className="artifact-management-empty" role="status">
        <FileOutlined /><p>{t(busy ? "artifactManagement.loading" : query ? "artifactManagement.noResults" : "artifactManagement.empty")}</p>
      </div> : <div className="artifact-management-table-scroll" aria-busy={busy}>
        <table className="artifact-management-table">
          <thead><tr>
            <th>{t("artifactManagement.name")}</th><th>{t("artifactManagement.type")}</th><th>{t("artifactManagement.source")}</th>
            <th>{t("artifactManagement.size")}</th><th>{t("artifactManagement.pushedAt")}</th><th>{t("artifactManagement.actions")}</th>
          </tr></thead>
          <tbody>{result.records.map((item) => {
            const chat = chats[item.chatId];
            return <tr key={JSON.stringify([item.chatId, item.artifactId])}>
              <td><strong className="artifact-management-clamp" title={item.name}>{item.name}</strong></td>
              <td><span className="artifact-management-clamp" title={item.mimeType}>{item.mimeType || t("artifactManagement.unknownType")}</span></td>
              <td><button type="button" title={chat?.chatName || item.chatId} className="artifact-management-chat artifact-management-clamp" onClick={() => void openChat(item.chatId)}>
                {chat?.chatName || item.chatId}
              </button></td>
              <td className="artifact-management-size">{formatSize(item.sizeBytes)}</td>
              <td><time className="artifact-management-clamp">{formatEpochMillis(item.pushedAt)}</time></td>
              <td><div className="artifact-management-actions">
                <button type="button" disabled={actionBusy} onClick={() => void act(item, "download")}>{t("artifactManagement.download")}</button>
                <button type="button" disabled={actionBusy} onClick={() => void act(item, "view")}>{t("artifactManagement.view")}</button>
                <button type="button" onClick={() => setSelected(item)}>{t("artifactManagement.details")}</button>
              </div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    <Modal open={selected !== null} title={t("artifactManagement.details")} footer={null} onCancel={() => setSelected(null)}>
      {selected && <dl className="artifact-management-details">
        <dt>{t("artifactManagement.name")}</dt><dd>{selected.name}</dd>
        <dt>{t("artifactManagement.type")}</dt><dd>{selected.mimeType || t("artifactManagement.unknownType")}</dd>
        <dt>{t("artifactManagement.source")}</dt><dd>{chats[selected.chatId]?.chatName || selected.chatId}</dd>
        <dt>{t("artifactManagement.size")}</dt><dd>{formatSize(selected.sizeBytes)}</dd>
        <dt>{t("artifactManagement.pushedAt")}</dt><dd>{formatEpochMillis(selected.pushedAt)}</dd>
        <dt>{t("artifactManagement.artifactId")}</dt><dd>{selected.artifactId}</dd>
        <dt>{t("artifactManagement.checksum")}</dt><dd>{selected.sha256 || "—"}</dd>
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
