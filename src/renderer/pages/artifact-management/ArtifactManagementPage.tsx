import { FileOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopArtifactListResult } from "../../../shared/artifacts";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";

const PAGE_SIZE = 50;

export function ArtifactManagementPage({ onOpenChat }: {
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
    {error ? <div className="artifact-management-empty" role="alert">{t("artifactManagement.loadFailed")}</div>
      : result.records.length === 0 ? <div className="artifact-management-empty" role="status">
        <FileOutlined /><p>{t(busy ? "artifactManagement.loading" : query ? "artifactManagement.noResults" : "artifactManagement.empty")}</p>
      </div> : <div className="artifact-management-table-scroll" aria-busy={busy}>
        <table className="artifact-management-table">
          <thead><tr>
            <th>{t("artifactManagement.name")}</th><th>{t("artifactManagement.source")}</th>
            <th>{t("artifactManagement.size")}</th><th>{t("artifactManagement.pushedAt")}</th>
          </tr></thead>
          <tbody>{result.records.map((item) => {
            const chat = chats[item.chatId];
            return <tr key={JSON.stringify([item.chatId, item.artifactId])}>
              <td><strong>{item.name}</strong><small>{item.mimeType || t("artifactManagement.unknownType")}</small>
                <details><summary>{t("artifactManagement.details")}</summary>
                  <dl><dt>{t("artifactManagement.artifactId")}</dt><dd>{item.artifactId}</dd>
                    <dt>{t("artifactManagement.checksum")}</dt><dd>{item.sha256 || "—"}</dd>
                  </dl>
                </details>
              </td>
              <td>{chat?.agentKey ? <button type="button" className="artifact-management-chat" onClick={() => onOpenChat({ agentKey: chat.agentKey, chatId: item.chatId })}>
                {chat.chatName}
              </button> : <span>{item.chatId}</span>}</td>
              <td className="artifact-management-size">{formatSize(item.sizeBytes)}</td>
              <td><time>{formatEpochMillis(item.pushedAt)}</time></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
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
