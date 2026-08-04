import type {
  EmbeddedWebInteractAction,
  EmbeddedWebReadInclude,
  EmbeddedWebStructuredTarget
} from "../../../shared/embedded-web-scripts";

export const EMBEDDED_WEB_SCRIPT_MAX_BYTES = 256 * 1024;
export const EMBEDDED_WEB_READ_INCLUDES = new Set<EmbeddedWebReadInclude>(["forms", "links", "images"]);
export const EMBEDDED_WEB_STRUCTURED_TARGETS = new Set<EmbeddedWebStructuredTarget>(["tables", "lists", "forms", "links"]);
export const EMBEDDED_WEB_INTERACT_ACTIONS = new Set<EmbeddedWebInteractAction>(["click", "fill", "scroll", "focus", "select"]);

const READ_PAGE_DATA_SUMMARY_KEYS = ["url", "title", "selectedText", "metaDescription", "headings", "bodyText"];

export function getUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function readAllowedValues<T extends string>(
  value: unknown,
  allowedValues: Set<T>
) {
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return rawValues
    .map((item) => String(item).trim())
    .filter((item): item is T => allowedValues.has(item as T));
}

export function filterReadPageDataResult(result: unknown, includes: EmbeddedWebReadInclude[]) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const source = result as Record<string, unknown>;
  const keys = [
    ...READ_PAGE_DATA_SUMMARY_KEYS,
    ...includes,
    ...(includes.includes("forms") ? ["fields"] : [])
  ];
  const filtered: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      filtered[key] = source[key];
    }
  }
  return filtered;
}

export function readActionSelector(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector.trim() : "";
  if (selector) {
    return selector;
  }
  return typeof args.elementSelector === "string" ? args.elementSelector.trim() : "";
}

export function filterStructuredResult(result: unknown, targets: EmbeddedWebStructuredTarget[]) {
  if (!result || typeof result !== "object" || targets.length === 0) {
    return result;
  }
  const filtered = { ...(result as Record<string, unknown>) };
  const keys: EmbeddedWebStructuredTarget[] = ["tables", "lists", "forms", "links"];
  for (const key of keys) {
    if (!targets.includes(key)) {
      delete filtered[key];
    }
  }
  return filtered;
}
