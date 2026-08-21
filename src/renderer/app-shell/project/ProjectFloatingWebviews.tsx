import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ServiceWebviewSurface } from "../../service-webview/ServiceWebviewSurface";
import { createSurfaceIdentity } from "../../../shared/surface-identity";
import { useI18n } from "../../i18n/useI18n";

export type ProjectFloatingWebviewEntry = {
  agentKey: string;
  displayName: string;
  embedPath: string;
  focusRequestId: number;
};

type FloatingPosition = {
  left: number;
  top: number;
};

type ProjectFloatingWebviewsProps = {
  entries: ProjectFloatingWebviewEntry[];
  hostTheme: "light" | "dark";
  isMac: boolean;
  isWindows: boolean;
  windowFullScreen: boolean;
  onBringToFront: (agentKey: string) => void;
  onClose: (agentKey: string) => void;
};

type ProjectFloatingWebviewPanelProps = {
  entry: ProjectFloatingWebviewEntry;
  hostTheme: "light" | "dark";
  isMac: boolean;
  isWindows: boolean;
  windowFullScreen: boolean;
  position: FloatingPosition;
  zIndex: number;
  onBringToFront: () => void;
  onClose: () => void;
  onPositionChange: (position: FloatingPosition) => void;
};

function getFloatingInsets(
  isMac: boolean,
  isWindows: boolean,
  windowFullScreen: boolean,
) {
  if (isMac) {
    return { top: windowFullScreen ? 12 : 36, right: 12, bottom: 12, left: 12 };
  }
  if (isWindows) {
    return { top: 52, right: 12, bottom: 12, left: 12 };
  }
  return { top: 12, right: 12, bottom: 12, left: 12 };
}

function clampFloatingPosition(
  position: FloatingPosition,
  panelWidth: number,
  panelHeight: number,
  isMac: boolean,
  isWindows: boolean,
  windowFullScreen: boolean,
) {
  const insets = getFloatingInsets(isMac, isWindows, windowFullScreen);
  const maxLeft = Math.max(
    insets.left,
    window.innerWidth - insets.right - panelWidth,
  );
  const maxTop = Math.max(
    insets.top,
    window.innerHeight - insets.bottom - panelHeight,
  );
  return {
    left: Math.min(maxLeft, Math.max(insets.left, position.left)),
    top: Math.min(maxTop, Math.max(insets.top, position.top)),
  };
}

function createInitialFloatingPosition(
  index: number,
  isMac: boolean,
  isWindows: boolean,
  windowFullScreen: boolean,
) {
  const panelWidth = Math.min(1080, Math.max(0, window.innerWidth - 24));
  const panelHeight = Math.min(760, Math.max(0, window.innerHeight - 64));
  const cascadeOffset = (index % 8) * 24;
  return clampFloatingPosition(
    {
      left: Math.round((window.innerWidth - panelWidth) / 2) + cascadeOffset,
      top:
        getFloatingInsets(isMac, isWindows, windowFullScreen).top +
        cascadeOffset,
    },
    panelWidth,
    panelHeight,
    isMac,
    isWindows,
    windowFullScreen,
  );
}

function ProjectFloatingWebviewPanel({
  entry,
  hostTheme,
  isMac,
  isWindows,
  windowFullScreen,
  position,
  zIndex,
  onBringToFront,
  onClose,
  onPositionChange,
}: ProjectFloatingWebviewPanelProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const title = t("projectFloating.title", { name: entry.displayName });

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [entry.focusRequestId]);

  useEffect(() => {
    const handleResize = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const nextPosition = clampFloatingPosition(
        position,
        rect.width,
        rect.height,
        isMac,
        isWindows,
        windowFullScreen,
      );
      if (
        nextPosition.left !== position.left ||
        nextPosition.top !== position.top
      ) {
        onPositionChange(nextPosition);
      }
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [
    isMac,
    isWindows,
    onPositionChange,
    position,
    windowFullScreen,
  ]);

  function handleDragPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: position.left,
      startTop: position.top,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleDragPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect) {
      return;
    }
    onPositionChange(
      clampFloatingPosition(
        {
          left: drag.startLeft + event.clientX - drag.startClientX,
          top: drag.startTop + event.clientY - drag.startClientY,
        },
        rect.width,
        rect.height,
        isMac,
        isWindows,
        windowFullScreen,
      ),
    );
  }

  function handleDragPointerEnd(event: ReactPointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const style = {
    left: `${position.left}px`,
    top: `${position.top}px`,
    zIndex,
  } satisfies CSSProperties;

  return (
    <section
      ref={panelRef}
      className={[
        "project-floating-webview",
        dragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onPointerDownCapture={onBringToFront}
    >
      <header
        className="project-floating-webview-header"
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerEnd}
        onPointerCancel={handleDragPointerEnd}
      >
        <span className="project-floating-webview-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.75a2.25 2.25 0 0 1-2.25 2.25H5.75a2.25 2.25 0 0 1-2.25-2.25V6.5Z" />
          </svg>
        </span>
        <strong title={title}>{entry.displayName}</strong>
        <button
          type="button"
          className="project-floating-webview-close"
          aria-label={t("projectFloating.close")}
          title={t("projectFloating.close")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
      </header>
      <div className="project-floating-webview-content">
        <ServiceWebviewSurface
          active
          surfaceOwnershipActive={false}
          serviceId="agent-webclient"
          surfaceIdentity={createSurfaceIdentity("project", entry.agentKey)}
          surfaceIdentityKey={entry.agentKey}
          surfaceLabel={title}
          hostTheme={hostTheme}
          embedPath={entry.embedPath}
          loadInitialEmbeddedUrlDirectly
          skipContextRegistration
          suppressInitialLoadingCopy
        />
      </div>
    </section>
  );
}

export function ProjectFloatingWebviews({
  entries,
  hostTheme,
  isMac,
  isWindows,
  windowFullScreen,
  onBringToFront,
  onClose,
}: ProjectFloatingWebviewsProps) {
  const [positions, setPositions] = useState<Record<string, FloatingPosition>>(
    {},
  );

  useEffect(() => {
    setPositions((current) => {
      const next: Record<string, FloatingPosition> = {};
      let changed = Object.keys(current).length !== entries.length;
      entries.forEach((entry, index) => {
        const position =
          current[entry.agentKey] ??
          createInitialFloatingPosition(
            index,
            isMac,
            isWindows,
            windowFullScreen,
          );
        next[entry.agentKey] = position;
        changed ||= current[entry.agentKey] !== position;
      });
      return changed ? next : current;
    });
  }, [entries, isMac, isWindows, windowFullScreen]);

  return entries.map((entry, index) => (
    <ProjectFloatingWebviewPanel
      key={entry.agentKey}
      entry={entry}
      hostTheme={hostTheme}
      isMac={isMac}
      isWindows={isWindows}
      windowFullScreen={windowFullScreen}
      position={
        positions[entry.agentKey] ??
        createInitialFloatingPosition(
          index,
          isMac,
          isWindows,
          windowFullScreen,
        )
      }
      zIndex={52 + Math.min(index, 17)}
      onBringToFront={() => onBringToFront(entry.agentKey)}
      onClose={() => onClose(entry.agentKey)}
      onPositionChange={(position) => {
        setPositions((current) =>
          current[entry.agentKey]?.left === position.left &&
          current[entry.agentKey]?.top === position.top
            ? current
            : { ...current, [entry.agentKey]: position },
        );
      }}
    />
  ));
}
