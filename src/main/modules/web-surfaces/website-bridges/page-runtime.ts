import type { WebsiteBridgeMatchRule } from "../../../../shared/website-bridge";

export type WebsiteBridgeRuntimePage = { id: string; name?: string; description?: string; match?: WebsiteBridgeMatchRule[]; shared: string[] };
export type WebsiteBridgeRuntimeConfig = {
  id: string;
  version: string;
  site: { name: string; description: string };
  origins: Record<string, string>;
  originKey: string;
  origin: string;
  pathname: string;
  params: Record<string, string>;
  revision: string;
  /** The candidate pages of this URL shape, in manifest order. */
  pages: WebsiteBridgeRuntimePage[];
};
type Setup = (context: unknown) => unknown;

/**
 * Serialized into the page main world. Keep all runtime dependencies inside this function.
 * It owns the AWCP v1 protocol and page recognition; a page script only declares business actions.
 */
export function installWebsiteBridgeRuntime(config: WebsiteBridgeRuntimeConfig, modules: Array<{ name: string; setup: Setup }>, pageSetups: Array<{ id: string; setup: Setup }>) {
  type Schema = {
    type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[];
    minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; uniqueItems?: boolean;
  };
  type Action = { title: string; description: string; inputSchema: Schema; run(args: Record<string, unknown>, signal: AbortSignal): unknown };
  type Actions = Record<string, Action>;
  type Request = { requestId: string; revision: string; action: string; args: Record<string, unknown> };
  type Api = { protocolVersion: number; manual(request?: Record<string, unknown>): unknown; invoke(request: Request): Promise<unknown>; cancel(id: string): boolean };
  type FieldError = { path: (string | number)[]; messages: string[] };
  type Choice = { page: WebsiteBridgeRuntimePage | null; via: string | null; status: "url" | "matched" | "unmatched" | "ambiguous"; candidates: string[] };
  type Active = { page: WebsiteBridgeRuntimePage; actions: Actions | (() => Actions); controller: AbortController; disposers: Array<() => void> };
  const key = "__zenmindWebsiteBridge";
  const root = globalThis as typeof globalThis & { awcp?: Api } & Record<typeof key, { revision: string; dispose(): void } | undefined>;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
  const pending = new Map<string, { cancel(): void }>();
  // Never evict completed IDs and accidentally replay a write in this document.
  const seen = new Set<string>();
  let disposed = false;
  let api: Api | undefined;
  let active: Active | null = null;
  let choice: Choice = { page: null, via: null, status: "unmatched", candidates: [] };
  let failure: { id: string; message: string } | null = null;
  const setups = new Map(pageSetups.map(entry => [entry.id, entry.setup]));
  const sharedSetups = new Map(modules.map(entry => [entry.name, entry.setup]));
  const cleanup = (disposers: Array<() => void>) => {
    for (const run of disposers.reverse()) {
      try { run(); } catch { /* A faulty cleanup must not block the next page bridge. */ }
    }
  };
  /** Leaving a page cancels its in-flight requests and stops everything its scripts started. */
  function deactivate() {
    if (!active) return;
    const previous = active; active = null;
    for (const entry of [...pending.values()]) entry.cancel();
    pending.clear();
    previous.controller.abort();
    cleanup(previous.disposers);
  }
  const listeners: Array<[string, () => void]> = [];
  const state = { revision: config.revision, dispose() {
    if (disposed) return;
    disposed = true;
    deactivate();
    window.removeEventListener("pagehide", state.dispose);
    for (const [type, listener] of listeners) window.removeEventListener(type, listener);
    if (api && root.awcp === api) delete root.awcp;
    if (root[key] === state) delete root[key];
  } };

  // Packages name origins by key and write root-relative paths; this is the only place they become URLs.
  function resolve(path: string, originKey: string = config.originKey) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new TypeError("Bridge paths must be root-relative.");
    if (typeof originKey !== "string" || !Object.hasOwn(config.origins, originKey)) throw new TypeError("Unknown bridge origin key.");
    const base = config.origins[originKey];
    const url = new URL(path, base);
    if (url.origin !== base) throw new TypeError("Bridge paths must stay on the declared origin.");
    return url.href;
  }
  const base = {
    bridge: Object.freeze({ id: config.id, version: config.version }),
    originKey: config.originKey, origin: config.origin, pathname: config.pathname, params: Object.freeze({ ...config.params }),
    revision: config.revision, resolve,
  };

  // Recognition reads only the URL hash, the document title and visible text, compared exactly.
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
  function hashQuery() {
    const hash = location.hash.replace(/^#/, "");
    const at = hash.indexOf("?");
    return new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
  }
  function textVisible(value: string) {
    const body = document.body;
    if (!body) return false;
    const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    const checked = new Set<Element>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || checked.has(element) || ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(element.tagName)) continue;
      checked.add(element);
      const own = collapse([...element.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent ?? "").join(""));
      if (own === value && shown(element)) return true;
    }
    return false;
  }
  /** Hidden regions never identify a page: the element and every ancestor must render, be exposed and be opaque. */
  function shown(element: Element) {
    if (!element.getClientRects().length) return false;
    const check = (element as Element & { checkVisibility?(options: object): boolean }).checkVisibility;
    if (typeof check === "function" && !check.call(element, { checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((node as HTMLElement).hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  function hits(rule: WebsiteBridgeMatchRule) {
    try {
      if (rule.hashQuery) {
        const query = hashQuery();
        if (Object.entries(rule.hashQuery).some(([name, value]) => { const values = query.getAll(name); return values.length !== 1 || values[0] !== value; })) return false;
      }
      if (rule.title !== undefined && collapse(document.title) !== rule.title) return false;
      if (rule.text !== undefined && !textVisible(rule.text)) return false;
      return true;
    } catch { return false; }
  }
  /** Exactly one conditional page must match; otherwise the unconditional page of this URL shape, if any, serves it. */
  function choose(): Choice {
    const conditional = config.pages.filter(page => page.match);
    const fallback = config.pages.find(page => !page.match) ?? null;
    if (!conditional.length) return { page: fallback, via: null, status: "url", candidates: [] };
    const matched = conditional.flatMap(page => {
      const rule = page.match!.find(hits);
      return rule ? [{ page, via: Object.keys(rule).sort().join("+") }] : [];
    });
    if (matched.length === 1) return { ...matched[0], status: "matched", candidates: [] };
    return { page: fallback, via: null, status: matched.length ? "ambiguous" : "unmatched", candidates: matched.map(item => item.page.id) };
  }
  function load(name: string, setup: Setup, context: unknown, disposers: Array<() => void>) {
    const definition = setup.call(window, context);
    if (object(definition) && typeof definition.then === "function") throw new Error(`Bridge script "${name}" must be synchronous.`);
    if (object(definition) && typeof definition.dispose === "function") disposers.push(() => (definition.dispose as () => void)());
    return definition;
  }
  /** Each selection gets fresh module instances; modules of one page share them, and nothing crosses to another page. */
  function activate(page: WebsiteBridgeRuntimePage, via: string | null) {
    const controller = new AbortController();
    const disposers: Array<() => void> = [];
    // `via` follows recognition: the same page can stay selected while its matching rule changes (e.g. bizkey, then title).
    const identity = Object.freeze({ id: page.id, name: page.name ?? page.id, get via() { return choice.page?.id === page.id ? choice.via : via; } });
    const context = { ...base, signal: controller.signal, page: identity };
    try {
      const shared: Record<string, unknown> = {};
      for (const name of page.shared) shared[name] = load(`shared/${name}.js`, sharedSetups.get(name)!, Object.freeze({ ...context, shared: Object.freeze({ ...shared }) }), disposers);
      const definition = load(`pages/${page.id}.js`, setups.get(page.id)!, Object.freeze({ ...context, shared: Object.freeze({ ...shared }) }), disposers);
      if (!object(definition) || (!object(definition.actions) && typeof definition.actions !== "function")) throw new Error(`Bridge page "${page.id}" must return { actions }.`);
      active = { page, actions: definition.actions as Actions | (() => Actions), controller, disposers };
    } catch (error) {
      controller.abort(); cleanup(disposers);
      throw error;
    }
  }
  const reason = (error: unknown) => error instanceof Error && error.message ? error.message.slice(0, 500) : "Page script failed.";
  /** A broken page is unloaded and stays unloaded until recognition selects a different page; it is never retried in a loop. */
  function fail(page: WebsiteBridgeRuntimePage, error: unknown) {
    if (active?.page.id === page.id) deactivate();
    failure = { id: page.id, message: reason(error) };
  }
  /** Re-reads recognition and swaps page scripts when the selected page changes. */
  function sync() {
    const next = choose();
    choice = next;
    const target = next.page?.id ?? null;
    if ((active?.page.id ?? null) === target || (!active && failure?.id === target) || (!next.page && !active)) return;
    deactivate();
    failure = null;
    if (!next.page) return;
    try { activate(next.page, next.via); }
    catch (error) { fail(next.page, error); }
  }
  function hash(input: string) {
    let n = 2166136261;
    for (let i = 0; i < input.length; i++) n = Math.imul(n ^ input.charCodeAt(i), 16777619);
    return (n >>> 0).toString(16).padStart(8, "0");
  }
  function declaredActions(page: Active) {
    const actions = new Map<string, Action>();
    const declared = typeof page.actions === "function" ? page.actions() : page.actions;
    if (!object(declared)) throw new Error(`Bridge page "${page.page.id}" must declare an actions object.`);
    for (const [name, action] of Object.entries(declared)) {
      if (!token(name) || !object(action) || typeof action.title !== "string" || !action.title || typeof action.description !== "string" ||
          !object(action.inputSchema) || action.inputSchema.type !== "object" || typeof action.run !== "function") throw new Error(`Bridge page "${page.page.id}" declares an invalid action.`);
      actions.set(name, action);
    }
    if (actions.size > 128) throw new Error("A page bridge may expose at most 128 actions.");
    return actions;
  }
  /**
   * Page scripts may derive actions from the visible page; the revision follows the selected page and what it declares.
   * An invalid declaration unloads that page (its scripts, modules and listeners) and is reported in the site guide;
   * at install time `strict` fails the whole bridge instead.
   */
  function snapshot(strict = false) {
    sync();
    let actions = new Map<string, Action>();
    if (active) {
      try { actions = declaredActions(active); }
      catch (error) {
        if (strict) throw error;
        fail(active.page, error);
      }
    }
    const fingerprint = JSON.stringify([active?.page.id ?? null, choice.status, choice.candidates, failure,
      [...actions].map(([name, action]) => [name, action.title, action.description, action.inputSchema]).sort((a, b) => a[0] < b[0] ? -1 : 1)]);
    return { actions, revision: `${config.revision.slice(0, 32)}.${hash(fingerprint)}` };
  }
  /** AWCP v1 has no page field; the recognized page is described in the site guide. */
  function site() {
    const page = active?.page ?? null;
    const lines = [config.site.description];
    // A lone unnamed page chosen by URL needs no introduction; named or recognized pages identify themselves.
    if (page && (page.name || choice.status !== "url")) lines.push(`Current page: ${page.name ?? page.id} (${page.id})${choice.via ? `, matched by ${choice.via}` : ""}.`);
    if (page?.description) lines.push(page.description);
    if (choice.status === "unmatched") lines.push("No registered page matched; only actions that do not depend on page recognition are available.");
    if (choice.status === "ambiguous") lines.push(`Several pages matched (${choice.candidates.join(", ")}); their actions are withheld.`);
    if (failure) lines.push(`Page ${failure.id} failed to load: ${failure.message}`);
    const description = lines.filter(Boolean).join("\n\n").slice(0, 16 * 1024);
    return { name: config.site.name, description: description || config.site.name };
  }
  // The page selected at install time must load; a broken bridge never leaves partial state.
  try {
    choice = choose();
    if (choice.page) activate(choice.page, choice.via);
    snapshot(true);
  } catch (error) { state.dispose(); throw error; }
  for (const type of ["hashchange", "popstate"]) {
    const listener = () => { try { if (!disposed) sync(); } catch { /* The next manual read reports the page state. */ } };
    window.addEventListener(type, listener);
    listeners.push([type, listener]);
  }

  const available = () => !disposed && location.origin === config.origin && location.pathname === config.pathname;
  const fail = (request: Request, code: string, message: string, details?: unknown) => ({
    ok: false, requestId: request.requestId, action: request.action,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
  function validate(schema: Schema, value: unknown, path: (string | number)[], errors: FieldError[]) {
    const invalid = (message: string) => { errors.push({ path, messages: [message] }); };
    if (schema.type === "object") {
      if (!object(value)) return invalid("Expected an object.");
      const properties = schema.properties ?? {};
      for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) errors.push({ path: [...path, name], messages: ["Required field."] });
      for (const [name, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, name)) validate(properties[name], item, [...path, name], errors);
        else if (schema.additionalProperties !== true) errors.push({ path: [...path, name], messages: ["Unknown field."] });
      }
    } else if (schema.type === "array") {
      if (!Array.isArray(value)) return invalid("Expected an array.");
      if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 1000)) invalid("Array length is out of range.");
      if (schema.uniqueItems && new Set(value).size !== value.length) invalid("Items must be unique.");
      value.forEach((item, index) => { if (schema.items) validate(schema.items, item, [...path, index], errors); });
    } else if (schema.type === "integer" || schema.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)) ||
          (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return invalid("Expected a number in the declared range.");
    } else if (schema.type === "boolean") {
      if (typeof value !== "boolean") return invalid("Expected a boolean.");
    } else if (schema.type === "string") {
      if (typeof value !== "string") return invalid("Expected a string.");
      if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 100000)) invalid("String length is out of range.");
    }
    if (schema.enum && !schema.enum.includes(value)) invalid("Expected one of the declared enum values.");
  }
  api = Object.freeze({
    protocolVersion: 1,
    manual(request: Record<string, unknown> = {}) {
      if (!object(request)) throw new TypeError("AWCP manual requires an object.");
      const keys = Object.keys(request).sort().join(",");
      if (keys !== "" && (keys !== "revision,section" || !token(request.section) || !token(request.revision))) throw new TypeError("Invalid AWCP manual envelope.");
      if (!available()) throw new Error("The website bridge is outside its page rule.");
      const current = snapshot();
      if (!keys) return JSON.parse(JSON.stringify({ revision: current.revision, site: site(),
        sections: [...current.actions].map(([section, { title }]) => ({ section, title })).sort((a, b) => a.section < b.section ? -1 : 1) }));
      const section = request.section as string;
      if (request.revision !== current.revision) return { error: { code: "stale_revision", section, message: "Read the current directory." } };
      const definition = current.actions.get(section);
      if (!definition) return { error: { code: "section_not_found", section, message: "Section is unavailable." } };
      return JSON.parse(JSON.stringify({ revision: current.revision, section, description: definition.description, inputSchema: definition.inputSchema }));
    },
    async invoke(request: Request) {
      if (!object(request) || Object.keys(request).sort().join(",") !== "action,args,requestId,revision" ||
          !token(request.requestId) || !token(request.revision) || !token(request.action) || !object(request.args)) throw new TypeError("Invalid AWCP invocation envelope.");
      if (!available()) return fail(request, "stale_revision", "Read the current page directory.");
      let current: ReturnType<typeof snapshot>;
      try { current = snapshot(); } catch { return fail(request, "execution_failed", "The page bridge could not read its current actions.", { executionStarted: false }); }
      if (request.revision !== current.revision) return fail(request, "stale_revision", "Read the current page directory.");
      const definition = current.actions.get(request.action);
      if (!definition) return fail(request, "action_not_found", "Action is unavailable.");
      if (seen.has(request.requestId)) return fail(request, "duplicate_request", "Request ID was already used in this document.");
      const fieldErrors: FieldError[] = [];
      validate(definition.inputSchema, request.args, [], fieldErrors);
      if (fieldErrors.length) return fail(request, "invalid_arguments", "Arguments do not match the section Schema.", { executionStarted: false, fieldErrors });
      if (seen.size >= 10000) return fail(request, "execution_failed", "Document request limit reached; reload before continuing.", { executionStarted: false });
      seen.add(request.requestId);
      const run = new AbortController();
      let timedOut = false;
      let interrupt!: (response: unknown) => void;
      // Cancellation answers at once; a slow page handler cannot hold the caller.
      const interrupted = new Promise<unknown>(done => { interrupt = done; });
      const entry = { cancel() {
        run.abort();
        interrupt(fail(request, "cancelled", "Cancelled; changes the page already started are not rolled back. Reconcile before retrying a write."));
      } };
      pending.set(request.requestId, entry);
      const timer = setTimeout(() => {
        timedOut = true; run.abort();
        interrupt(fail(request, "execution_failed", "The action timed out; reconcile page state before retrying a write."));
      }, 30000);
      const execution = (async () => definition.run(request.args, run.signal))().then(response => {
        if (!object(response) || typeof response.ok !== "boolean") return fail(request, "execution_failed", "The bridge action returned an invalid result.");
        return { ...response, requestId: request.requestId, action: request.action };
      }, (error: unknown) => fail(request, run.signal.aborted && !timedOut ? "cancelled" : "execution_failed",
        error instanceof Error && error.message ? error.message.slice(0, 1000) : "The bridge action failed; do not automatically replay writes."));
      try { return await Promise.race([execution, interrupted]); }
      finally { clearTimeout(timer); if (pending.get(request.requestId) === entry) pending.delete(request.requestId); }
    },
    cancel(requestId: string) {
      const entry = pending.get(requestId);
      if (!entry) return false;
      entry.cancel(); return true;
    },
  });
  root.awcp = api;
  root[key] = state;
  window.addEventListener("pagehide", state.dispose, { once: true });
}
