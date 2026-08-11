import type { ChatWorkPanelWorkspace } from "../../shared/chat-work-panel";
import { lazy, Suspense } from "react";
import { useI18n } from "../i18n/useI18n";
import type { ExternalWebviewController } from "../pages/external-webview/ExternalWebviewPage";

const ExternalWebviewPage = lazy(async () => {
  const module = await import("../pages/external-webview/ExternalWebviewPage");
  return { default: module.ExternalWebviewPage };
});

type ChatWorkPanelSurfaceProps = {
  workspace: ChatWorkPanelWorkspace;
  visible: boolean;
  onClose: () => void;
  onControllerReady: (controller: ExternalWebviewController | null) => void;
};

export function ChatWorkPanelSurface({
  workspace,
  visible,
  onClose,
  onControllerReady
}: ChatWorkPanelSurfaceProps) {
  const { t } = useI18n();
  return (
    <aside
      className={`chat-work-panel${visible ? " is-visible" : ""}`}
      hidden={!visible}
      aria-hidden={!visible}
      aria-label={t("chatWorkPanel.title")}
    >
      <div className="chat-work-panel-body">
        <Suspense fallback={null}>
          <ExternalWebviewPage
            active={visible}
            allowUserTabCreation={false}
            cdpActive={false}
            chrome="browser"
            enableDesktopWebActions={false}
            onCloseSurface={onClose}
            onControllerReady={onControllerReady}
            openPopupsInCurrentTab
            ownerChatId={workspace.chatId}
            partition={workspace.partition}
            publishPageContext={false}
            registerPublicWebSurface={false}
            showSurfaceCloseButton
            surfaceId={workspace.surfaceId}
            surfaceCloseLabel={t("chatWorkPanel.close")}
            surfaceKind="chat-work-panel"
            surfaceLabel={t("chatWorkPanel.title")}
            title={workspace.initialTitle || t("chatWorkPanel.blankTab")}
            url={workspace.initialUrl}
          />
        </Suspense>
      </div>
    </aside>
  );
}
