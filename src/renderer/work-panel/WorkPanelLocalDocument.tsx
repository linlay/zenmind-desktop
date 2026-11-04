import { lazy, Suspense } from "react";
import type { LocalDocumentItem } from "../../shared/local-document";
import { useI18n } from "../i18n/useI18n";
import "./WorkPanelLocalDocument.css";

const ExternalWebviewPage = lazy(() =>
  import("../pages/external-webview/ExternalWebviewPage").then((module) => ({ default: module.ExternalWebviewPage })),
);

export type WorkPanelLocalDocumentData = Pick<LocalDocumentItem,
  "documentId" | "fileName" | "kind" | "url" | "partition" | "ownerChatId" | "version"
>;

type WorkPanelLocalDocumentProps = {
  document: WorkPanelLocalDocumentData;
  active: boolean;
  onLoadingChange?: (loading: boolean) => void;
};

export function WorkPanelLocalDocument({
  document, active, onLoadingChange,
}: WorkPanelLocalDocumentProps) {
  const { t } = useI18n();

  return (
    <div className="work-panel-local-document" data-local-document-id={document.documentId}>
      <Suspense fallback={<div className="work-panel-local-document-loading" role="status">{t("common.loading")}</div>}>
        <ExternalWebviewPage
          active={active}
          title={document.fileName}
          url={document.url}
          partition={document.partition}
          initialTabId={document.documentId}
          chrome="browser"
          documentPreview
          documentPreviewVersion={document.version}
          showToolbar={false}
          allowUserTabCreation={false}
          allowTabUrlCopy={false}
          enableDesktopWebActions={false}
          registerPublicWebSurface={false}
          cdpActive={false}
          publishPageContext={false}
          showLoadingProgress
          onLoadingChange={onLoadingChange}
        />
      </Suspense>
    </div>
  );
}
