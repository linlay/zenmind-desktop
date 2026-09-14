import type { DesktopClickParams } from "../../../../shared/desktop-click";

/** Serialized to Chromium. No business selectors, framework internals or synthetic input. */
function probe(p: DesktopClickParams, mode: "locate" | "verify" | "wait") {
  const visible = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Check both selectors before any click, including waitFor syntax.
  const targets = p.selector ? document.querySelectorAll(p.selector) : null;
  const candidates = p.waitFor?.selector ? document.querySelectorAll(p.waitFor.selector) : null;
  if (mode === "wait") {
    const w = p.waitFor!;
    if (w.state === "url") return { matched: location.href === w.value, url: location.href };
    if (candidates!.length > 1) return { error: "ambiguous_wait_selector" };
    const el = candidates![0];
    if (w.state === "hidden") return { matched: !el || !visible(el), visible: !!el && visible(el) };
    if (!el) return { matched: false, count: 0 };
    if (w.state === "visible") return { matched: visible(el), visible: visible(el) };
    if (w.state === "value") return { matched: (el as HTMLInputElement).value === w.value, value: (el as HTMLInputElement).value ?? null };
    const checked = typeof (el as HTMLInputElement).checked === "boolean" ? (el as HTMLInputElement).checked : el.getAttribute("aria-checked") === "true" ? true : el.getAttribute("aria-checked") === "false" ? false : null;
    return { matched: checked === w.checked, checked };
  }
  if (targets && targets.length !== 1) return { error: targets.length ? "ambiguous_selector" : "element_not_found" };
  const el = targets?.[0];
  if (el && mode === "locate") el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const r = el?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : p.x!;
  const y = r ? r.top + r.height / 2 : p.y!;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { error: "outside_viewport" };
  const hit = document.elementFromPoint(x, y);
  if (!hit || el && (!visible(el) || !(hit === el || el.contains(hit)))) return { error: "element_obscured" };
  if ((el ?? hit).closest(':disabled, [aria-disabled="true"], [inert]')) return { error: "element_disabled" };
  return { x, y, tag: hit.tagName, matched: true };
}

export function clickProbeExpression(params: DesktopClickParams, mode: "locate" | "verify" | "wait") {
  return `(${probe.toString()})(${JSON.stringify(params)},${JSON.stringify(mode)})`;
}
