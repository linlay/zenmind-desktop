import { useEffect, useState, type FormEvent } from "react";
import { CustomSidebarIcon } from "../components/BrandMark";
import type {
  AssistantMemorySettings,
  AssistantMemorySummary,
  AssistantMemoryStorage,
  AssistantMemoryStats,
  AssistantSettingsPublic,
  CustomSidebarItem,
  CustomSidebarItemsResult
} from "../../shared/contracts";

type SettingsPageProps = {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  isMac: boolean;
  isWindows: boolean;
  sidebarTranslucencyEnabled: boolean;
  onToggleSidebarTranslucency: () => void;
  customSidebarItems: CustomSidebarItem[];
  onCustomSidebarItemsChange: (items: CustomSidebarItem[]) => void;
  onRefreshCustomSidebarItems: () => Promise<CustomSidebarItemsResult>;
};

type WindowsDataRootCardProps = {
  onError: (message: string) => void;
};

function formatMemoryTime(value: string | null | undefined) {
  if (!value) {
    return "暂无";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "暂无";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function WindowsDataRootCard({ onError }: WindowsDataRootCardProps) {
  const [dataRoot, setDataRoot] = useState("");
  const [dataRootLoading, setDataRootLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.settings
      .getDataRoot()
      .then((root) => {
        if (!cancelled) {
          setDataRoot(root);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          onError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDataRootLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onError]);

  return (
    <div className="data-root-card">
      <div>
        <p className="eyebrow">DATA ROOT</p>
        <h2>数据目录</h2>
        <p className="page-copy">
          Windows 安装版会自动跟随安装目录，默认使用只读方式显示数据目录。
        </p>
      </div>
      <div className="data-root-actions">
        <div className="data-root-path">{dataRootLoading ? "正在读取..." : dataRoot || "未配置"}</div>
      </div>
    </div>
  );
}

export function SettingsPage({
  themeMode,
  onToggleTheme,
  isMac,
  isWindows,
  sidebarTranslucencyEnabled,
  onToggleSidebarTranslucency,
  customSidebarItems,
  onCustomSidebarItemsChange,
  onRefreshCustomSidebarItems
}: SettingsPageProps) {
  const [feedback, setFeedback] = useState("");
  const [customSidebarLabel, setCustomSidebarLabel] = useState("");
  const [customSidebarUrl, setCustomSidebarUrl] = useState("");
  const [customSidebarPending, setCustomSidebarPending] = useState(false);
  const [customSidebarTransferPending, setCustomSidebarTransferPending] = useState("");
  const [deletingCustomSidebarId, setDeletingCustomSidebarId] = useState("");
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const [assistantBaseURL, setAssistantBaseURL] = useState("");
  const [assistantModel, setAssistantModel] = useState("");
  const [assistantApiKey, setAssistantApiKey] = useState("");
  const [assistantClearApiKey, setAssistantClearApiKey] = useState(false);
  const [assistantSettingsPending, setAssistantSettingsPending] = useState(false);
  const [memorySettings, setMemorySettings] = useState<AssistantMemorySettings | null>(null);
  const [memoryStats, setMemoryStats] = useState<AssistantMemoryStats | null>(null);
  const [memoryStorage, setMemoryStorage] = useState<AssistantMemoryStorage | null>(null);
  const [memoryRecentAudit, setMemoryRecentAudit] = useState<AssistantMemorySummary["recentAudit"]>(null);
  const [memoryPending, setMemoryPending] = useState("");

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.assistant
      .getSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        applyAssistantSettings(settings);
      })
      .catch((reason) => {
        if (!cancelled) {
          setFeedback(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.assistant
      .getMemorySummary()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setMemorySettings(result.settings);
        setMemoryStats(result.stats);
        setMemoryStorage(result.storage);
        setMemoryRecentAudit(result.recentAudit ?? null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setFeedback(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshMemoryItems() {
    const result = await window.electronAPI.assistant.getMemorySummary();
    setMemorySettings(result.settings);
    setMemoryStats(result.stats);
    setMemoryStorage(result.storage);
    setMemoryRecentAudit(result.recentAudit ?? null);
    return result;
  }

  async function handleAddCustomSidebarItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCustomSidebarPending(true);
    try {
      const result = await window.electronAPI.customSidebar.add({
        label: customSidebarLabel,
        url: customSidebarUrl
      });
      setFeedback(result.message);
      onCustomSidebarItemsChange(result.items);
      if (result.ok) {
        setCustomSidebarLabel("");
        setCustomSidebarUrl("");
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCustomSidebarPending(false);
    }
  }

  async function handleDeleteCustomSidebarItem(item: CustomSidebarItem) {
    setDeletingCustomSidebarId(item.id);
    try {
      const result = await window.electronAPI.customSidebar.remove(item.id);
      setFeedback(result.message);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeletingCustomSidebarId("");
    }
  }

  async function handleReloadCustomSidebarItems() {
    try {
      const result = await onRefreshCustomSidebarItems();
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function handleImportCustomSidebarItems() {
    setCustomSidebarTransferPending("import");
    try {
      const result = await window.electronAPI.customSidebar.import();
      setFeedback(result.message);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCustomSidebarTransferPending("");
    }
  }

  async function handleExportCustomSidebarItems() {
    setCustomSidebarTransferPending("export");
    try {
      const result = await window.electronAPI.customSidebar.export();
      setFeedback(result.path ? `${result.message} ${result.path}` : result.message);
      onCustomSidebarItemsChange(result.items);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCustomSidebarTransferPending("");
    }
  }

  function applyAssistantSettings(settings: AssistantSettingsPublic) {
    setAssistantSettings(settings);
    setAssistantBaseURL(settings.baseURL);
    setAssistantModel(settings.model);
  }

  async function handleSaveAssistantSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAssistantSettingsPending(true);
    try {
      const settings = await window.electronAPI.assistant.saveSettings({
        baseURL: assistantBaseURL,
	        model: assistantModel,
	        ...(assistantApiKey.trim() ? { apiKey: assistantApiKey } : {}),
	        clearApiKey: assistantClearApiKey
	      });
	      applyAssistantSettings(settings);
	      setAssistantApiKey("");
	      setAssistantClearApiKey(false);
	      setFeedback(settings.configured ? "助手模型配置已保存。" : "助手模型配置已保存，请补齐 API Key 后使用。");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAssistantSettingsPending(false);
    }
  }

  async function handleToggleMemoryEnabled() {
    if (!memorySettings) {
      return;
    }
    setMemoryPending("settings");
    try {
      const nextSettings = await window.electronAPI.assistant.saveMemorySettings({
        ...memorySettings,
        enabled: !memorySettings.enabled
      });
      setMemorySettings(nextSettings);
      setFeedback(nextSettings.enabled ? "助手记忆已开启。" : "助手记忆已关闭。");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMemoryPending("");
    }
  }

  async function handleToggleMemoryAutoLearn() {
    if (!memorySettings) {
      return;
    }
    setMemoryPending("settings");
    try {
      const nextSettings = await window.electronAPI.assistant.saveMemorySettings({
        ...memorySettings,
        autoLearn: !memorySettings.autoLearn
      });
      setMemorySettings(nextSettings);
      setFeedback(nextSettings.autoLearn ? "自动学习已开启。" : "自动学习已关闭。");
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMemoryPending("");
    }
  }

  async function handleClearMemoryItems() {
    setMemoryPending("clear");
    try {
      const result = await window.electronAPI.assistant.clearMemoryItems();
      setFeedback(result.message);
      await refreshMemoryItems();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMemoryPending("");
    }
  }

  async function handleOpenMemoryDirectory() {
    setMemoryPending("open");
    try {
      const result = await window.electronAPI.assistant.openMemoryDirectory();
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMemoryPending("");
    }
  }

  return (
    <section className="settings-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p className="page-copy">
            {isWindows ? (
              <>
                调整界面风格，管理左侧固定入口，并查看数据存储目录（包含 <code>services</code>、<code>plugins</code> 等）。
                安装版默认使用安装目录下的 <code>data</code> 文件夹，自定义入口仅保存在本地。
              </>
            ) : (
              <>调整界面风格，并管理左侧固定入口。自定义入口仅保存在本地。</>
            )}
          </p>
        </div>
      </div>

      {feedback ? <div className="feedback-banner">{feedback}</div> : null}

      <div className="data-root-card settings-theme-card">
        <div>
          <p className="eyebrow">APPEARANCE</p>
          <h2>主题模式</h2>
          <p className="page-copy">
            选择你更习惯的界面风格。当前正在使用
            <strong>{themeMode === "light" ? "浅色" : "深色"}</strong>
            主题。
          </p>
        </div>
        <div className="settings-theme-actions">
          <button
            type="button"
            className={themeMode === "light" ? "settings-theme-option is-active" : "settings-theme-option"}
            onClick={() => {
              if (themeMode !== "light") {
                onToggleTheme();
              }
            }}
          >
            <span className="settings-theme-preview settings-theme-preview-light" aria-hidden="true">
              <span />
              <span />
            </span>
            <span className="settings-theme-copy">
              <strong>浅色</strong>
              <span>适合白天和明亮环境</span>
            </span>
          </button>
          <button
            type="button"
            className={themeMode === "dark" ? "settings-theme-option is-active" : "settings-theme-option"}
            onClick={() => {
              if (themeMode !== "dark") {
                onToggleTheme();
              }
            }}
          >
            <span className="settings-theme-preview settings-theme-preview-dark" aria-hidden="true">
              <span />
              <span />
            </span>
            <span className="settings-theme-copy">
              <strong>深色</strong>
              <span>适合夜间和长时间专注</span>
            </span>
          </button>
        </div>
      </div>

      {isMac ? (
        <div className="data-root-card settings-switch-card">
          <h2>半透明侧边栏</h2>
          <button
            type="button"
            className={sidebarTranslucencyEnabled ? "settings-switch is-on" : "settings-switch"}
            role="switch"
            aria-checked={sidebarTranslucencyEnabled}
            aria-label="半透明侧边栏"
            onClick={onToggleSidebarTranslucency}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="data-root-card custom-sidebar-card">
        <div className="custom-sidebar-copy">
          <p className="eyebrow">SIDEBAR</p>
          <h2>自定义侧边栏</h2>
          <p className="page-copy">
            将常用网页固定至左侧便捷访问。自定义入口仅保存在本地，支持导入导出，系统入口不可修改。
          </p>
        </div>
        <div className="custom-sidebar-panel">
          <form className="custom-sidebar-form" onSubmit={(event) => void handleAddCustomSidebarItem(event)}>
            <label>
              <span>显示名称</span>
              <input
                value={customSidebarLabel}
                onChange={(event) => setCustomSidebarLabel(event.target.value)}
                placeholder="例如：官网、知识库"
                maxLength={24}
              />
            </label>
            <label>
              <span>网页地址</span>
              <input
                value={customSidebarUrl}
                onChange={(event) => setCustomSidebarUrl(event.target.value)}
                placeholder="支持输入完整链接或域名，例如 jira.example.com"
                required
              />
            </label>
            <div className="custom-sidebar-submit-wrap">
              <button type="submit" className="text-button custom-sidebar-submit" disabled={customSidebarPending}>
                {customSidebarPending ? "添加中..." : "添加到侧边栏"}
              </button>
            </div>
          </form>

          <div className="custom-sidebar-list-head">
            <strong>已添加的入口</strong>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                className="text-button"
                onClick={() => void handleImportCustomSidebarItems()}
                disabled={customSidebarTransferPending !== ""}
              >
                {customSidebarTransferPending === "import" ? "导入中..." : "导入"}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => void handleExportCustomSidebarItems()}
                disabled={customSidebarTransferPending !== ""}
              >
                {customSidebarTransferPending === "export" ? "导出中..." : "导出"}
              </button>
              <button type="button" className="text-button" onClick={() => void handleReloadCustomSidebarItems()}>
                刷新
              </button>
            </div>
          </div>
          {customSidebarItems.length === 0 ? (
            <div className="custom-sidebar-empty">还没有添加自定义入口，添加后会显示在系统入口下方。</div>
          ) : (
            <div className="custom-sidebar-list">
              {customSidebarItems.map((item) => (
                <div className="custom-sidebar-row" key={item.id}>
                  <div className="custom-sidebar-row-main">
                    <span className="custom-sidebar-row-icon" aria-hidden="true">
                      <CustomSidebarIcon iconId={item.iconId} />
                    </span>
                    <div className="custom-sidebar-row-copy">
                      <strong>{item.label}</strong>
                      <span>{item.url}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="danger-text-button"
                    onClick={() => void handleDeleteCustomSidebarItem(item)}
                    disabled={deletingCustomSidebarId === item.id}
                  >
                    {deletingCustomSidebarId === item.id ? "删除中..." : "删除"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {isWindows ? <WindowsDataRootCard onError={setFeedback} /> : null}

      <div className="data-root-card assistant-settings-card">
        <div className="custom-sidebar-copy">
          <p className="eyebrow">ASSISTANT</p>
          <h2>助手模型</h2>
          <p className="page-copy">
            配置 OpenAI-compatible 模型后，ZenMind助手会在右侧抽屉中直接问答和总结当前页面。
            API Key 只保存在本机主进程配置里。
          </p>
          {assistantSettings?.source === "agent-platform" ? (
            <p className="settings-inline-note">
              当前正在复用 {assistantSettings.sourceLabel ?? "agent-platform"} 配置，下面的 Desktop 配置仅作为备用。
            </p>
          ) : null}
          {assistantSettings?.apiKeyConfigured ? (
            <p className="settings-inline-note">已保存 API Key。留空不会覆盖现有密钥。</p>
          ) : (
            <p className="settings-inline-note">尚未保存 API Key。</p>
          )}
        </div>
        <form className="assistant-settings-form" onSubmit={(event) => void handleSaveAssistantSettings(event)}>
          <label>
            <span>Base URL</span>
            <input
              value={assistantBaseURL}
              onChange={(event) => setAssistantBaseURL(event.target.value)}
              placeholder="https://api.openai.com/v1"
              required
            />
          </label>
          <label>
            <span>模型</span>
            <input
              value={assistantModel}
              onChange={(event) => setAssistantModel(event.target.value)}
              placeholder="gpt-4o"
              required
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              value={assistantApiKey}
              onChange={(event) => {
                setAssistantApiKey(event.target.value);
                if (event.target.value.trim()) {
                  setAssistantClearApiKey(false);
                }
              }}
              placeholder={assistantSettings?.apiKeyConfigured ? "已保存，留空不变" : "请输入 API Key"}
              type="password"
              autoComplete="off"
            />
          </label>
          <label className="assistant-settings-checkbox">
            <input
              type="checkbox"
              checked={assistantClearApiKey}
              onChange={(event) => {
                setAssistantClearApiKey(event.target.checked);
                if (event.target.checked) {
                  setAssistantApiKey("");
                }
              }}
            />
            <span>清除已保存的 API Key</span>
          </label>
          <button type="submit" className="text-button" disabled={assistantSettingsPending}>
            {assistantSettingsPending ? "保存中..." : "保存助手配置"}
          </button>
        </form>
      </div>

      <div className="data-root-card assistant-memory-card">
        <div className="custom-sidebar-copy">
          <p className="eyebrow">MEMORY</p>
          <h2>助手记忆</h2>
          <p className="page-copy">
            侧边栏助手会在本机静默学习长期偏好和可复用结论，并在后续回答中按需引用。
          </p>
          <p className="settings-inline-note">
            共 {memoryStats?.total ?? 0} 条，稳定 {memoryStats?.factCount ?? 0} 条，观察 {memoryStats?.observationCount ?? 0} 条。
          </p>
          <p className="settings-inline-note">
            最近学习：{formatMemoryTime(memoryStats?.lastLearnedAt)}；最近引用：{formatMemoryTime(memoryStats?.lastReferencedAt)}
          </p>
          <p className="settings-inline-note">
            最近记录：{memoryRecentAudit?.operation || "暂无"}
            {memoryRecentAudit?.status ? ` / ${memoryRecentAudit.status}` : ""}
            {memoryRecentAudit?.reason ? ` / ${memoryRecentAudit.reason}` : ""}
          </p>
        </div>
        <div className="assistant-memory-panel">
          <div className="assistant-memory-switches">
            <div className="assistant-memory-switch-row">
              <span>记忆召回</span>
              <button
                type="button"
                className={memorySettings?.enabled ? "settings-switch is-on" : "settings-switch"}
                role="switch"
                aria-checked={Boolean(memorySettings?.enabled)}
                aria-label="记忆召回"
                disabled={!memorySettings || memoryPending === "settings"}
                onClick={() => void handleToggleMemoryEnabled()}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            <div className="assistant-memory-switch-row">
              <span>自动学习</span>
              <button
                type="button"
                className={memorySettings?.autoLearn ? "settings-switch is-on" : "settings-switch"}
                role="switch"
                aria-checked={Boolean(memorySettings?.autoLearn)}
                aria-label="自动学习"
                disabled={!memorySettings || memoryPending === "settings"}
                onClick={() => void handleToggleMemoryAutoLearn()}
              >
                <span aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="custom-sidebar-list-head">
            <strong>本地存储</strong>
            <span className="assistant-memory-storage-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => void handleOpenMemoryDirectory()}
                disabled={memoryPending === "open"}
              >
                {memoryPending === "open" ? "打开中..." : "打开记忆目录"}
              </button>
              <button
                type="button"
                className="danger-text-button"
                onClick={() => void handleClearMemoryItems()}
                disabled={(memoryStats?.total ?? 0) === 0 || memoryPending === "clear"}
              >
                {memoryPending === "clear" ? "清空中..." : "清空"}
              </button>
            </span>
          </div>
          <div className="assistant-memory-storage">
            <div>
              <span>记忆目录</span>
              <code>{memoryStorage?.directoryPath ?? "正在读取..."}</code>
            </div>
            <div>
              <span>结构化记忆</span>
              <code>{memoryStorage?.recordsPath ?? "正在读取..."}</code>
            </div>
            <div>
              <span>静态长期记忆</span>
              <code>{memoryStorage?.staticPath ?? "正在读取..."}</code>
            </div>
            <div>
              <span>审计日志</span>
              <code>{memoryStorage?.auditPath ?? "正在读取..."}</code>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
