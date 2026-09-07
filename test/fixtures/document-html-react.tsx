import { createRoot } from "react-dom/client";
import { WorkPanelDocumentHtml } from "../../src/renderer/work-panel/WorkPanelDocumentHtml";
import type { WorkPanelDocumentHtmlSelection } from "../../src/shared/work-panel-document-html";

Object.assign(window, {
  mountHtmlReview(document: WorkPanelDocumentHtmlSelection, preloadUrl: string) {
    const host = window.document.createElement("div");
    host.id = "react-preview-host";
    host.style.cssText = "position:fixed;inset:0";
    window.document.body.appendChild(host);
    createRoot(host).render(<WorkPanelDocumentHtml
      ownerChatId="test-chat"
      rendererGeneration="test-generation"
      document={document}
      active
      preloadUrl={preloadUrl}
      onHandoff={async (annotations) => { Object.assign(window, { testHandoff: annotations }); return true; }}
    />);
  },
});
