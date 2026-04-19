import { useEffect, useState } from "react";
import { useServices } from "../services/ServicesContext";

type SettingsPageProps = {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  experimentalEnabled: boolean;
  onToggleExperimental: () => void;
};

export function SettingsPage({
  themeMode,
  onToggleTheme,
  experimentalEnabled,
  onToggleExperimental
}: SettingsPageProps) {
  const { refresh } = useServices();
  const [feedback, setFeedback] = useState("");
  const [dataRoot, setDataRoot] = useState("");
  const [dataRootLoading, setDataRootLoading] = useState(true);
  const [dataRootPending, setDataRootPending] = useState(false);
  const isWindows = navigator.userAgent.toLowerCase().includes("windows");

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

  async function handleChangeDataRoot() {
    setDataRootPending(true);
    try {
      const result = await window.electronAPI.settings.changeDataRoot();
      setFeedback(result.message);
      setDataRoot(result.dataRoot);
      if (result.ok) {
        await refresh();
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDataRootPending(false);
    }
  }

  return (
    <section className="settings-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p className="page-copy">
            管理 ZenMind Desktop 的外观与本地数据目录。运行时数据会写入这个根目录，包含
            <code>services</code>、<code>plugins</code> 和 <code>credentials</code>。
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
            <input
              type="checkbox"
              checked={experimentalEnabled}
              onChange={onToggleExperimental}
            />
            <span>{experimentalEnabled ? "已开启" : "未开启"}</span>
          </label>
        </div>
      </div>

      <div className="data-root-card">
        <div>
          <p className="eyebrow">DATA ROOT</p>
          <h2>数据目录</h2>
          <p className="page-copy">
            修改后会迁移现有数据，并停止当前运行中的服务。
          </p>
        </div>
        <div className="data-root-actions">
          <div className="data-root-path">{dataRootLoading ? "正在读取..." : dataRoot || "未配置"}</div>
          {isWindows ? (
            <button
              type="button"
              className="action-button ghost"
              onClick={() => void handleChangeDataRoot()}
              disabled={dataRootPending}
            >
              {dataRootPending ? "迁移中..." : "修改"}
            </button>
          ) : (
            <span className="muted-inline">仅 Windows 支持修改</span>
          )}
        </div>
      </div>
    </section>
  );
}
