/** Fixed, dialog-only transport. The page never supplies a channel, guest, scope, script or path. */
export const WORK_PANEL_PAGE_DIALOG_CHANNEL = "workPanel.pageDialog";
export type WorkPanelPageDialogType = "alert" | "confirm" | "prompt";
export type WorkPanelPageDialogRequest = { op: "dialog"; type: WorkPanelPageDialogType; message: string; defaultValue?: string } | { op: "ready" };
export type WorkPanelPageDialogReply = { handled: false } | { handled: true; accepted: boolean; promptText?: string; cancelled?: boolean };
