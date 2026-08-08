import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolveWebviewSelectionToolbarPosition,
  type WebviewSelectionToolbarRect,
} from "../../shared/webview-selection-toolbar";
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
  onDismiss,
}: {
  anchor: WebviewSelectionToolbarRect;
  selectionId: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const layerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState<ToolbarMeasurements>(
    EMPTY_MEASUREMENTS,
  );

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
  const dismissFromPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  };

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
        aria-label={t("webviewSelectionToolbar.label")}
        data-placement={position.placement}
        style={{
          left: position.left,
          top: position.top,
          visibility: measured ? "visible" : "hidden",
        }}
      >
        {([
          "webviewSelectionToolbar.addToChat",
          "webviewSelectionToolbar.moreDetails",
          "webviewSelectionToolbar.askInSideChat",
        ] as const).map((labelKey) => (
          <button
            key={labelKey}
            type="button"
            onPointerDown={dismissFromPointer}
            onClick={onDismiss}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
