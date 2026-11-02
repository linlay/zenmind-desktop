/* Paste into the Agent WebClient guest DevTools console while the issue is visible.
 * Read-only React/DOM snapshots and connector HTTP response metadata. No reload.
 * Export: copy(JSON.stringify(window.__composerDiagnostic.export(), null, 2))
 * Stop: window.__composerDiagnostic.stop()
 */
(() => {
  if (typeof window === "undefined" || typeof document === "undefined") throw new Error("Run in WebClient DevTools");
  window.__composerDiagnostic?.stop();
  const records = [];
  const startedAt = new Date().toISOString();
  const originalFetch = window.fetch;
  let previous = "", stopped = false;
  const errorInfo = error => error && ({ name: error.name, code: error.code, status: error.status, reason: error.reason,
    message: /^(Desktop Platform Frame Port (is not initialized|is closed|closed|disposed)|Agent connector associations are unavailable|DataRequestExecutor is not configured)$/.test(error.message || "") ? error.message : undefined });
  const ids = list => Array.isArray(list) ? list.filter(value => typeof value === "string") : null;
  const levels = values => Object.entries(values || {}).map(([key, level]) => {
    let target = "";
    try { target = JSON.parse(key)[1]; } catch { target = "unparsed"; }
    return { target, level };
  });
  const record = (stage, data) => {
    const entry = { at: new Date().toISOString(), stage, data };
    records.push(entry);
    if (records.length > 400) records.shift();
    console.info("[composer-diagnostic]", JSON.stringify(entry));
  };
  function currentRoot() {
    for (const node of [document.getElementById("root"), document.getElementById("app"), document.body?.firstElementChild]) {
      if (!node) continue;
      const key = Object.keys(node).find(key => key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$"));
      let fiber = key && node[key];
      if (!fiber) continue;
      while (fiber.return) fiber = fiber.return;
      if (fiber.stateNode?.current) return fiber.stateNode.current;
    }
    return null;
  }
  function hooks(fiber) {
    const result = [];
    let hook = fiber.memoizedState;
    for (let index = 0; hook && index < 80; index++, hook = hook.next) {
      const value = hook.memoizedState;
      if (value === null || typeof value === "boolean" || typeof value === "number") result.push({ index, value });
      else if (value instanceof Error) result.push({ index, error: errorInfo(value) });
      else if (Array.isArray(value) && value.every(item => typeof item === "string")) result.push({ index, ids: value });
      else if (Array.isArray(value) && value.length && value.every(item => item && typeof item.id === "string"))
        result.push({ index, connectors: value.map(item => ({ id: item.id, readiness: item.readiness })) });
    }
    return result;
  }
  function sample(label = "state") {
    if (stopped) return;
    const root = currentRoot();
    const data = { reactRootFound: !!root, path: location.pathname, app: null, composers: [] };
    const pending = root ? [root] : [];
    for (let count = 0; pending.length && count < 50000; count++) {
      const fiber = pending.pop(), props = fiber.memoizedProps;
      if (fiber.sibling) pending.push(fiber.sibling);
      if (fiber.child) pending.push(fiber.child);
      const state = props?.value?.state;
      if (!data.app && state && Array.isArray(state.agents) && state.agentAvailability) {
        const active = state.currentChatActiveRun;
        data.app = {
          chatId: state.chatId, runId: state.runId,
          agents: state.agents.map(agent => ({ key: agent.key, connectors: ids(agent.connectors), availability: state.agentAvailability[agent.key] })),
          accessLevelByChatId: levels(state.accessLevelByChatId),
          newChatAccessLevelByAgentKey: levels(state.newChatAccessLevelByAgentKey),
          runtimeAccessLevelByChatId: levels(state.runtimeAccessLevelByChatId),
          activeRun: active && { chatId: active.chatId, runId: active.runId, accessLevel: active.accessLevel, version: active.accessLevelVersion },
        };
      }
      // Both the connected Actions wrapper and its presentational child carry these props.
      if (typeof fiber.type === "function" && props && typeof props.onAccessLevelChange === "function" && "currentAgentKey" in props) {
        data.composers.push({ agentKey: props.currentAgentKey, chatId: props.currentChatId,
          accessLevel: props.accessLevel, enabledConnectors: props.enabledConnectors?.map(item => item.id), hooks: hooks(fiber) });
      }
    }
    const json = JSON.stringify(data);
    if (label !== "state" || json !== previous) { previous = json; record(label, data); }
    return data;
  }
  async function diagnosticFetch(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url || String(input), location.href);
    const relevant = /^\/api\/(?:agent|connectors(?:\/connection)?)\/?$/.test(url.pathname);
    if (!relevant) return originalFetch.call(this, input, init);
    const started = performance.now();
    record("http.start", { path: url.pathname, method: init?.method || input.method || "GET", agentKey: url.searchParams.get("agentKey") });
    try {
      const response = await originalFetch.call(this, input, init);
      record("http.response", { path: url.pathname, status: response.status, elapsedMs: Math.round(performance.now() - started) });
      // Clone only diagnostic reads. Never inspect credential or configuration writes.
      if ((init?.method || input.method || "GET").toUpperCase() === "GET") {
        void response.clone().json().then(body => {
          const value = body?.data || body;
          record("http.data", { path: url.pathname, code: body?.code, agentKey: value?.key,
            associations: ids(value?.connectors),
            catalog: Array.isArray(value?.connectors) ? value.connectors.filter(item => item && typeof item.id === "string").map(item => ({ id: item.id, readiness: item.readiness })) : undefined,
            connections: value?.connections?.map(item => ({ id: item.connectorId, configured: item.configured,
              configurationRequired: item.configurationRequired, readiness: item.readiness, authStatus: item.authentication?.status })) });
        }).catch(error => record("http.decode-error", errorInfo(error)));
      }
      return response;
    } catch (error) { record("http.error", { path: url.pathname, error: errorInfo(error) }); throw error; }
  }
  window.fetch = diagnosticFetch;
  const timer = setInterval(() => sample(), 500);
  window.__composerDiagnostic = {
    sample: label => sample(label || "manual"),
    export: () => ({ startedAt, records: records.slice() }),
    stop: () => { stopped = true; clearInterval(timer); if (window.fetch === diagnosticFetch) window.fetch = originalFetch; },
  };
  sample("installed");
  console.info("Capture active. Reproduce without reloading, then copy(JSON.stringify(window.__composerDiagnostic.export(), null, 2)). Stop with window.__composerDiagnostic.stop().");
})();
