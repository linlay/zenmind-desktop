import { contextBridge, ipcRenderer } from "electron";
import { WORK_PANEL_PAGE_DIALOG_CHANNEL, type WorkPanelPageDialogReply, type WorkPanelPageDialogRequest } from "../shared/work-panel-page-dialog";

/** Serialized into the main world; only the fixed synchronous function crosses isolation. */
export function installWorkPanelPageDialogWrappers(invoke: (request: WorkPanelPageDialogRequest) => WorkPanelPageDialogReply) {
  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  let cancelledThisTask = false;
  const ask = (type: "alert" | "confirm" | "prompt", message: string, defaultValue?: string): WorkPanelPageDialogReply => {
    if (cancelledThisTask) return { handled: true, accepted: false, cancelled: true };
    let reply: WorkPanelPageDialogReply;
    try { reply = invoke({ op: "dialog", type, message, ...(defaultValue !== undefined ? { defaultValue } : {}) }); }
    catch { reply = { handled: true, accepted: false, cancelled: true }; }
    if (reply.handled && reply.cancelled) {
      // A cancelled synchronous continuation must not create a native alert after Main released it.
      cancelledThisTask = true;
      queueMicrotask(() => { cancelledThisTask = false; });
    }
    return reply;
  };
  window.alert = function(message?: unknown) {
    const text = arguments.length ? String(message) : "";
    const reply = ask("alert", text);
    if (!reply.handled) native.alert.call(window, text);
  };
  window.confirm = function(message?: string) {
    const text = arguments.length ? String(message) : "";
    const reply = ask("confirm", text);
    return reply.handled ? reply.accepted : native.confirm.call(window, text);
  };
  window.prompt = function(message?: string, defaultValue?: string) {
    const text = arguments.length ? String(message) : "", defaultText = arguments.length > 1 ? String(defaultValue) : "";
    const reply = ask("prompt", text, defaultText);
    return reply.handled ? (reply.accepted ? reply.promptText ?? "" : null) : native.prompt.call(window, text, defaultText);
  };
}

export function installWorkPanelPageDialogs() {
  // Sandboxed preload process metadata can omit isMainFrame; the DOM and Main IPC both verify the top frame.
  if (window.top !== window || process.isMainFrame === false || !["http:", "https:"].includes(location.protocol)) return;
  contextBridge.executeInMainWorld({
    func: installWorkPanelPageDialogWrappers,
    args: [(request: WorkPanelPageDialogRequest) => ipcRenderer.sendSync(WORK_PANEL_PAGE_DIALOG_CHANNEL, request)],
  });
  ipcRenderer.send(WORK_PANEL_PAGE_DIALOG_CHANNEL, { op: "ready" });
}
