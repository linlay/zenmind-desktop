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
};
type Setup = (context: unknown) => unknown;

/**
 * Serialized into the page main world. Keep all runtime dependencies inside this function.
 * It owns the AWCP v1 protocol; package features only declare business actions.
 */
export function installWebsiteBridgeRuntime(config: WebsiteBridgeRuntimeConfig, shared: Setup | null, features: Array<{ name: string; setup: Setup }>) {
  type Schema = {
    type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[];
    minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; uniqueItems?: boolean;
  };
  type Action = { title: string; description: string; inputSchema: Schema; run(args: Record<string, unknown>, signal: AbortSignal): unknown };
  type Actions = Record<string, Action>;
  type Request = { requestId: string; revision: string; action: string; args: Record<string, unknown> };
  type Api = { protocolVersion: number; manual(request?: Record<string, unknown>): unknown; invoke(request: Request): Promise<unknown>; cancel(id: string): boolean };
  type FieldError = { path: (string | number)[]; messages: string[] };
  const key = "__zenmindWebsiteBridge";
  const root = globalThis as typeof globalThis & { awcp?: Api } & Record<typeof key, { revision: string; dispose(): void } | undefined>;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
  const controller = new AbortController();
  const pending = new Map<string, { cancel(): void }>();
  // Never evict completed IDs and accidentally replay a write in this document.
  const seen = new Set<string>();
  const disposers: Array<() => void> = [];
  let disposed = false;
  let api: Api | undefined;
  const state = { revision: config.revision, dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of [...pending.values()]) entry.cancel();
    pending.clear();
    controller.abort();
    window.removeEventListener("pagehide", state.dispose);
    for (const cleanup of disposers.reverse()) {
      try { cleanup(); } catch { /* A faulty cleanup must not block the next page bridge. */ }
    }
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
    revision: config.revision, signal: controller.signal, resolve,
  };
  const loaded: Array<{ name: string; actions: Actions | (() => Actions) }> = [];
  function load(name: string, setup: Setup, context: unknown) {
    const definition = setup.call(window, context);
    if (object(definition) && typeof definition.then === "function") throw new Error(`Bridge script "${name}" must be synchronous.`);
    if (object(definition) && typeof definition.dispose === "function") disposers.push(() => (definition.dispose as () => void)());
    return definition;
  }
  function hash(input: string) {
    let n = 2166136261;
    for (let i = 0; i < input.length; i++) n = Math.imul(n ^ input.charCodeAt(i), 16777619);
    return (n >>> 0).toString(16).padStart(8, "0");
  }
  const dynamic = () => loaded.some(feature => typeof feature.actions === "function");
  let cached: { actions: Map<string, Action>; revision: string } | undefined;
  /** Features may derive actions from the visible page; the revision then follows what they declare. */
  function snapshot() {
    if (cached) return cached;
    const actions = new Map<string, Action>();
    for (const feature of loaded) {
      const declared = typeof feature.actions === "function" ? feature.actions() : feature.actions;
      if (!object(declared)) throw new Error(`Bridge feature "${feature.name}" must declare an actions object.`);
      for (const [name, action] of Object.entries(declared)) {
        if (!token(name) || !object(action) || typeof action.title !== "string" || !action.title || typeof action.description !== "string" ||
            !object(action.inputSchema) || action.inputSchema.type !== "object" || typeof action.run !== "function") throw new Error(`Bridge feature "${feature.name}" declares an invalid action.`);
        if (actions.has(name)) throw new Error(`Bridge action "${name}" is declared by more than one feature.`);
        actions.set(name, action);
      }
    }
    if (actions.size > 128) throw new Error("A page bridge may expose at most 128 actions.");
    if (!dynamic()) return cached = { actions, revision: config.revision };
    const fingerprint = JSON.stringify([...actions].map(([name, action]) => [name, action.title, action.description, action.inputSchema]).sort((a, b) => a[0] < b[0] ? -1 : 1));
    return { actions, revision: `${config.revision.slice(0, 32)}.${hash(fingerprint)}` };
  }
  try {
    const sharedValue = shared ? load("shared.js", shared, Object.freeze({ ...base })) : undefined;
    const context = Object.freeze({ ...base, shared: sharedValue });
    for (const feature of features) {
      const definition = load(feature.name, feature.setup, context);
      if (!object(definition) || (!object(definition.actions) && typeof definition.actions !== "function")) throw new Error(`Bridge feature "${feature.name}" must return { actions }.`);
      loaded.push({ name: feature.name, actions: definition.actions as Actions | (() => Actions) });
    }
    snapshot();
  } catch (error) { state.dispose(); throw error; }

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
      if (!keys) return JSON.parse(JSON.stringify({ revision: current.revision, site: config.site,
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
