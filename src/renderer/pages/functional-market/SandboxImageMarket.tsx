import { useEffect, useMemo, useState } from "react";
import type { MarketItem, SandboxImageImportProgressEvent } from "@shared/contracts";
import { PageFeedbackStack, type PageFeedbackItem } from "../../components/PageFeedbackStack";
import { useI18n } from "../../i18n/useI18n";
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
  createEmptyMarketResult,
  getMarketTabDefinitions,
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
  onInstallOrBuildSandboxImage: (item: MarketItem) => void;
  onImportSandboxImage: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelectImage: (item: MarketItem | null) => void;
  query: string;
  sandboxMessage: string;
  sandboxOffline: boolean;
  selectedImage: MarketItem | null;
}

const MAX_IMPORT_PROGRESS_EVENTS = 8;

function sandboxImageDescription(item: MarketItem, t: ReturnType<typeof useI18n>["t"]) {
  const description = item.description.trim();
  return description === t("market.sandbox.localDescription") ? "" : description;
}

function sandboxImportStageLabel(stage: SandboxImageImportProgressEvent["stage"], t: ReturnType<typeof useI18n>["t"]) {
  switch (stage) {
    case "checking-engine":
      return t("market.sandbox.stage.checkingEngine");
    case "extracting":
      return t("market.sandbox.stage.extracting");
    case "archive-ready":
      return t("market.sandbox.stage.archiveReady");
    case "loading":
      return t("market.sandbox.stage.loading");
    case "output":
      return t("market.sandbox.stage.output");
    case "done":
      return t("market.sandbox.stage.done");
    case "failed":
      return t("market.sandbox.stage.failed");
    default:
      return t("market.sandbox.stage.loading");
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
  const { t } = useI18n();
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
      item.type === "sandbox-image" && matchesMarketItemQuery(item, query, t)
    ),
    [marketResult.items, query, t]
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
        throw createMissingMarketApiError(commandName, t);
      }
      const next = await command({ sections: ["sandboxImages"] });
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
        throw createMissingMarketApiError("importSandboxImage", t);
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
    if (!window.confirm(t("market.sandbox.confirmDelete", { imageRef }))) {
      return;
    }
    setBusyItemId(item.id);
    try {
      const deleteSandboxImage = getMarketMethod("deleteSandboxImage");
      if (!deleteSandboxImage) {
        throw createMissingMarketApiError("deleteSandboxImage", t);
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
        throw createMissingMarketApiError("exportSandboxImage", t);
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

  async function handleInstallOrBuildSandboxImage(item: MarketItem) {
    setBusyItemId(item.id);
    try {
      const commandName = item.source === "cloud" && item.sandboxKind === "environment-template"
        ? "install"
        : "buildSandboxImage";
      const action = getMarketMethod(commandName);
      if (!action) {
        throw createMissingMarketApiError(commandName, t);
      }
      const result = await action(item.id);
      await loadMarket(true);
      setMarketFeedback(createFeedback(result.ok ? "success" : "error", result.message));
    } catch (reason) {
      console.warn(`[sandbox-image-market] failed to install/build sandbox image ${item.id}`, reason);
      setMarketFeedback(createFeedback("error", normalizeError(reason)));
    } finally {
      setBusyItemId("");
    }
  }

  const activeDefinition = getMarketTabDefinition(activeTab, t);

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      subtitle={activeDefinition.subtitle}
      tabs={getMarketTabDefinitions(t)}
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
        onInstallOrBuildSandboxImage={(item) => void handleInstallOrBuildSandboxImage(item)}
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
  onInstallOrBuildSandboxImage,
  onImportSandboxImage,
  onQueryChange,
  onRefresh,
  onSelectImage,
  query,
  sandboxMessage,
  sandboxOffline,
  selectedImage
}: SandboxImageMarketSectionProps) {
  const { t } = useI18n();
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
    const building = busyItemId === item.id;
    const exporting = exportingItemId === item.id;
    const canInstallOrBuild = item.sandboxKind === "environment-template" || Boolean(item.environmentName && item.buildTargetCount);
    return (
      <div className="market-card-inline-actions">
        {canInstallOrBuild ? (
          <button
            type="button"
            className="market-image-action-button"
            aria-label={`${building ? t("market.action.installing") : t("market.action.install")} ${item.name}`}
            title={building ? t("market.action.installing") : t("market.action.install")}
            disabled={building}
            onClick={() => onInstallOrBuildSandboxImage(item)}
          >
            <ImportIcon />
          </button>
        ) : null}
        <button
          type="button"
          className="market-image-action-button"
          aria-label={t("market.sandbox.action.viewDetails", { name: item.name })}
          title={t("market.sandbox.action.view")}
          onClick={() => onSelectImage(item)}
        >
          <EyeIcon />
        </button>
        <button
          type="button"
          className="market-image-action-button"
          aria-label={`${exporting ? t("market.sandbox.action.exporting") : t("market.sandbox.action.export")} ${item.name}`}
          title={exporting ? t("market.sandbox.action.exporting") : t("market.sandbox.action.export")}
          disabled={exporting}
          hidden={item.source === "cloud"}
          onClick={() => onExportSandboxImage(item)}
        >
          <ExportIcon />
        </button>
        <button
          type="button"
          className="market-image-action-button is-danger"
          aria-label={`${deleting ? t("market.sandbox.action.deleting") : t("market.sandbox.action.delete")} ${item.name}`}
          title={deleting ? t("market.sandbox.action.deleting") : t("market.sandbox.action.delete")}
          disabled={deleting}
          hidden={item.source === "cloud"}
          onClick={() => onDeleteSandboxImage(item)}
        >
          <TrashIcon />
        </button>
      </div>
    );
  }

  function renderImageDetail(image: MarketItem) {
    const rows = [
      [t("market.sandbox.detail.image"), image.imageRef ?? image.id],
      [t("market.sandbox.detail.imageId"), image.imageId ?? ""],
      [t("market.sandbox.detail.engine"), image.containerEngine ?? ""],
      [t("market.sandbox.detail.version"), marketVersionLabel(image)],
      [t("market.sandbox.detail.size"), image.imageSize ?? ""],
      [t("market.sandbox.detail.createdAt"), image.imageCreatedAt ?? ""],
      ["Environment", image.environmentName ?? ""]
    ].filter((row): row is [string, string] => Boolean(row[1]));

    return (
      <div className="market-image-detail-backdrop" onClick={() => onSelectImage(null)}>
        <section
          className="market-image-detail-dialog"
          aria-label={t("market.sandbox.detail.dialogLabel")}
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
                <p className="eyebrow">{t("market.sandbox.detail.eyebrow")}</p>
                <h2>{image.name}</h2>
              </div>
            </div>
            <button
              type="button"
              className="market-image-detail-close"
              aria-label={t("market.sandbox.detail.close")}
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
      message: t("market.sandbox.progress.starting"),
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
          aria-label={t("market.sandbox.progress.dialogLabel")}
          aria-live="polite"
          aria-modal="true"
          role="dialog"
        >
          <div className="market-import-progress-head">
            <div>
              <p className="eyebrow">{t("market.sandbox.progress.eyebrow")}</p>
              <h2>{sandboxImportStageLabel(latest.stage, t)}</h2>
            </div>
            <div className="market-import-progress-actions">
              <span>{latest.engine ?? "Docker / Podman"}</span>
              <button
                type="button"
                className="market-import-progress-close"
                aria-label={t("market.sandbox.progress.close")}
                title={t("common.close")}
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
            placeholder={t("market.sandbox.search.placeholder")}
          />
        </label>
        <div className="sandbox-image-filter-actions">
          <button type="button" className="market-toolbar-btn sandbox-image-text-button" onClick={onRefresh}>
            <RefreshIcon />
            <span>{isLoadingMarket ? t("market.sandbox.refreshing") : t("market.sandbox.refresh")}</span>
          </button>
          <button
            type="button"
            className="market-toolbar-btn market-toolbar-btn-primary sandbox-image-text-button"
            onClick={onImportSandboxImage}
            disabled={isImportingImage}
          >
            <ImportIcon />
            <span>{isImportingImage ? t("market.sandbox.importing") : t("market.sandbox.import")}</span>
          </button>
        </div>
      </div>

      {renderImportProgressPanel()}

      {selectedImage ? renderImageDetail(selectedImage) : null}

      {items.length > 0 ? (
        <div className="market-plugin-panel sandbox-image-panel">
          {items.map((image) => {
            const description = sandboxImageDescription(image, t);
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
                      {image.containerEngine ?? (image.source === "cloud" ? t("market.source.cloud") : t("market.source.localImage"))}
                    </span>
                    <span className="market-meta-pill">{marketVersionLabel(image)}</span>
                    <span className="market-meta-pill">{image.imageSize ?? t("market.sandbox.unknownSize")}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="market-empty-state">
          <h2>{isLoadingMarket ? t("market.sandbox.empty.loading") : t("market.sandbox.empty.title")}</h2>
          <p>{t("market.sandbox.empty.description")}</p>
        </section>
      )}
    </div>
  );
}
