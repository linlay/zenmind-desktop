import { AppstoreOutlined, CodeOutlined, FolderOpenOutlined, GlobalOutlined, MessageOutlined, ProjectOutlined } from "@ant-design/icons";
import { useRef, useState } from "react";
import { normalizeWorkPanelWebUrl } from "../../shared/work-panel";
import { useI18n } from "../i18n/useI18n";
import "./WorkPanelNewTab.css";

type Webapp = { id: string; label: string };
type Props = {
  urlDraft: string;
  onUrlDraftChange(value: string): void;
  localOnly: boolean;
  projectVisible: boolean;
  projectEnabled: boolean;
  projectDisabledReason?: string;
  webapps: Webapp[];
  openWebappWindowIds: Set<string>;
  websites: Array<{ id: string; title: string; url: string }>;
  onOpenWeb(url: string): void;
  onOpenFiles(): Promise<void>;
  onOpenSideChat(): void;
  onOpenProject(): void;
  onOpenWebapp(webapp: Webapp): void;
};

export function WorkPanelNewTab(props: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [openingFiles, setOpeningFiles] = useState(false);
  const [showWebapps, setShowWebapps] = useState(false);
  const tools = [
    ...(!props.localOnly ? [
      { key: "web", label: t("chatWorkPanel.add.web"), icon: <GlobalOutlined />, action: () => inputRef.current?.focus() },
      { key: "terminal", label: t("chatWorkPanel.add.terminal"), icon: <CodeOutlined />, disabled: true, hint: t("chatWorkPanel.add.comingSoon") },
    ] : []),
    { key: "files", label: t("chatWorkPanel.add.files"), icon: <FolderOpenOutlined />, disabled: openingFiles, action: async () => {
      setOpeningFiles(true);
      try { await props.onOpenFiles(); }
      catch { setError(t("chatWorkPanel.newTab.fileError")); }
      finally { setOpeningFiles(false); }
    } },
    ...(!props.localOnly ? [
      { key: "sideChat", label: t("chatWorkPanel.add.sideChat"), icon: <MessageOutlined />, action: props.onOpenSideChat },
      ...(props.projectVisible ? [{ key: "project", label: t("chatWorkPanel.add.project"), icon: <ProjectOutlined />, disabled: !props.projectEnabled,
        hint: props.projectDisabledReason, action: props.onOpenProject }] : []),
      { key: "webapp", label: t("chatWorkPanel.add.webapp"), icon: <AppstoreOutlined />, disabled: !props.webapps.length,
        action: () => setShowWebapps(current => !current) },
    ] : []),
  ];
  return <section className="work-panel-new-tab" aria-label={t("chatWorkPanel.newTab.title")}>
    {!props.localOnly && <form className="work-panel-new-tab-address" onSubmit={event => {
      event.preventDefault();
      const url = normalizeWorkPanelWebUrl(props.urlDraft);
      if (!url) { setError(t("chatWorkPanel.add.webInvalid")); inputRef.current?.focus(); return; }
      props.onOpenWeb(url);
    }}>
      <GlobalOutlined aria-hidden="true" />
      <input ref={inputRef} autoFocus aria-label={t("chatWorkPanel.add.webPrompt")}
        placeholder={t("chatWorkPanel.newTab.address")} value={props.urlDraft} autoComplete="off" spellCheck={false}
        aria-invalid={Boolean(error)} aria-describedby={error ? "work-panel-new-tab-error" : undefined}
        onChange={event => { props.onUrlDraftChange(event.target.value); setError(""); }} />
    </form>}
    {error && <p id="work-panel-new-tab-error" className="work-panel-new-tab-error" role="alert">{error}</p>}
    <div className="work-panel-new-tab-content">
      <h2>{t("chatWorkPanel.newTab.tools")}</h2>
      <div className="work-panel-new-tab-tools">
        {tools.map(tool => <button key={tool.key} type="button" disabled={tool.disabled} title={tool.hint}
          aria-busy={tool.key === "files" && openingFiles} onClick={tool.action}>
          {tool.icon}<span>{tool.label}</span>
          {tool.hint && <small>{tool.hint}</small>}
        </button>)}
      </div>
      {!props.localOnly && (props.websites.length > 0 || props.webapps.length > 0 || showWebapps) && <>
        <h2>{t(showWebapps ? "chatWorkPanel.add.webapp" : "chatWorkPanel.newTab.suggested")}</h2>
        <div className="work-panel-new-tab-suggestions">
          {!showWebapps && props.websites.map(site => <button key={site.id} type="button" title={site.url}
            onClick={() => props.onOpenWeb(site.url)}><span className="work-panel-new-tab-site-icon"><GlobalOutlined /></span><span>{site.title || site.url}</span></button>)}
          {props.webapps.map(webapp => <button key={webapp.id} type="button" title={webapp.label}
            onClick={() => props.onOpenWebapp(webapp)}><span className="work-panel-new-tab-site-icon"><AppstoreOutlined /></span><span>{webapp.label}</span>
            {props.openWebappWindowIds.has(webapp.id) && <small>{t("chatWorkPanel.add.webappInWindow")}</small>}
          </button>)}
        </div>
        {showWebapps && !props.webapps.length && <p>{t("chatWorkPanel.add.noWebapps")}</p>}
      </>}
    </div>
  </section>;
}
