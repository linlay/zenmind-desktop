import type { SurfaceContext } from "./ipc.shared";
import { LIVE_CHAT_SURFACE_IDS, protocolError, readText } from "./ipc.shared";
import { SELECTION_EXPLAIN_SURFACE_ID } from "../../../shared/surface-identity";

const PURPOSE_KEY = "_desktopTransportPurpose";
const EXPLANATION_RUN_REQUESTS = new Set([
  "/api/btw", "/api/attach", "/api/interrupt", "/api/detach", "/api/submit", "/api/steer",
]);

/** A guest requests an explanation lane; only the trusted surface may select it. */
export function resolveSelectionExplainTransport(
  context: SurfaceContext,
  type: string,
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; lane?: "selection-explain" } {
  const hasPurpose = Object.prototype.hasOwnProperty.call(payload, PURPOSE_KEY);
  const explanationSurface = context.kind === "agent-selection-explain" &&
    context.target.surfaceRole === "selection-explain" &&
    context.target.surfaceId === SELECTION_EXPLAIN_SURFACE_ID;
  if (hasPurpose) {
    if (payload[PURPOSE_KEY] !== "selection-explain" || !EXPLANATION_RUN_REQUESTS.has(type)) {
      throw protocolError("Invalid Desktop explanation transport purpose");
    }
    if (!explanationSurface && !LIVE_CHAT_SURFACE_IDS.has(context.target.surfaceId)) {
      throw protocolError("Only a trusted Chat or explanation surface may select the explanation transport");
    }
  }
  if (!hasPurpose && (!explanationSurface || !EXPLANATION_RUN_REQUESTS.has(type))) {
    return { payload };
  }
  const ownerChatId = context.target.ownerChatId?.trim() || "";
  const chatId = readText(payload.chatId);
  if (!ownerChatId || (chatId && chatId !== ownerChatId)) {
    throw protocolError("Explanation transport requires the trusted owner Chat");
  }
  const cleanPayload = { ...payload };
  delete cleanPayload[PURPOSE_KEY];
  return { payload: cleanPayload, lane: "selection-explain" };
}
