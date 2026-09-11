import type {
  EmbeddedWebInteractAction
} from "../../../shared/embedded-web-scripts";

export const EMBEDDED_WEB_SCRIPT_MAX_BYTES = 256 * 1024;
export const EMBEDDED_WEB_INTERACT_ACTIONS = new Set<EmbeddedWebInteractAction>(["click", "fill", "scroll", "focus", "select"]);

export function getUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function readActionSelector(args: Record<string, unknown>) {
  const selector = typeof args.selector === "string" ? args.selector.trim() : "";
  if (selector) {
    return selector;
  }
  return typeof args.elementSelector === "string" ? args.elementSelector.trim() : "";
}
