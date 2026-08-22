import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { CloseOutlined } from "@ant-design/icons";
import { createSurfaceIdentity } from "../../../shared/surface-identity";
import { useI18n } from "../../i18n/useI18n";
import { ServiceWebviewSurface } from "../../service-webview/ServiceWebviewSurface";

type ChatHistoryDialogProps = {
  agentKey?: string;
  hostTheme: "light" | "dark";
  isMac: boolean;
  isWindows: boolean;
  onClose: () => void;
  onOpenChat: (request: { agentKey: string; chatId: string }) => void;
};

const HISTORY_SURFACE_IDENTITY = createSurfaceIdentity("history");

function getDialogFocusableElements(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), webview, [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((element) => element !== dialog && !element.hasAttribute("hidden"));
}

export function ChatHistoryDialog({
  agentKey = "",
  hostTheme,
  isMac,
  isWindows,
  onClose,
  onOpenChat,
}: ChatHistoryDialogProps) {
  const { t } = useI18n();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openChatHandledRef = useRef(false);
  const normalizedAgentKey = agentKey.trim();
  const embedPath = useMemo(() => {
    if (!normalizedAgentKey) return "/history";
    const params = new URLSearchParams({ agentKey: normalizedAgentKey });
    return `/history?${params.toString()}`;
  }, [normalizedAgentKey]);

  useLayoutEffect(() => {
    const previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    const appShell = layer?.closest<HTMLElement>(".app-shell");
    if (!layer || !appShell) return;
    const siblings = Array.from(appShell.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== layer,
    );
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    return () => {
      siblings.forEach((element, index) => {
        element.inert = previousInert[index] ?? false;
      });
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusableElements = getDialogFocusableElements(dialog);
      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1);
      if (!firstElement || !lastElement) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === firstElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        lastElement.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeElement === lastElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        firstElement.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const title = t("sidebar.chats.viewMoreHistory");
  return (
    <div
      ref={layerRef}
      className="chat-history-dialog-layer"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={[
          "chat-history-dialog",
          isMac ? "is-mac" : "",
          isWindows ? "is-windows" : "",
        ].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-history-dialog-title"
        tabIndex={-1}
        data-agent-key={normalizedAgentKey || undefined}
      >
        <header className="chat-history-dialog-header">
          <h2 id="chat-history-dialog-title">{title}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="chat-history-dialog-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            <CloseOutlined aria-hidden="true" />
          </button>
        </header>
        <div className="chat-history-dialog-content">
          <ServiceWebviewSurface
            hostTheme={hostTheme}
            serviceId="agent-webclient"
            surfaceIdentity={HISTORY_SURFACE_IDENTITY}
            active
            surfaceOwnershipActive={false}
            embedPath={embedPath}
            surfaceLabel={title}
            loadInitialEmbeddedUrlDirectly
            suppressInitialLoadingCopy
            onAgentWebclientHistoryOpenChat={(request) => {
              if (openChatHandledRef.current) return;
              openChatHandledRef.current = true;
              onOpenChat(request);
            }}
          />
        </div>
      </section>
    </div>
  );
}
