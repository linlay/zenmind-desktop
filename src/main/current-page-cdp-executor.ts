import { webContents } from "electron";
import type { DesktopPageContextSnapshot } from "../shared/contracts";
import type { DesktopActionCallRequest, DesktopActionCallResponse } from "../shared/desktop-actions";
import {
  EXTRACT_STRUCTURED_SCRIPT,
  READ_PAGE_DATA_SCRIPT,
  buildFillFormScript,
  buildInteractElementScript,
  buildSubmitFormScript,
  type EmbeddedWebFormFieldInput,
  type EmbeddedWebInteractAction,
  type EmbeddedWebReadInclude,
  type EmbeddedWebStructuredTarget
} from "../shared/embedded-web-scripts";

type CdpTraceEntry = {
  method: string;
  params?: Record<string, unknown>;
};

const CDP_PROTOCOL_VERSION = "1.3";
const READ_INCLUDES = new Set<EmbeddedWebReadInclude>(["forms", "links", "images"]);
const STRUCTURED_TARGETS = new Set<EmbeddedWebStructuredTarget>(["tables", "lists", "forms", "links"]);
const INTERACT_ACTIONS = new Set<EmbeddedWebInteractAction>(["click", "fill", "scroll", "focus", "select"]);

function fail(action: string, code: string, message: string, details?: unknown): DesktopActionCallResponse {
  return {
    ok: false,
    action,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

function descriptorResult(snapshot: DesktopPageContextSnapshot, payload: Record<string, unknown>) {
  return {
    source: "desktop",
    route: snapshot.route,
    pageKey: snapshot.pageKey,
    pageKind: snapshot.pageKind,
    ...(snapshot.surfaceId ? { surfaceId: snapshot.surfaceId } : {}),
    ...(snapshot.surfaceLabel ? { surfaceLabel: snapshot.surfaceLabel } : {}),
    ...(typeof snapshot.webContentsId === "number" ? { webContentsId: snapshot.webContentsId } : {}),
    ...(snapshot.frameMatchUrl ? { frameMatchUrl: snapshot.frameMatchUrl } : {}),
    ...payload
  };
}

function readAllowedValues<T extends string>(value: unknown, allowedValues: Set<T>) {
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return rawValues
    .map((item) => String(item).trim())
    .filter((item): item is T => allowedValues.has(item as T));
}

function filterRecord(result: unknown, keysToKeep: string[]) {
  if (!result || typeof result !== "object" || keysToKeep.length === 0) {
    return result;
  }
  const filtered = { ...(result as Record<string, unknown>) };
  for (const key of Object.keys(filtered)) {
    if (
      ["forms", "fields", "links", "images", "tables", "lists"].includes(key) &&
      !keysToKeep.includes(key)
    ) {
      delete filtered[key];
    }
  }
  return filtered;
}

function readFields(value: unknown): EmbeddedWebFormFieldInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const node = item as Record<string, unknown>;
      const selector = typeof node.selector === "string" ? node.selector.trim() : "";
      if (!selector) {
        return null;
      }
      const action = typeof node.action === "string" ? node.action.trim() : "";
      return {
        selector,
        ...(node.value == null ? {} : { value: String(node.value) }),
        ...(action === "fill" || action === "select" || action === "click" ? { action } : {})
      };
    })
    .filter((item): item is EmbeddedWebFormFieldInput => Boolean(item));
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDebugger<T>(
  snapshot: DesktopPageContextSnapshot,
  trace: CdpTraceEntry[],
  callback: (sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>
) {
  if (snapshot.pageKind === "iframe") {
    throw new Error("execution_context_not_ready: iframe CDP execution context resolution is not available yet.");
  }
  if (typeof snapshot.webContentsId !== "number") {
    throw new Error("webContentsId is required for webview CDP execution.");
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
      return debuggerRef.sendCommand(method, params);
    });
  } finally {
    if (ownsAttach && debuggerRef.isAttached()) {
      try {
        debuggerRef.detach();
      } catch {
        // The target may have navigated or closed after a mutating operation.
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

function pageContextFromReadData(data: unknown) {
  const node = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    url: typeof node.url === "string" ? node.url : "",
    title: typeof node.title === "string" ? node.title : "",
    selectedText: typeof node.selectedText === "string" ? node.selectedText : "",
    metaDescription: typeof node.metaDescription === "string" ? node.metaDescription : "",
    headings: Array.isArray(node.headings) ? node.headings.filter((item): item is string => typeof item === "string") : [],
    bodyText: typeof node.bodyText === "string" ? node.bodyText : ""
  };
}

export async function executeCurrentPageCdpAction(
  snapshot: DesktopPageContextSnapshot | null,
  request: DesktopActionCallRequest
): Promise<DesktopActionCallResponse | null> {
  if (!snapshot || snapshot.pageKind === "native" || !request.action.startsWith("desktop.page.")) {
    return null;
  }

  const action = request.action;
  const args = request.args ?? {};
  const trace: CdpTraceEntry[] = [];
  try {
    if (snapshot.pageKind === "iframe") {
      return fail(action, "execution_context_not_ready", "当前 iframe 暂未建立可用的 CDP execution context。", {
        pageKey: snapshot.pageKey,
        frameMatchUrl: snapshot.frameMatchUrl
      });
    }
    if (action === "desktop.page.readCurrent") {
      const data = await evaluate(snapshot, trace, READ_PAGE_DATA_SCRIPT);
      const include = readAllowedValues(args.include, READ_INCLUDES);
      const keys = include.length > 0 ? ["url", "title", "selectedText", "metaDescription", "headings", "bodyText", ...include, ...(include.includes("forms") ? ["fields"] : [])] : [];
      return {
        ok: true,
        action,
        result: descriptorResult(snapshot, {
          realtime: true,
          readAt: new Date().toISOString(),
          pageContext: pageContextFromReadData(data),
          data: filterRecord(data, keys),
          cdp: { gateway: "embedded", trace }
        })
      };
    }
    if (action === "desktop.page.extractStructured") {
      const data = await evaluate(snapshot, trace, EXTRACT_STRUCTURED_SCRIPT);
      const targets = readAllowedValues(args.targets, STRUCTURED_TARGETS);
      return {
        ok: true,
        action,
        result: descriptorResult(snapshot, {
          realtime: true,
          readAt: new Date().toISOString(),
          data: filterRecord(data, targets),
          cdp: { gateway: "embedded", trace }
        })
      };
    }
    if (action === "desktop.page.interact") {
      const selector = typeof args.selector === "string" ? args.selector.trim() : "";
      const interactAction = typeof args.action === "string" ? args.action.trim() : "";
      if (!selector || !INTERACT_ACTIONS.has(interactAction as EmbeddedWebInteractAction)) {
        return fail(action, "invalid_args", "selector 和有效的 action 是必填项。", args);
      }
      const outcome = await evaluate(snapshot, trace, buildInteractElementScript({
        selector,
        action: interactAction as EmbeddedWebInteractAction,
        value: args.value == null ? undefined : String(args.value)
      }));
      await delay(150);
      return {
        ok: true,
        action,
        result: descriptorResult(snapshot, {
          interacted: true,
          action: interactAction,
          outcome,
          cdp: { gateway: "embedded", trace }
        })
      };
    }
    if (action === "desktop.page.fillForm") {
      const fields = readFields(args.fields);
      if (fields.length === 0) {
        return fail(action, "invalid_args", "fields 是必填项，且每个字段都需要 selector。", args);
      }
      const outcome = await evaluate(snapshot, trace, buildFillFormScript({
        formSelector: typeof args.formSelector === "string" ? args.formSelector.trim() : undefined,
        fields
      }));
      await delay(150);
      return {
        ok: true,
        action,
        result: descriptorResult(snapshot, {
          filled: true,
          outcome,
          cdp: { gateway: "embedded", trace }
        })
      };
    }
    if (action === "desktop.page.submitForm") {
      const outcome = await evaluate(snapshot, trace, buildSubmitFormScript({
        formSelector: typeof args.formSelector === "string" ? args.formSelector.trim() : undefined,
        submitSelector: typeof args.submitSelector === "string" ? args.submitSelector.trim() : undefined
      }));
      await delay(250);
      return {
        ok: true,
        action,
        result: descriptorResult(snapshot, {
          submitted: true,
          outcome,
          cdp: { gateway: "embedded", trace }
        })
      };
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith("execution_context_not_ready") ? "execution_context_not_ready" : "cdp_action_failed";
    return fail(action, code, message, {
      pageKey: snapshot.pageKey,
      pageKind: snapshot.pageKind,
      trace
    });
  }
}
