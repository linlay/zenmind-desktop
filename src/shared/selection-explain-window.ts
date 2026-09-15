export const SELECTION_EXPLAIN_WINDOW_VERSION = 1 as const;
export const SELECTION_EXPLAIN_WINDOW_GET_STATE_CHANNEL =
  "selectionExplain.getState";
export const SELECTION_EXPLAIN_WINDOW_STATE_CHANNEL =
  "selectionExplain.state";
export const SELECTION_EXPLAIN_WINDOW_MINIMIZE_CHANNEL =
  "selectionExplain.minimize";
export const SELECTION_EXPLAIN_WINDOW_CLOSE_CHANNEL =
  "selectionExplain.close";

export type SelectionExplainWindowState =
  | {
      version: typeof SELECTION_EXPLAIN_WINDOW_VERSION;
      requestId: string;
      status: "pending";
    }
  | {
      version: typeof SELECTION_EXPLAIN_WINDOW_VERSION;
      requestId: string;
      status: "ready";
      chatId: string;
      runId: string;
    }
  | {
      version: typeof SELECTION_EXPLAIN_WINDOW_VERSION;
      requestId: string;
      status: "error";
      code: string;
    };

export type SelectionExplainWindowStateListener = (
  state: SelectionExplainWindowState,
) => void;
