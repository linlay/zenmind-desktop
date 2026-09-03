import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolveWebviewSelectionToolbarPosition,
  WEBVIEW_SELECTION_TOOLBAR_VERSION,
  type WebviewSelectionToolbarExecuteResult,
  type WebviewSelectionToolbarRect,
} from "../../shared/webview-selection-toolbar";
import type { AgentWebclientSelectionActionId } from "../../shared/contracts/agent-webclient-bridge";
import { useI18n } from "../i18n/useI18n";

type ToolbarMeasurements = {
  containerWidth: number;
  containerHeight: number;
  toolbarWidth: number;
  toolbarHeight: number;
};

const EMPTY_MEASUREMENTS: ToolbarMeasurements = {
  containerWidth: 0,
  containerHeight: 0,
  toolbarWidth: 0,
  toolbarHeight: 0,
};

export function WebviewSelectionToolbar({
  anchor,
  selectionId,
  onAction,
  onDismiss,
}: {
  anchor: WebviewSelectionToolbarRect;
  selectionId: string;
  onAction: (
    action: AgentWebclientSelectionActionId,
  ) => Promise<WebviewSelectionToolbarExecuteResult>;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const layerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState<ToolbarMeasurements>(
    EMPTY_MEASUREMENTS,
  );
  const [busyAction, setBusyAction] = useState<AgentWebclientSelectionActionId | null>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const toolbar = toolbarRef.current;
    if (!layer || !toolbar) return undefined;
    const measure = () => {
      const next = {
        containerWidth: layer.clientWidth,
        containerHeight: layer.clientHeight,
        toolbarWidth: toolbar.offsetWidth,
        toolbarHeight: toolbar.offsetHeight,
      };
      setMeasurements((current) =>
        current.containerWidth === next.containerWidth &&
        current.containerHeight === next.containerHeight &&
        current.toolbarWidth === next.toolbarWidth &&
        current.toolbarHeight === next.toolbarHeight
          ? current
          : next
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [selectionId]);

  const position = useMemo(
    () => resolveWebviewSelectionToolbarPosition({
      anchor,
      ...measurements,
    }),
    [anchor, measurements],
  );
  const measured = measurements.toolbarWidth > 0 && measurements.toolbarHeight > 0;
  const preserveGuestSelection = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const execute = async (action: AgentWebclientSelectionActionId) => {
    if (busyAction) return;
    setBusyAction(action);
    try {
      await onAction(action);
    } finally {
      onDismiss();
    }
  };

  const actions = [
    ["add-to-chat", "webviewSelectionToolbar.addToChat"],
    ["more-details", "webviewSelectionToolbar.moreDetails"],
    ["ask-in-side-chat", "webviewSelectionToolbar.askInSideChat"],
  ] as const;

  return (
    <div
      ref={layerRef}
      className="webview-selection-toolbar-layer"
      data-selection-id={selectionId}
    >
      <div
        ref={toolbarRef}
        className="webview-selection-toolbar"
        role="toolbar"
        aria-busy={Boolean(busyAction)}
        aria-label={t("webviewSelectionToolbar.label")}
        data-placement={position.placement}
        style={{
          left: position.left,
          top: position.top,
          visibility: measured ? "visible" : "hidden",
        }}
      >
        {actions.map(([action, labelKey]) => (
          <button
            key={action}
            type="button"
            disabled={Boolean(busyAction)}
            data-action={action}
            data-version={WEBVIEW_SELECTION_TOOLBAR_VERSION}
            onPointerDown={preserveGuestSelection}
            onClick={() => void execute(action)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
