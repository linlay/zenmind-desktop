import type { WebContents } from "electron";
import type { DesktopClickParams, DesktopClickResult } from "../../../../shared/desktop-click";
import { clickProbeExpression } from "./click-probe";

type Send = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;

/** One input transaction, not a rollback transaction. Never retries a press. */
export async function executeClick(p: DesktopClickParams, contents: WebContents, send: Send,
  validate: () => Promise<void>, signal?: AbortSignal): Promise<DesktopClickResult> {
  const start = Date.now(), deadline = start + (p.timeoutMs ?? 3000);
  let navigation = false, attempted = false, releaseAttempted = false;
  let point: { x: number; y: number } | undefined;
  const result: DesktopClickResult = { status: "failed", stage: "locate",
    action: { pressed: false, released: false, outcome: "not_started" }, conditionMatched: p.waitFor ? false : null,
    timingsMs: { locate: 0, click: 0, wait: 0, total: 0 } };
  const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) navigation = true; };
  contents.on("did-start-navigation", onNavigation);
  const check = async () => {
    if (signal?.aborted) throw new Error("canceled");
    if (Date.now() >= deadline) throw new Error("timeout");
    if (contents.isDestroyed()) throw new Error("target_closed");
    await validate();
    if (navigation) throw new Error("navigation");
  };
  const evaluate = async (mode: "locate" | "verify" | "wait") => {
    await check();
    const response = await send("Runtime.evaluate", { expression: clickProbeExpression(p, mode), returnByValue: true }, Math.max(1, deadline - Date.now()));
    if (response.exceptionDetails) throw new Error("page_evaluation_failed");
    const value = response.result?.value;
    if (!value || typeof value !== "object") throw new Error("invalid_probe_result");
    if (value.error) throw new Error(value.error);
    return value;
  };
  const pause = () => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, Math.min(50, Math.max(1, deadline - Date.now())));
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
  try {
    let previous = await evaluate("locate");
    let rescrolled = false;
    // Layout must settle before dispatch. Coordinates are never rounded or DPI scaled.
    for (;;) {
      await pause();
      let current;
      try { current = await evaluate("verify"); }
      catch (error) {
        // A viewport resize/zoom can finish after scrollIntoView. Reposition once, before any input.
        if (p.selector && !rescrolled && error instanceof Error && error.message === "outside_viewport") {
          rescrolled = true;
          previous = await evaluate("locate");
          continue;
        }
        throw error;
      }
      if (typeof current.x !== "number" || typeof current.y !== "number") throw new Error("invalid_probe_result");
      if (current.x === previous.x && current.y === previous.y) { point = { x: current.x, y: current.y }; result.evidence = current; break; }
      previous = current;
    }
    result.timingsMs.locate = Date.now() - start;
    result.stage = "click";
    await check();
    const mouse = { ...point, button: "left", clickCount: 1 };
    const clickStart = Date.now();
    attempted = true;
    result.action.outcome = "unknown";
    await send("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" }, Math.max(1, deadline - Date.now()));
    result.action.pressed = true;
    // Always release on the original guest, including cancellation or navigation after press.
    releaseAttempted = true;
    await send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" }, 1000);
    result.action.released = true;
    result.action.outcome = "complete";
    result.timingsMs.click = Date.now() - clickStart;
    result.stage = "observe";
    if (signal?.aborted) throw new Error("canceled");
    if (!p.waitFor) { result.status = "clicked"; return result; }
    const waitStart = Date.now();
    try {
      for (;;) {
        // URL-only observation can finish across a navigation, but never runs scripts in the new page.
        if (p.waitFor.state === "url") {
          if (signal?.aborted) throw new Error("canceled");
          if (contents.isDestroyed()) throw new Error("target_closed");
          await validate();
          const url = contents.getURL();
          result.evidence = { url };
          if (url === p.waitFor.value) { result.conditionMatched = true; break; }
          if (Date.now() >= deadline) throw new Error("timeout");
        } else {
          const observation = await evaluate("wait");
          result.evidence = observation;
          if (observation.matched === true) { result.conditionMatched = true; break; }
        }
        await pause();
      }
      result.status = "condition_met";
    } finally { result.timingsMs.wait = Date.now() - waitStart; }
  } catch (error) {
    const message = error instanceof Error ? error.message : "click_failed";
    result.status = message === "canceled" || message === "timeout" || message === "navigation" ? message : "failed";
    result.error = message;
  } finally {
    // A press timeout has unknown effects. Best-effort release once; never repeat a press/release that was already sent.
    if (attempted && !releaseAttempted && point && !contents.isDestroyed()) {
      try {
        await send("Input.dispatchMouseEvent", { ...point, type: "mouseReleased", button: "left", clickCount: 1 }, 1000);
        result.action.released = true;
      } catch { /* outcome remains unknown */ }
    }
    contents.removeListener("did-start-navigation", onNavigation);
    result.timingsMs.total = Date.now() - start;
  }
  return result;
}
