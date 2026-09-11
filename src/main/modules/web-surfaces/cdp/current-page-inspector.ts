import { webContents } from "electron";
import type { DesktopPageContextSnapshot } from "../../../../shared/contracts";
import { sendDesktopCdpCommand } from "./debugger";

type CdpTraceEntry = {
  method: string;
  params?: Record<string, unknown>;
};

export type CurrentPageCdpElementSnapshot = {
  selector: string;
  tagName: string;
  text: string;
  ariaLabel: string;
  title: string;
  value: string;
  role: string;
  type: string;
  name: string;
  id: string;
  className: string;
  href: string;
};

const CDP_PROTOCOL_VERSION = "1.3";

function readActionSelector(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector.trim() : "";
  if (selector) {
    return selector;
  }
  return typeof args.elementSelector === "string" ? args.elementSelector.trim() : "";
}

function readSnapshotDebugUrl(snapshot: DesktopPageContextSnapshot) {
  return snapshot.pageContext?.browserTarget?.currentUrl || snapshot.pageContext?.url || "";
}

function readSnapshotDebugTitle(snapshot: DesktopPageContextSnapshot) {
  return snapshot.pageContext?.title || snapshot.surfaceLabel || snapshot.pageKey;
}

async function withDebugger<T>(
  snapshot: DesktopPageContextSnapshot,
  trace: CdpTraceEntry[],
  callback: (sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>
) {
  if (typeof snapshot.webContentsId !== "number") {
    throw new Error("webContentsId is required for webview CDP inspection.");
  }
  const contents = webContents.fromId(snapshot.webContentsId);
  if (!contents || contents.isDestroyed()) {
    throw new Error("CDP target webContents is unavailable.");
  }
  const debuggerRef = contents.debugger;
  const ownsAttach = !debuggerRef.isAttached();
  if (ownsAttach) {
    debuggerRef.attach(CDP_PROTOCOL_VERSION);
  }
  try {
    return await callback(async (method, params = {}) => {
      trace.push({ method, params });
      return sendDesktopCdpCommand(debuggerRef, method, params, {
        surfaceId: snapshot.surfaceId || snapshot.pageContext?.browserTarget?.surfaceId,
        webContentsId: snapshot.webContentsId,
        url: readSnapshotDebugUrl(snapshot),
        title: readSnapshotDebugTitle(snapshot)
      });
    });
  } finally {
    if (ownsAttach && debuggerRef.isAttached()) {
      try {
        debuggerRef.detach();
      } catch {
        // The target may have navigated or closed during inspection.
      }
    }
  }
}

async function evaluate(
  snapshot: DesktopPageContextSnapshot,
  trace: CdpTraceEntry[],
  expression: string
) {
  return withDebugger(snapshot, trace, async (sendCommand) => {
    const response = await sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }) as { result?: { value?: unknown } };
    return response.result?.value;
  });
}

function readStringRecordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? item : "";
}

export async function readCurrentPageCdpLocation(snapshot: DesktopPageContextSnapshot) {
  const trace: CdpTraceEntry[] = [];
  const value = await evaluate(snapshot, trace, "window.location.href");
  return typeof value === "string" ? value : "";
}

export async function inspectCurrentPageCdpElement(
  snapshot: DesktopPageContextSnapshot,
  args: Record<string, unknown>
): Promise<CurrentPageCdpElementSnapshot | null> {
  const selector = readActionSelector(args);
  if (!selector) {
    return null;
  }
  const trace: CdpTraceEntry[] = [];
  const data = await evaluate(snapshot, trace, `(() => {
    const selector = ${JSON.stringify(selector)};
    let element = null;
    try {
      element = document.querySelector(selector);
    } catch {
      return null;
    }
    if (!element) {
      return null;
    }
    const readAttribute = (name) => element.getAttribute(name) || "";
    const normalize = (value) => String(value || "").replace(/\\s+/gu, " ").trim();
    return {
      selector,
      tagName: normalize(element.tagName).toLowerCase(),
      text: normalize(element.innerText || element.textContent || ""),
      ariaLabel: normalize(readAttribute("aria-label")),
      title: normalize(readAttribute("title")),
      value: normalize(element.value || readAttribute("value")),
      role: normalize(readAttribute("role")),
      type: normalize(readAttribute("type")).toLowerCase(),
      name: normalize(readAttribute("name")),
      id: normalize(element.id || readAttribute("id")),
      className: normalize(typeof element.className === "string" ? element.className : ""),
      href: normalize(element.href || readAttribute("href"))
    };
  })()`);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  return {
    selector,
    tagName: readStringRecordValue(data, "tagName"),
    text: readStringRecordValue(data, "text"),
    ariaLabel: readStringRecordValue(data, "ariaLabel"),
    title: readStringRecordValue(data, "title"),
    value: readStringRecordValue(data, "value"),
    role: readStringRecordValue(data, "role"),
    type: readStringRecordValue(data, "type"),
    name: readStringRecordValue(data, "name"),
    id: readStringRecordValue(data, "id"),
    className: readStringRecordValue(data, "className"),
    href: readStringRecordValue(data, "href")
  };
}
