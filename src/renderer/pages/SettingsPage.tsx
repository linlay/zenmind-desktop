import { useEffect, useState } from "react";
import { useServices } from "../services/ServicesContext";

export function SettingsPage() {
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
            管理 ZenMind Desktop 的本地数据目录。运行时数据会写入这个根目录，包含
            <code>services</code>、<code>plugins</code> 和 <code>credentials</code>。
          </p>
        </div>
      </div>

      {feedback ? <div className="feedback-banner">{feedback}</div> : null}

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
