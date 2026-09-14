type ParamType = "number" | "integer" | "boolean" | "string" | "object" | "array";
type Rule = { type: ParamType; required?: boolean; values?: readonly string[] };
type Rules = Record<string, Rule>;

function fields(type: ParamType, names: string): Rules {
  return Object.fromEntries(names.split(" ").map((name) => [name, { type }]));
}

// Preflight known public parameters without coercion. Chromium remains authoritative
// for version-specific parameters and constraints not described here.
const rules: Record<string, Rules> = {
  "Input.dispatchMouseEvent": {
    type: { type: "string", required: true, values: ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"] },
    x: { type: "number", required: true }, y: { type: "number", required: true },
    ...fields("integer", "clickCount buttons modifiers tiltX tiltY twist"),
    ...fields("number", "timestamp deltaX deltaY force tangentialPressure"),
    button: { type: "string", values: ["none", "left", "middle", "right", "back", "forward"] },
    pointerType: { type: "string", values: ["mouse", "pen"] }
  },
  "Input.dispatchKeyEvent": {
    type: { type: "string", required: true, values: ["keyDown", "keyUp", "rawKeyDown", "char"] },
    ...fields("integer", "modifiers windowsVirtualKeyCode nativeVirtualKeyCode location"),
    ...fields("number", "timestamp"), ...fields("boolean", "autoRepeat isKeypad isSystemKey"),
    ...fields("string", "text unmodifiedText keyIdentifier code key"), ...fields("array", "commands")
  },
  "Input.insertText": { text: { type: "string", required: true } },
  "Runtime.evaluate": {
    expression: { type: "string", required: true },
    ...fields("boolean", "includeCommandLineAPI silent returnByValue generatePreview userGesture awaitPromise throwOnSideEffect disableBreaks replMode allowUnsafeEvalBlockedByCSP"),
    ...fields("integer", "contextId"), ...fields("number", "timeout"),
    ...fields("string", "objectGroup uniqueContextId"), ...fields("object", "serializationOptions")
  },
  "Page.reload": fields("boolean", "ignoreCache"),
  "Page.navigate": { url: { type: "string", required: true }, ...fields("string", "referrer transitionType frameId referrerPolicy") },
  "Page.captureScreenshot": {
    ...fields("integer", "quality"), ...fields("boolean", "fromSurface captureBeyondViewport optimizeForSpeed"),
    ...fields("object", "clip"), format: { type: "string", values: ["jpeg", "png", "webp"] }
  },
  "DOM.getDocument": { ...fields("integer", "depth"), ...fields("boolean", "pierce") },
  "DOM.querySelector": { nodeId: { type: "integer", required: true }, selector: { type: "string", required: true } },
  "DOM.querySelectorAll": { nodeId: { type: "integer", required: true }, selector: { type: "string", required: true } },
  "DOM.getOuterHTML": { ...fields("integer", "nodeId backendNodeId"), ...fields("string", "objectId"), ...fields("boolean", "includeShadowDOM") },
  "DOM.getBoxModel": { ...fields("integer", "nodeId backendNodeId"), ...fields("string", "objectId") },
  "Network.enable": { ...fields("integer", "maxTotalBufferSize maxResourceBufferSize maxPostDataSize"), ...fields("boolean", "reportDirectSocketTraffic enableDurableMessages") }
};

export type DesktopCdpParamIssue = { path: string; expected: string; actualType: string; actualValue?: unknown };

export class DesktopCdpParamsError extends Error {
  readonly code = "invalid_args";
  readonly details: { method: string; executed: false; retryable: false; recovery: string; issues: DesktopCdpParamIssue[] };
  constructor(method: string, issues: DesktopCdpParamIssue[]) {
    const recovery = "Correct the listed parameters using native JSON types before retrying. Do not retry unchanged parameters or reload/close the page to fix an input error."
      + (method === "Input.dispatchMouseEvent" ? ' x/y accept fractional numbers; clickCount must be an integer; button="left" is valid.' : "");
    super(`${method}: ${issues.map((issue) => `${issue.path} expected ${issue.expected}, received ${issue.actualType}${issue.actualValue !== undefined ? ` (${JSON.stringify(issue.actualValue)})` : ""}`).join("; ")}. This command was not executed. ${recovery}`);
    this.details = { method, executed: false, retryable: false, recovery, issues };
  }
}

function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

export function validateDesktopCdpParams(method: string, value: unknown): asserts value is Record<string, unknown> | undefined {
  if (value === undefined) value = {};
  if (valueType(value) !== "object") {
    throw new DesktopCdpParamsError(method, [{ path: "params", expected: "object", actualType: valueType(value) }]);
  }
  const params = value as Record<string, unknown>;
  const issues: DesktopCdpParamIssue[] = [];
  const check = (path: string, rule: Rule, present: boolean, actual: unknown) => {
    if (!present && !rule.required) return;
    const valid = present && (rule.type === "integer" ? Number.isInteger(actual)
      : rule.type === "number" ? typeof actual === "number" && Number.isFinite(actual)
      : valueType(actual) === rule.type);
    if (valid && (!rule.values || rule.values.includes(actual as string))) return;
    issues.push({ path, expected: rule.values ? `${rule.type} (${rule.values.join(" | ")})` : rule.type,
      actualType: present ? valueType(actual) : "missing",
      // Never echo arbitrary expression, URL, text or nested object contents.
      ...((rule.type === "number" || rule.type === "integer" || rule.type === "boolean" || rule.values)
        && (typeof actual === "boolean" || typeof actual === "number" || typeof actual === "string" && actual.length <= 80)
        ? { actualValue: actual } : {}) });
  };
  for (const [key, rule] of Object.entries(rules[method] ?? {})) {
    check(`params.${key}`, rule, Object.hasOwn(params, key), params[key]);
  }
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
    for (const key of ["deltaX", "deltaY"]) {
      if (!Object.hasOwn(params, key)) check(`params.${key}`, { type: "number", required: true }, false, undefined);
    }
  }
  if (method === "Page.captureScreenshot" && valueType(params.clip) === "object") {
    const clip = params.clip as Record<string, unknown>;
    for (const key of ["x", "y", "width", "height", "scale"]) {
      check(`params.clip.${key}`, { type: "number", required: true }, Object.hasOwn(clip, key), clip[key]);
    }
  }
  if (issues.length) throw new DesktopCdpParamsError(method, issues);
}
