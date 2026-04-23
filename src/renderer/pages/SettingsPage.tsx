import { useEffect, useState, type FormEvent } from "react";
import { CustomSidebarIcon } from "../components/BrandMark";
import type { CustomSidebarItem, CustomSidebarItemsResult } from "../../shared/contracts";

type SettingsPageProps = {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  experimentalEnabled: boolean;
  onToggleExperimental: () => void;
  customSidebarItems: CustomSidebarItem[];
  onCustomSidebarItemsChange: (items: CustomSidebarItem[]) => void;
  onRefreshCustomSidebarItems: () => Promise<CustomSidebarItemsResult>;
};

export function SettingsPage({
  themeMode,
  onToggleTheme,
  experimentalEnabled,
  onToggleExperimental,
  customSidebarItems,
  onCustomSidebarItemsChange,
  onRefreshCustomSidebarItems
}: SettingsPageProps) {
  const [feedback, setFeedback] = useState("");
  const [dataRoot, setDataRoot] = useState("");
  const [dataRootLoading, setDataRootLoading] = useState(true);
  const [customSidebarLabel, setCustomSidebarLabel] = useState("");
  const [customSidebarUrl, setCustomSidebarUrl] = useState("");
  const [customSidebarPending, setCustomSidebarPending] = useState(false);
  const [deletingCustomSidebarId, setDeletingCustomSidebarId] = useState("");

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
          setFeedback(reason instanceof Error ? reason.message : String(reason));
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
  }, []);

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

  return (
    <section className="settings-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p className="page-copy">
            管理国泰君安期货的外观与本地数据目录。运行时数据会写入这个根目录，包含
            <code>services</code>、<code>plugins</code> 和 <code>credentials</code>。
            Windows 安装版会默认使用安装目录下的 <code>data</code> 文件夹；自定义侧边栏会保存到本机设置文件。
          </p>
        </div>
      </div>

      {feedback ? <div className="feedback-banner">{feedback}</div> : null}

      <div className="data-root-card settings-theme-card">
        <div>
          <p className="eyebrow">APPEARANCE</p>
          <h2>主题模式</h2>
          <p className="page-copy">
            在浅色与深色界面之间切换。当前为
            <strong>{themeMode === "light" ? "浅色" : "深色"}</strong>
            模式。
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
              <span>更明亮、通透的工作界面</span>
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
              <span>更沉静，适合夜间或专注场景</span>
            </span>
          </button>
        </div>
      </div>

      <div className="data-root-card">
        <div>
          <p className="eyebrow">EXPERIMENTAL</p>
          <h2>实验性功能</h2>
          <p className="page-copy">
            开启后，侧边栏会显示<strong>国小君平台</strong>和<strong>秋而工作站</strong>等实验性入口。
          </p>
        </div>
        <div className="data-root-actions">
          <label className="experimental-switch" style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={experimentalEnabled} onChange={onToggleExperimental} />
            <span>{experimentalEnabled ? "已开启" : "未开启"}</span>
          </label>
        </div>
      </div>

      <div className="data-root-card custom-sidebar-card">
        <div className="custom-sidebar-copy">
          <p className="eyebrow">SIDEBAR</p>
          <h2>自定义侧边栏</h2>
          <p className="page-copy">
            默认集成的功能入口保持固定，不能修改或删除。你可以在这里添加自己的网页入口，
            例如输入 <code>www.baidu.com</code>，下次启动后也会保留在侧边栏。新增入口会自动从图标库分配不重复图标。
          </p>
        </div>
        <div className="custom-sidebar-panel">
          <form className="custom-sidebar-form" onSubmit={(event) => void handleAddCustomSidebarItem(event)}>
            <label>
              <span>入口名称</span>
              <input
                value={customSidebarLabel}
                onChange={(event) => setCustomSidebarLabel(event.target.value)}
                placeholder="例如：百度"
                maxLength={24}
              />
            </label>
            <label>
              <span>网站地址</span>
              <input
                value={customSidebarUrl}
                onChange={(event) => setCustomSidebarUrl(event.target.value)}
                placeholder="例如：www.baidu.com"
                required
              />
            </label>
            <button type="submit" className="action-button" disabled={customSidebarPending}>
              {customSidebarPending ? "添加中..." : "添加到侧边栏"}
            </button>
          </form>

          <div className="custom-sidebar-list-head">
            <strong>我的侧边栏</strong>
            <button type="button" className="text-button" onClick={() => void handleReloadCustomSidebarItems()}>
              刷新
            </button>
          </div>
          {customSidebarItems.length === 0 ? (
            <div className="custom-sidebar-empty">还没有自定义入口。添加后会显示在默认功能入口下方。</div>
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

      <div className="data-root-card">
        <div>
          <p className="eyebrow">DATA ROOT</p>
          <h2>数据目录</h2>
          <p className="page-copy">
            Windows 安装版会自动跟随安装目录；macOS 继续使用系统默认的应用数据目录。
          </p>
        </div>
        <div className="data-root-actions">
          <div className="data-root-path">{dataRootLoading ? "正在读取..." : dataRoot || "未配置"}</div>
        </div>
      </div>
    </section>
  );
}
