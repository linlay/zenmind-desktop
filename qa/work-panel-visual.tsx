import React, { useCallback, useState } from "react";
import ReactDOM from "react-dom/client";
import { WorkPanelHost } from "../src/renderer/work-panel/WorkPanelHost";
import { reduceWorkPanelCommand, type WorkPanelCommand, type WorkPanelState } from "../src/shared/work-panel";
import { EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE } from "../src/shared/work-panel-review";
import "../src/renderer/styles/theme.css";
import "../src/renderer/styles/base.css";
import "../src/renderer/styles/app-shell.css";

const dispose = () => undefined;

Object.assign(window, {
  electronAPI: {
    chatWorkPanel: {
      clearSession: async () => ({ ok: true }),
      localFiles: {
        select: async () => ({ ok: false, files: [] }),
        release: async () => ({ ok: true }),
        open: async () => ({ ok: true }),
        reveal: async () => ({ ok: true }),
      },
    },
    chatWorkPanelTabContextMenu: {
      popup: async () => ({ actionId: "none" }),
      revealLocalResource: async () => ({ ok: true }),
      openLocalResource: async () => ({ ok: true }),
    },
    clipboard: { writeText: async () => undefined },
    desktopActions: { respond: async () => undefined, onCall: () => dispose },
    desktopShell: {
      setWorkPanelKeyboardFocusActive: () => undefined,
      requestWindowClose: () => undefined,
    },
    onWebviewOpenTab: () => dispose,
    onWorkPanelCloseShortcut: () => dispose,
    onWorkPanelFullscreenExitShortcut: () => dispose,
    webs: { webapps: { listOpenWindows: async () => [] } },
  },
});

const initialState: WorkPanelState = {
  workspaces: [{
    workspaceId: "visual-workspace",
    ownerChatId: "visual-chat",
    activeItemId: "review-tab",
    items: [{
      itemId: "review-tab",
      stableKey: "native:review",
      descriptor: {
        kind: "native",
        surfaceKey: "review",
        context: {},
        title: "Review",
      },
      title: "Review",
      closable: true,
      pinned: false,
      createdAt: 1,
    }],
  }],
  visibleOwnerChatIds: ["visual-chat"],
  webSessionKeysByItemId: {},
  review: EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE,
};

function WorkPanelVisualQA() {
  const [state, setState] = useState(initialState);
  const dispatchCommand = useCallback((command: WorkPanelCommand) => {
    const result = reduceWorkPanelCommand(state, command);
    setState(result.nextState);
    return result;
  }, [state]);

  return (
    <div className="work-panel-visual-shell app-shell has-chat-work-panel">
      <div className="app-content">
        <WorkPanelHost
          activeChatId="visual-chat"
          state={state}
          dispatchCommand={dispatchCommand}
          fullscreenOwnerChatId={null}
          onFullscreenChange={async () => true}
          isMac
          isWindows={false}
          launcher={{
            agentKey: "visual-agent",
            agentMode: "CODER",
            projectEnabled: true,
            lastRunId: "visual-run",
            webapps: [{ id: "visual-webapp", label: "Preview WebApp" }],
            onOpenWebapp: () => undefined,
            onFocusWebappWindow: () => undefined,
          }}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<WorkPanelVisualQA />);
