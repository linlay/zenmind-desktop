import { useEffect, useState, type FormEvent } from "react";
import { CustomSidebarIcon } from "../components/BrandMark";
import type { CustomSidebarItem, CustomSidebarItemsResult } from "../../shared/contracts";

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
    </section>
  );
}
