import { useEffect, useMemo, useState } from "react";
import type { MarketItem, SandboxImageImportProgressEvent } from "@shared/contracts";
import { PageFeedbackStack, type PageFeedbackItem } from "../../components/PageFeedbackStack";
import { MarketPageFrame } from "./MarketPageFrame";
import {
  createMissingMarketApiError,
  getMarketMethod,
  normalizeError
} from "./marketPageApi";
import {
  MarketCardGlyph,
  marketVersionLabel
} from "./marketDisplay";
import {
  MARKET_TAB_DEFINITIONS,
  createEmptyMarketResult,
  getMarketTabDefinition,
  matchesMarketItemQuery,
  type MarketViewProps
} from "./marketPageModel";

interface SandboxImageMarketSectionProps {
  busyItemId: string;
  feedbackNotice: PageFeedbackItem | null;
  exportingItemId: string;
  importProgressEvents: SandboxImageImportProgressEvent[];
  importProgressDismissed: boolean;
  isImportingImage: boolean;
  isLoadingMarket: boolean;
  items: MarketItem[];
  onDeleteSandboxImage: (item: MarketItem) => void;
  onDismissImportProgress: () => void;
  onExportSandboxImage: (item: MarketItem) => void;
  onImportSandboxImage: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelectImage: (item: MarketItem | null) => void;
  query: string;
  sandboxMessage: string;
  sandboxOffline: boolean;
  selectedImage: MarketItem | null;
}

const LOCAL_SANDBOX_IMAGE_DESCRIPTION = "本机容器引擎中的沙箱镜像。";
const MAX_IMPORT_PROGRESS_EVENTS = 8;

function sandboxImageDescription(item: MarketItem) {
  const description = item.description.trim();
  return description === LOCAL_SANDBOX_IMAGE_DESCRIPTION ? "" : description;
}

function sandboxImportStageLabel(stage: SandboxImageImportProgressEvent["stage"]) {
  switch (stage) {
    case "checking-engine":
      return "检查容器引擎";
    case "extracting":
      return "解析镜像压缩包";
    case "archive-ready":
      return "准备镜像归档";
    case "loading":
      return "导入镜像";
    case "output":
      return "导入中";
    case "done":
      return "导入完成";
    case "failed":
      return "导入失败";
    default:
      return "导入镜像";
  }
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6v5h-5" />
      <path d="M4 18v-5h5" />
      <path d="M18.1 9a7 7 0 0 0-11.6-2.5L4 9" />
      <path d="M5.9 15a7 7 0 0 0 11.6 2.5L20 15" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 15v4h14v-4" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15V3" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 15v4h14v-4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

export function SandboxImageMarket({ activeTab, onTabChange }: MarketViewProps) {
  const [query, setQuery] = useState("");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [exportingItemId, setExportingItemId] = useState("");
  const [isImportingImage, setIsImportingImage] = useState(false);
  const [importProgressEvents, setImportProgressEvents] = useState<SandboxImageImportProgressEvent[]>([]);
  const [importProgressDismissed, setImportProgressDismissed] = useState(false);
  const [marketFeedback, setMarketFeedback] = useState<PageFeedbackItem | null>(null);
  const [selectedImageId, setSelectedImageId] = useState("");

  const items = useMemo(
    () => marketResult.items.filter((item) =>
      item.type === "sandbox-image" && matchesMarketItemQuery(item, query)
    ),
    [marketResult.items, query]
  );
  const selectedImage = useMemo(
    () => items.find((item) => item.id === selectedImageId) ?? null,
    [items, selectedImageId]
  );

  function createFeedback(tone: PageFeedbackItem["tone"], message: string): PageFeedbackItem {
    return {
      id: `${Date.now()}-${tone}`,
      tone,
      message,
      onDismiss: () => setMarketFeedback(null)
    };
  }

  async function loadMarket(force = false) {
    setIsLoadingMarket(true);
    try {
      const commandName = force ? "refresh" : "list";
      const command = getMarketMethod(commandName);
      if (!command) {
        throw createMissingMarketApiError(commandName);
      }
      const next = await command();
      setMarketResult(next);
      setMarketFeedback(null);
    } catch (reason) {
      console.warn("[sandbox-image-market] failed to load market data", reason);
      setMarketFeedback(createFeedback("error", normalizeError(reason)));
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    void loadMarket(false);
  }, []);

  useEffect(() => {
    const subscribe = getMarketMethod("onSandboxImageImportProgress");
    if (!subscribe) {
      return undefined;
    }
    return subscribe((event) => {
      setImportProgressEvents((events) => [...events, event].slice(-MAX_IMPORT_PROGRESS_EVENTS));
    });
  }, []);

  async function handleImportSandboxImage() {
    setIsImportingImage(true);
    setImportProgressDismissed(false);
    setImportProgressEvents([]);
    try {
      const importSandboxImage = getMarketMethod("importSandboxImage");
      if (!importSandboxImage) {
        throw createMissingMarketApiError("importSandboxImage");
      }
      const result = await importSandboxImage();
      await loadMarket(true);
      setMarketFeedback(createFeedback(result.ok ? "success" : "error", result.message));
    } catch (reason) {
      console.warn("[sandbox-image-market] failed to import sandbox image", reason);
      setMarketFeedback(createFeedback("error", normalizeError(reason)));
    } finally {
      setIsImportingImage(false);
    }
  }

  async function handleDeleteSandboxImage(item: MarketItem) {
    const imageRef = item.imageRef ?? item.id;
    if (!window.confirm(`确定删除沙箱镜像？\n\n${imageRef}\n\n此操作会从本机 Docker / Podman 移除镜像，不能撤销。`)) {
      return;
    }
    setBusyItemId(item.id);
    try {
      const deleteSandboxImage = getMarketMethod("deleteSandboxImage");
      if (!deleteSandboxImage) {
        throw createMissingMarketApiError("deleteSandboxImage");
      }
      const result = await deleteSandboxImage(imageRef);
      if (selectedImageId === item.id) {
        setSelectedImageId("");
      }
      await loadMarket(true);
      setMarketFeedback(createFeedback(result.ok ? "success" : "error", result.message));
    } catch (reason) {
      console.warn(`[sandbox-image-market] failed to delete sandbox image ${item.id}`, reason);
      setMarketFeedback(createFeedback("error", normalizeError(reason)));
    } finally {
      setBusyItemId("");
    }
  }

  async function handleExportSandboxImage(item: MarketItem) {
    const imageRef = item.imageRef ?? item.id;
    setExportingItemId(item.id);
    try {
      const exportSandboxImage = getMarketMethod("exportSandboxImage");
      if (!exportSandboxImage) {
        throw createMissingMarketApiError("exportSandboxImage");
      }
      const result = await exportSandboxImage(imageRef);
      setMarketFeedback(createFeedback(result.ok ? "success" : "error", result.message));
    } catch (reason) {
      console.warn(`[sandbox-image-market] failed to export sandbox image ${item.id}`, reason);
      setMarketFeedback(createFeedback("error", normalizeError(reason)));
    } finally {
      setExportingItemId("");
    }
  }

  const activeDefinition = getMarketTabDefinition(activeTab);

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      subtitle={activeDefinition.subtitle}
      tabs={MARKET_TAB_DEFINITIONS}
      title={activeDefinition.title}
      toolbar={null}
    >
      <SandboxImageMarketSection
        busyItemId={busyItemId}
        feedbackNotice={marketFeedback}
        exportingItemId={exportingItemId}
        importProgressEvents={importProgressEvents}
        importProgressDismissed={importProgressDismissed}
        isImportingImage={isImportingImage}
        isLoadingMarket={isLoadingMarket}
        items={items}
        onDeleteSandboxImage={(item) => void handleDeleteSandboxImage(item)}
        onDismissImportProgress={() => setImportProgressDismissed(true)}
        onExportSandboxImage={(item) => void handleExportSandboxImage(item)}
        onImportSandboxImage={() => void handleImportSandboxImage()}
        onQueryChange={setQuery}
        onRefresh={() => void loadMarket(true)}
        onSelectImage={(item) => setSelectedImageId(item?.id ?? "")}
        query={query}
        sandboxMessage={marketResult.sandboxMessage || ""}
        sandboxOffline={Boolean(marketResult.sandboxOffline)}
        selectedImage={selectedImage}
      />
    </MarketPageFrame>
  );
}

export function SandboxImageMarketSection({
  busyItemId,
  feedbackNotice,
  exportingItemId,
  importProgressEvents,
  importProgressDismissed,
  isImportingImage,
  isLoadingMarket,
  items,
  onDeleteSandboxImage,
  onDismissImportProgress,
  onExportSandboxImage,
  onImportSandboxImage,
  onQueryChange,
  onRefresh,
  onSelectImage,
  query,
  sandboxMessage,
  sandboxOffline,
  selectedImage
}: SandboxImageMarketSectionProps) {
  const sandboxStatus = sandboxMessage;
  const latestImportProgress = importProgressEvents[importProgressEvents.length - 1] ?? null;
  const importProgressLogEvents = importProgressEvents.filter((event) => event.stage === "output").slice(-4);
  const feedbackItems = feedbackNotice
    ? [feedbackNotice]
    : sandboxStatus
      ? [{
          id: "sandbox-status",
          tone: sandboxOffline ? "error" : "success",
          message: sandboxStatus
        } satisfies PageFeedbackItem]
      : [];

  function renderSandboxActions(item: MarketItem) {
    const deleting = busyItemId === item.id;
    const exporting = exportingItemId === item.id;
    return (
      <div className="market-card-inline-actions">
        <button
          type="button"
          className="market-image-action-button"
          aria-label={`查看 ${item.name} 镜像详情`}
          title="查看"
          onClick={() => onSelectImage(item)}
        >
          <EyeIcon />
        </button>
        <button
          type="button"
          className="market-image-action-button"
          aria-label={`${exporting ? "导出中" : "导出"} ${item.name}`}
          title={exporting ? "导出中" : "导出"}
          disabled={exporting}
          onClick={() => onExportSandboxImage(item)}
        >
          <ExportIcon />
        </button>
        <button
          type="button"
          className="market-image-action-button is-danger"
          aria-label={`${deleting ? "删除中" : "删除"} ${item.name}`}
          title={deleting ? "删除中" : "删除"}
          disabled={deleting}
          onClick={() => onDeleteSandboxImage(item)}
        >
          <TrashIcon />
        </button>
      </div>
    );
  }

  function renderImageDetail(image: MarketItem) {
    const rows = [
      ["镜像", image.imageRef ?? image.id],
      ["镜像 ID", image.imageId ?? ""],
      ["引擎", image.containerEngine ?? ""],
      ["版本", marketVersionLabel(image)],
      ["大小", image.imageSize ?? ""],
      ["创建时间", image.imageCreatedAt ?? ""],
      ["Environment", image.environmentName ?? ""]
    ].filter((row): row is [string, string] => Boolean(row[1]));

    return (
      <div className="market-image-detail-backdrop" onClick={() => onSelectImage(null)}>
        <section
          className="market-image-detail-dialog"
          aria-label="沙箱镜像详情"
          aria-modal="true"
          role="dialog"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="market-image-detail-head">
            <div className="market-image-detail-title">
              <div className="market-card-icon" aria-hidden="true">
                <MarketCardGlyph kind="sandbox" />
              </div>
              <div>
                <p className="eyebrow">镜像详情</p>
                <h2>{image.name}</h2>
              </div>
            </div>
            <button
              type="button"
              className="market-image-detail-close"
              aria-label="关闭镜像详情"
              onClick={() => onSelectImage(null)}
            >
              <CloseIcon />
            </button>
          </div>
          <dl className="market-image-detail-grid">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    );
  }

  function renderImportProgressPanel() {
    if (importProgressDismissed || (!latestImportProgress && !isImportingImage)) {
      return null;
    }
    const latest = latestImportProgress ?? {
      stage: "loading",
      message: "正在启动沙箱镜像导入。",
      engine: "Docker / Podman"
    } satisfies SandboxImageImportProgressEvent;
    const statusClass = latest.stage === "failed"
      ? "is-error"
      : latest.stage === "done" ? "is-complete" : "is-running";
    const shouldShowImportProgressLog = importProgressLogEvents.length > 0 && latest.stage !== "done";

    return (
      <div className="market-import-progress-backdrop">
        <section
          className={`market-import-progress-panel ${statusClass}`}
          aria-label="镜像导入进度"
          aria-live="polite"
          aria-modal="true"
          role="dialog"
        >
          <div className="market-import-progress-head">
            <div>
              <p className="eyebrow">镜像导入进程</p>
              <h2>{sandboxImportStageLabel(latest.stage)}</h2>
            </div>
            <div className="market-import-progress-actions">
              <span>{latest.engine ?? "Docker / Podman"}</span>
              <button
                type="button"
                className="market-import-progress-close"
                aria-label="关闭导入进度"
                title="关闭"
                onClick={onDismissImportProgress}
              >
                <CloseIcon />
              </button>
            </div>
          </div>
          <p className="market-import-progress-message">{latest.message}</p>
          {isImportingImage ? (
            <div className="market-import-progress-bar" aria-hidden="true">
              <span />
            </div>
          ) : null}
          {shouldShowImportProgressLog ? (
            <ol className="market-import-progress-log">
              {importProgressLogEvents.map((event, index) => (
                <li key={`${event.taskId ?? "import"}-${index}-${event.message}`}>
                  <span>{event.stream ?? "engine"}</span>
                  <code>{event.message}</code>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="market-content">
      {feedbackItems.length > 0 ? (
        <div className="sandbox-feedback-stack">
          <PageFeedbackStack items={feedbackItems} />
        </div>
      ) : null}

      <div className="market-filter-bar market-filter-bar-single sandbox-image-filter-bar">
        <label className="market-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </svg>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索镜像名 / 标签 / 引擎"
          />
        </label>
        <div className="sandbox-image-filter-actions">
          <button type="button" className="market-toolbar-btn sandbox-image-text-button" onClick={onRefresh}>
            <RefreshIcon />
            <span>{isLoadingMarket ? "刷新中" : "刷新镜像"}</span>
          </button>
          <button
            type="button"
            className="market-toolbar-btn market-toolbar-btn-primary sandbox-image-text-button"
            onClick={onImportSandboxImage}
            disabled={isImportingImage}
          >
            <ImportIcon />
            <span>{isImportingImage ? "导入中" : "导入镜像"}</span>
          </button>
        </div>
      </div>

      {renderImportProgressPanel()}

      {selectedImage ? renderImageDetail(selectedImage) : null}

      {items.length > 0 ? (
        <div className="market-plugin-panel sandbox-image-panel">
          {items.map((image) => {
            const description = sandboxImageDescription(image);
            return (
              <article key={`${image.type}:${image.id}`} className="market-skill-card sandbox-image-card">
                <div className="market-plugin-feature-head">
                  <div className="market-card-icon" aria-hidden="true">
                    <MarketCardGlyph kind="sandbox" />
                  </div>
                  <div className="market-card-heading">
                    <div className="market-card-title-row">
                      <h2>{image.name}</h2>
                      <div className="market-card-footer-action">
                        {renderSandboxActions(image)}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="market-plugin-meta">
                  <div className="market-card-footer-main sandbox-image-footer-tags">
                    <span className="market-meta-pill sandbox-engine-pill">
                      {image.containerEngine ?? "本机镜像"}
                    </span>
                    <span className="market-meta-pill">{marketVersionLabel(image)}</span>
                    <span className="market-meta-pill">{image.imageSize ?? "未知大小"}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="market-empty-state">
          <h2>{isLoadingMarket ? "正在加载沙箱镜像" : "暂无沙箱镜像"}</h2>
          <p>可以刷新本机镜像列表，或导入 Docker / Podman 镜像压缩包。</p>
        </section>
      )}
    </div>
  );
}
