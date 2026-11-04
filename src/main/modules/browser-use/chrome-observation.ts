import type { BrowserObservedDialog, BrowserObservedDownload, BrowserObservedElement, BrowserObservedFileChooser, BrowserObservedOption } from "../../../shared/browser-use";
import type { ChromeWorkerObservation, ChromeWorkerPage } from "./chrome-worker-contract";

export const CHROME_OBSERVATION_MAX_BYTES = 128 * 1024;
export const CHROME_OBSERVATION_MAX_NODES = 4000;
export type ChromeObserveOptions = { depth: number; maxTextLength: number; maxElements: number; viewportOnly: boolean };
export type ChromeSnapshotNode = string | { role?: string; name?: string; ref?: string; text?: string; children?: unknown[]; [key: string]: unknown };
export type ChromeSnapshotEntry = { node: ChromeSnapshotNode; depth: number; ancestors: string[]; token: string };
export type ChromeFieldMetadata = {
  sensitive: boolean; tag?: string; value?: string; secretValue?: string; oversizedSecret?: boolean; truncated?: boolean;
  disabled?: boolean; required?: boolean; readOnly?: boolean; validationMessage?: string;
  fileCount?: number; multiple?: boolean;
  select?: { options: BrowserObservedOption[]; multiple: boolean; optionsTruncated: boolean };
};

export function chromeObserveOptions(params: Record<string, unknown>): ChromeObserveOptions {
  if (Object.keys(params).some(key => !["depth", "maxTextLength", "maxElements", "viewportOnly"].includes(key)))
    throw Object.assign(new Error("Unsupported observation parameter"), { code: "invalid_params" });
  const read = (name: string, fallback: number, max: number) => {
    const value = params[name] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
      throw Object.assign(new Error(`Invalid ${name}`), { code: "invalid_params" });
    return value;
  };
  if (params.viewportOnly !== undefined && typeof params.viewportOnly !== "boolean") throw Object.assign(new Error("viewportOnly must be a boolean"), { code: "invalid_params" });
  return { depth: read("depth", 20, 30), maxTextLength: read("maxTextLength", 30000, 30000), maxElements: read("maxElements", 500, 500), viewportOnly: params.viewportOnly === true };
}

/** Boxes belong to each frame's viewport. Do not compare child-frame coordinates to the top frame. */
export function viewportChromeSnapshot(snapshot: unknown, width: number, height: number) {
  let visited = 0, truncated = false;
  const walk = (value: unknown, depth: number, parentInside: boolean): ChromeSnapshotNode | undefined => {
    if (++visited > 100000 || depth > 30) { truncated = true; return; }
    if (typeof value === "string") { if (parentInside) return value; truncated = true; return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Exclude<ChromeSnapshotNode, string>;
    const box = node.box as { x?: number; y?: number; width?: number; height?: number } | undefined;
    const hasBox = box && [box.x, box.y, box.width, box.height].every(item => typeof item === "number" && Number.isFinite(item));
    const visible = Boolean(hasBox && box.width! > 0 && box.height! > 0 && box.x! < width && box.y! < height && box.x! + box.width! > 0 && box.y! + box.height! > 0);
    const inside = Boolean(visible && box!.x! >= 0 && box!.y! >= 0 && box!.x! + box!.width! <= width && box!.y! + box!.height! <= height);
    if (node.role === "iframe") {
      if (hasBox && !visible) { truncated = true; return; }
      // The iframe subtree remains frame-local and is bounded by the normal projection budgets.
      return node;
    }
    const children: ChromeSnapshotNode[] = [];
    if (Array.isArray(node.children)) for (let i = 0; i < node.children.length && visited <= 100000; i++) {
      const child = walk(node.children[i], depth + 1, inside || (!hasBox && parentInside));
      if (child !== undefined) children.push(child);
    }
    if (hasBox && !visible && !children.length) { truncated = true; return; }
    if (!hasBox && !parentInside && !children.length) { truncated = true; return; }
    return { ...node, ...(Array.isArray(node.children) ? { children } : {}) };
  };
  const nodes: ChromeSnapshotNode[] = [];
  if (Array.isArray(snapshot)) for (let i = 0; i < snapshot.length && visited <= 100000; i++) {
    const node = walk(snapshot[i], 0, false); if (node !== undefined) nodes.push(node);
  }
  return { nodes, truncated };
}

/** Bounds both width and depth without copying a page-controlled children array. */
export function scanChromeSnapshot(snapshot: unknown) {
  const entries: ChromeSnapshotEntry[] = [];
  let truncated = false, visited = 0;
  const stack: Array<{ nodes: unknown[]; index: number; depth: number; ancestors: string[] }> = [
    { nodes: Array.isArray(snapshot) ? snapshot : [], index: 0, depth: 0, ancestors: [] },
  ];
  while (stack.length && visited < CHROME_OBSERVATION_MAX_NODES) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.nodes.length) { stack.pop(); continue; }
    const value = frame.nodes[frame.index++]; visited++;
    if (typeof value !== "string" && (!value || typeof value !== "object" || Array.isArray(value))) continue;
    const node = value as ChromeSnapshotNode;
    if (typeof node !== "string" && node.ariaHidden === true) continue;
    const token = typeof node !== "string" && typeof node.ref === "string" ? node.ref : "node:" + visited;
    entries.push({ node, depth: frame.depth, ancestors: frame.ancestors, token });
    if (typeof node !== "string" && Array.isArray(node.children) && node.children.length) {
      if (frame.depth >= 30) { truncated = true; continue; }
      const ancestors = [...frame.ancestors, token];
      stack.push({ nodes: node.children, index: 0, depth: frame.depth + 1, ancestors });
    }
  }
  if (stack.some(frame => frame.index < frame.nodes.length)) truncated = true;
  return { entries, truncated };
}

function clip(value: string, limit: number) {
  const result = value.slice(0, Math.max(0, limit));
  return /[\uD800-\uDBFF]$/u.test(result) ? result.slice(0, -1) : result;
}

export function projectChromeObservation(input: {
  scan: ReturnType<typeof scanChromeSnapshot>; fields: Map<string, ChromeFieldMetadata>; state: ChromeWorkerPage;
  options: ChromeObserveOptions; observationId: string; dialogs?: BrowserObservedDialog[];
  fileChoosers?: BrowserObservedFileChooser[]; downloads?: BrowserObservedDownload[];
  redactions?: Iterable<string>;
}) {
  let truncated = input.scan.truncated;
  const secrets = new Set<string>();
  const sensitive = new Set<string>();
  let secretCharacters = 0;
  const addSecret = (value: string) => {
    if (secrets.has(value) || !value) return;
    if (value.length > 8192 || secretCharacters + value.length > 32768)
      throw Object.assign(new Error("Sensitive fields exceed the safe observation budget"), { code: "observation_budget_exceeded" });
    secrets.add(value); secretCharacters += value.length;
  };
  for (const secret of input.redactions ?? []) addSecret(secret);
  for (const [ref, field] of input.fields) {
    if (field.truncated) truncated = true;
    if (!field.sensitive) continue;
    sensitive.add(ref);
    if (field.oversizedSecret) throw Object.assign(new Error("Sensitive field exceeds the safe observation budget"), { code: "observation_budget_exceeded" });
    if (field.secretValue) addSecret(field.secretValue);
  }
  for (const { node, token } of input.scan.entries) {
    if (typeof node === "string") continue;
    // Non-interactable editable nodes can have no ref. Their values cannot be classified safely.
    if (!node.ref && ["textbox", "searchbox", "combobox", "listbox", "spinbutton"].includes(node.role ?? "")) { sensitive.add(token); truncated = true; }
    if (sensitive.has(token) && node.text) {
      addSecret(node.text);
    }
  }
  const redactions = [...secrets].sort((a, b) => b.length - a.length);
  const scrub = (value: unknown) => {
    if (typeof value !== "string") return "";
    // Omit pathological source strings entirely; clipping before masking could reveal a secret prefix.
    if (value.length > 200000) { truncated = true; return ""; }
    for (const secret of redactions) value = (value as string).split(secret).join("[redacted]");
    return value as string;
  };
  const bounded = (value: unknown, limit: number) => {
    const safe = scrub(value);
    if (safe.length > limit) truncated = true;
    return clip(safe, limit);
  };
  const exact = (value: unknown, limit: number): string | undefined => {
    const safe = scrub(value);
    if (safe.length > limit) { truncated = true; return; }
    return safe;
  };
  const elements: BrowserObservedElement[] = [];
  const refs = new Set<string>();
  const observation: ChromeWorkerObservation = {
    observationId: input.observationId, url: bounded(input.state.url, 4096), title: bounded(input.state.title, 512),
    text: "", elements, truncated: false,
    ...(input.options.viewportOnly ? { viewportOnly: true } : {}),
    dialogs: (input.dialogs ?? []).slice(0, 4).map(dialog => ({ ...dialog, message: bounded(dialog.message, 1000) })),
    fileChoosers: (input.fileChoosers ?? []).slice(0, 4),
    downloads: (input.downloads ?? []).slice(0, 9).map(download => ({ ...download, fileName: bounded(download.fileName, 255), ...(download.error ? { error: bounded(download.error, 200) } : {}) })),
  };
  if ((input.dialogs?.length ?? 0) > 4 || (input.fileChoosers?.length ?? 0) > 4 || (input.downloads?.length ?? 0) > 9) truncated = true;
  let remaining = CHROME_OBSERVATION_MAX_BYTES - Buffer.byteLength(JSON.stringify(observation)) - 4096;
  let optionCount = 0, optionCharacters = 24000, textLength = 0;
  const lines: string[] = [];
  for (const { node, depth, ancestors, token } of input.scan.entries) {
    if (ancestors.some(ref => sensitive.has(ref))) continue;
    if (remaining < 128) { truncated = true; break; }
    if (typeof node === "string") {
      const text = bounded(node, Math.min(4096, input.options.maxTextLength - textLength));
      if (text) appendLine(`${"  ".repeat(depth)}- text: ${text}`);
      continue;
    }
    const ref = typeof node.ref === "string" && /^(?:f\d+)?e\d+$/u.test(node.ref) ? node.ref : undefined;
    const role = bounded(node.role || "text", 80), name = bounded(node.name, 512);
    const text = sensitive.has(token) ? "[redacted]" : bounded(node.text, 4096);
    const states: Partial<BrowserObservedElement> = {};
    for (const key of ["disabled", "expanded", "selected", "active"] as const) if (typeof node[key] === "boolean") states[key] = node[key];
    for (const key of ["checked", "pressed"] as const) if (typeof node[key] === "boolean" || node[key] === "mixed") states[key] = node[key];
    if (typeof node.invalid === "boolean" || node.invalid === "grammar" || node.invalid === "spelling") states.invalid = node.invalid;
    if (typeof node.level === "number" && Number.isInteger(node.level) && node.level > 0 && node.level <= 100) states.level = node.level;
    let includedRef: string | undefined;
    if (ref && !refs.has(ref) && elements.length < input.options.maxElements) {
      const field = input.fields.get(ref);
      const element: BrowserObservedElement = { ref, role, name, tag: bounded(field?.tag, 32), ...states };
      if (typeof node.placeholder === "string") element.placeholder = bounded(node.placeholder, 512);
      if (typeof node.url === "string") {
        try { const url = new URL(node.url, input.state.url); if (/^https?:$/u.test(url.protocol) && !url.username && !url.password) element.href = exact(url.href, 2048); } catch { /* Not a navigable business link. */ }
      }
      if (field && !field.sensitive) {
        if (field.value !== undefined) element.value = exact(field.value, 2048);
        for (const key of ["disabled", "required", "readOnly"] as const) if (typeof field[key] === "boolean") element[key] = field[key];
        if (field.validationMessage) element.validationMessage = bounded(field.validationMessage, 512);
        if (field.select) {
          element.options = []; element.multiple = field.select.multiple; element.optionsTruncated = field.select.optionsTruncated;
          let optionBytes = Buffer.byteLength(JSON.stringify(element));
          for (const option of field.select.options.slice(0, 100)) {
            const label = bounded(option.label, 240), value = exact(option.value, 1000);
            if (option.label.length > label.length) element.optionsTruncated = true;
            if (value === undefined || value !== option.value) { element.optionsTruncated = true; continue; }
            const next = { label, value, selected: option.selected, disabled: option.disabled };
            const bytes = Buffer.byteLength(JSON.stringify(next)) + 1;
            if (optionCount >= 500 || label.length + value.length > optionCharacters || optionBytes + bytes + 1024 > remaining) { element.optionsTruncated = true; break; }
            element.options.push(next); optionCount++; optionCharacters -= label.length + value.length;
            optionBytes += bytes;
          }
          if (element.optionsTruncated) truncated = true;
        }
      } else if (field?.sensitive) {
        element.value = "[redacted]";
        if (typeof field.fileCount === "number" && Number.isInteger(field.fileCount) && field.fileCount >= 0) element.fileCount = Math.min(field.fileCount, 10000);
        if (typeof field.multiple === "boolean") element.multiple = field.multiple;
      }
      const bytes = Buffer.byteLength(JSON.stringify(element)) + 1;
      if (bytes <= remaining) { elements.push(element); refs.add(ref); includedRef = ref; remaining -= bytes; }
      else truncated = true;
    } else if (ref) truncated = true;
    const attributes = Object.entries(states).map(([key, value]) => ` [${key}=${value}]`).join("");
    appendLine(`${"  ".repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ""}${includedRef ? ` [ref=${includedRef}]` : ""}${attributes}${text ? `: ${text}` : ""}`);
  }
  function appendLine(line: string) {
    const available = input.options.maxTextLength - textLength - (lines.length ? 1 : 0);
    if (available <= 0) { truncated = true; return; }
    const value = clip(line, available);
    if (value.length !== line.length) truncated = true;
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 2;
    if (bytes > remaining) { truncated = true; return; }
    lines.push(value); textLength += value.length + (lines.length > 1 ? 1 : 0); remaining -= bytes;
  }
  observation.text = lines.join("\n"); observation.truncated = truncated;
  // A final invariant includes JSON escaping and every metadata field, not only visible text.
  if (Buffer.byteLength(JSON.stringify(observation)) > CHROME_OBSERVATION_MAX_BYTES)
    throw Object.assign(new Error("The observation exceeds its safe response budget"), { code: "observation_budget_exceeded" });
  return { observation, refs, secrets };
}
