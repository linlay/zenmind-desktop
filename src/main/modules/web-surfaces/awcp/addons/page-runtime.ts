import type { AddonField, AwcpAddonRule } from "./types";

/** Serialized into the page main world. Keep all runtime dependencies inside this function. */
export function installAwcpAddon(rule: AwcpAddonRule | null, expectedUrl: string, handlers: Record<string, (args: Record<string, unknown>, signal: AbortSignal) => Promise<{ ok: boolean; result?: unknown; error?: unknown }>> = {}) {
  type Request = { requestId: string; revision: string; action: string; args: Record<string, unknown> };
  type Api = { protocolVersion: number; manual(request?: Record<string, unknown>): unknown; invoke(request: Request): Promise<unknown>; cancel(id: string): boolean };
  const root = globalThis as typeof globalThis & {
    awcp?: Api;
    __zenmindAwcpAddon?: { id: string; version: string; api: Api; dispose(): void };
  };
  // A navigation can race the host's executeJavaScript call.
  if (location.href !== expectedUrl || window.top !== window) return;
  const matches = () => !!rule && location.origin === rule.origin &&
    (location.pathname === rule.pathPrefix || location.pathname.startsWith(rule.pathPrefix + "/"));
  const previous = root.__zenmindAwcpAddon;
  if (!matches()) { previous?.dispose(); return; }
  if (!rule) return;
  if (previous?.id === rule.id && previous.version === rule.version && root.awcp === previous.api) return;
  previous?.dispose();
  // Native AWCP always wins, including unsupported or malformed native entries.
  if (root.awcp !== undefined && root.awcp !== null) return;
  const revision = `${rule.id}:${rule.version}`;
  const actions = new Map(rule.actions.map((item) => [item.action, item]));
  const pending = new Map<string, AbortController>();
  // Never evict completed IDs and accidentally replay a write in this document.
  const seen = new Set<string>();
  let disposed = false;
  const available = () => !disposed && matches();
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
  const fail = (request: Request, code: string, message: string, details?: unknown) => ({
    ok: false, requestId: request.requestId, action: request.action,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
  type FieldError = { path: (string | number)[]; messages: string[] };
  function validate(field: AddonField, value: unknown, path: (string | number)[], errors: FieldError[]) {
    const invalid = (message: string) => errors.push({ path, messages: [message] });
    if (field.type === "array") {
      if (!Array.isArray(value)) { invalid("Expected an array."); return; }
      if (value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 100)) invalid("Array length is out of range.");
      if (field.uniqueItems && new Set(value).size !== value.length) invalid("Items must be unique.");
      value.forEach((item, index) => { if (field.items) validate(field.items, item, [...path, index], errors); });
    } else if (field.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (field.minimum ?? 0) || value > (field.maximum ?? Number.MAX_SAFE_INTEGER)) invalid("Expected an integer in the declared range.");
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") invalid("Expected a boolean.");
    } else {
      if (typeof value !== "string") { invalid("Expected a string."); return; }
      if (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 100000)) invalid("String length is out of range.");
      if (field.enum && !field.enum.includes(value)) invalid("Expected one of the declared enum values.");
    }
  }
  const api: Api = Object.freeze({
    protocolVersion: 1,
    manual(request: Record<string, unknown> = {}) {
      if (!object(request)) throw new TypeError("AWCP manual requires an object.");
      const keys = Object.keys(request).sort().join(",");
      if (keys !== "" && (keys !== "revision,section" || !token(request.section) || !token(request.revision))) throw new TypeError("Invalid AWCP manual envelope.");
      if (!available()) throw new Error("AWCP addon is outside its URL rule.");
      if (!keys) return JSON.parse(JSON.stringify({ revision, site: rule.site,
        sections: [...actions.values()].map(({ action, title }) => ({ section: action, title })).sort((a, b) => a.section < b.section ? -1 : 1) }));
      const section = request.section as string;
      if (request.revision !== revision) return { error: { code: "stale_revision", section, message: "Read the current directory." } };
      const definition = actions.get(section);
      if (!definition) return { error: { code: "section_not_found", section, message: "Section is unavailable." } };
      return JSON.parse(JSON.stringify({ revision, section, description: definition.description, inputSchema: definition.inputSchema }));
    },
    async invoke(request: Request) {
      if (!object(request) || Object.keys(request).sort().join(",") !== "action,args,requestId,revision" ||
          !token(request.requestId) || !token(request.revision) || !token(request.action) || !object(request.args)) throw new TypeError("Invalid AWCP invocation envelope.");
      if (!available() || request.revision !== revision) return fail(request, "stale_revision", "Read the current page directory.");
      const definition = actions.get(request.action);
      if (!definition) return fail(request, "action_not_found", "Action is unavailable.");
      if (seen.has(request.requestId)) return fail(request, "duplicate_request", "Request ID was already used in this document.");
      const fieldErrors: FieldError[] = [];
      for (const key of definition.inputSchema.required) {
        if (!Object.hasOwn(request.args, key)) fieldErrors.push({ path: [key], messages: ["Required field."] });
      }
      for (const [key, value] of Object.entries(request.args)) {
        const field = Object.hasOwn(definition.inputSchema.properties, key) ? definition.inputSchema.properties[key] : undefined;
        if (!field) fieldErrors.push({ path: [key], messages: ["Unknown field."] });
        else validate(field, value, [key], fieldErrors);
      }
      if (fieldErrors.length) return fail(request, "invalid_arguments", "Arguments do not match the section Schema.", { executionStarted: false, fieldErrors });
      if (seen.size >= 10000) return fail(request, "execution_failed", "Document request limit reached; reload before continuing.", { executionStarted: false });
      seen.add(request.requestId);
      const controller = new AbortController();
      pending.set(request.requestId, controller);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
      try {
        if (Object.hasOwn(handlers, request.action)) {
          const response = await handlers[request.action](request.args, controller.signal);
          return { ...response, requestId: request.requestId, action: request.action };
        }
        const args = { ...definition.boundArgs, ...request.args };
        const endpoint = definition.path.replace(/\{([a-zA-Z]+)\}/g, (_match, key: string) => {
          const value = args[key]; delete args[key]; return encodeURIComponent(String(value));
        });
        const url = new URL(rule.apiBasePath + endpoint, rule.origin);
        if (definition.method === "GET") for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
        const response = await fetch(url.href, {
          method: definition.method, credentials: "same-origin", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", ...(definition.method === "POST" ? { "Content-Type": "application/json" } : {}) },
          ...(definition.method === "POST" ? { body: JSON.stringify({ ...definition.bodyDefaults, ...args }) } : {}),
        });
        if (!response.ok) return fail(request, response.status === 401 ? "action.login_required" : response.status === 403 ? "action.forbidden" : "action.http_error",
          response.status === 401 ? "Sign in to the forum in Desktop before retrying." : `Forum API returned HTTP ${response.status}.`, { status: response.status });
        if (!(response.headers.get("content-type") ?? "").includes("application/json")) return fail(request, "execution_failed", "Forum API did not return JSON.");
        const result: unknown = await response.json();
        if (!available() || controller.signal.aborted) return fail(request, "cancelled", "Request cancelled; reconcile server state before retrying a write.");
        if (request.action === "forum.notifications.mark-read") window.dispatchEvent(new Event("forum-notifications-read"));
        return { ok: true, requestId: request.requestId, action: request.action, result };
      } catch {
        return fail(request, controller.signal.aborted && !timedOut ? "cancelled" : "execution_failed",
          timedOut ? "Forum API timed out; reconcile server state before retrying a write." : "Forum request failed or was cancelled; do not automatically replay writes.");
      } finally { clearTimeout(timer); pending.delete(request.requestId); }
    },
    cancel(requestId: string) {
      const controller = pending.get(requestId);
      if (!controller) return false;
      controller.abort(); return true;
    },
  });
  const dispose = () => {
    disposed = true;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    window.removeEventListener("pagehide", dispose);
    if (root.awcp === api) delete root.awcp;
    if (root.__zenmindAwcpAddon?.api === api) delete root.__zenmindAwcpAddon;
  };
  root.awcp = api;
  root.__zenmindAwcpAddon = { id: rule.id, version: rule.version, api, dispose };
  window.addEventListener("pagehide", dispose, { once: true });
}
