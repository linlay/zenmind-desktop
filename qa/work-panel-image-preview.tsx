import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../src/renderer/i18n/I18nProvider";
import { WorkPanelResourceImage } from "../src/renderer/work-panel/WorkPanelResourceImage";
import type {
  WorkPanelResourceImageAiRequest,
  WorkPanelResourceImageAiResult,
  WorkPanelResourceImageSelection,
} from "../src/shared/work-panel-resource-image";
import "../src/renderer/styles.css";

const resource: WorkPanelResourceImageSelection = {
  handleId: "handle-1",
  profile: "artifact",
  agentKey: "agent",
  chatId: "chat",
  resourceId: "resource",
  relativePath: "images/trae-annual-2025.png",
  fileName: "trae-annual-2025.png",
  mimeType: "image/png",
  sizeBytes: 730340,
  revision: "revision-1",
  localOriginal: true,
  editable: true,
};

const base64: string = (window as any).__IMAGE_BASE64__ || "";
const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

const settings = { locale: "zh-CN", source: "default" };

// 保留请求记录，允许回归用例配置成功或失败响应。
const fixture = {
  setEditing: (_editing: boolean) => undefined as void,
  aiRequests: [] as WorkPanelResourceImageAiRequest[],
  aiResponse: { ok: false, message: "mock" } as Omit<WorkPanelResourceImageAiResult, "requestId">,
};
(window as any).fixture = fixture;

(window as any).electronAPI = {
  settings: {
    getInitialLocale: () => settings,
    getLocale: async () => settings,
    onLocaleChanged: () => () => undefined,
  },
  chatWorkPanel: {
    resourceImages: {
      read: async () => ({ ok: true, data: bytes, revision: "revision-1", displayMimeType: "image/png" }),
      onChanged: () => () => undefined,
      claim: async () => ({ ok: true }),
      release: async () => ({ ok: true }),
      reveal: async () => ({ ok: true }),
      saveCopy: async () => ({ ok: true }),
      openExternal: async () => ({ ok: true }),
      ai: async (request: WorkPanelResourceImageAiRequest) => {
        fixture.aiRequests.push(request);
        return { ...fixture.aiResponse, requestId: request.requestId };
      },
      cancelAi: async () => ({ ok: true }),
      commit: async () => ({ ok: true, resource }),
    },
  },
};

function Scene() {
  const [editing, setEditing] = useState(false);
  fixture.setEditing = setEditing;
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <I18nProvider>
        <WorkPanelResourceImage
          active
          editing={editing}
          ownerChatId="chat"
          itemId="item"
          rendererGeneration="generation"
          resource={resource}
          onEditingChange={setEditing}
          onCommitted={() => undefined}
          onHandoff={async () => true}
        />
      </I18nProvider>
    </div>
  );
}

window.addEventListener("wheel", (event) => {
  (window as any).__wheelDelta = event.deltaY;
}, true);

document.body.style.margin = "0";
const root = document.createElement("div");
root.style.cssText = "position:fixed;inset:0;display:flex;height:100vh";
document.body.appendChild(root);
createRoot(root).render(<Scene />);
