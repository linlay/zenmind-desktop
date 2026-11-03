/* Paste into the Desktop main window or Realtime Inspector DevTools console.
 * Export: copy(JSON.stringify(window.__composerBrokerDiagnostic.export(), null, 2))
 * Stop: window.__composerBrokerDiagnostic.stop()
 */
(() => {
  const api = window.electronAPI?.diagnostics;
  if (!api?.getAgentRealtimeDebugSnapshot) throw new Error("Run in Desktop main window / Realtime Inspector DevTools, not the WebClient guest");
  window.__composerBrokerDiagnostic?.stop();
  const records = [], requestIds = new Set();
  let cursor = 0, stopped = false, pending = false, previousHealth = "";
  const startedAt = new Date().toISOString();
  const routes = new Set(["/api/agent", "/api/connectors", "/api/access-level"]);
  const record = entry => { records.push(entry); if (records.length > 400) records.shift(); console.info("[composer-broker-diagnostic]", JSON.stringify(entry)); };
  async function sample() {
    if (stopped || pending) return;
    pending = true;
    try {
      const snapshot = await api.getAgentRealtimeDebugSnapshot({ afterSequence: cursor });
      const health = { stage: "broker-health", seqRegressionCount: snapshot.broker?.seqRegressionCount,
        seqGapCount: snapshot.broker?.seqGapCount, staleFrameCount: snapshot.broker?.staleFrameCount,
        unknownRequestIdCount: snapshot.broker?.unknownRequestIdCount,
        connections: Object.fromEntries(Object.entries(snapshot.connections || {}).map(([lane, state]) =>
          [lane, { phase: state.phase, generation: state.generation, reconnectCount: state.reconnectCount }])) };
      const healthJson = JSON.stringify(health);
      if (healthJson !== previousHealth) { previousHealth = healthJson; record(health); }
      for (const trace of snapshot.trace || []) {
        cursor = Math.max(cursor, trace.sequence || 0);
        let frame = trace.data;
        // Surface delivery wraps the Platform frame; wire traces contain it directly.
        if (frame?.frame && typeof frame.frame === "object") frame = frame.frame;
        const event = frame?.event;
        if (routes.has(frame?.type) && frame.id) {
          requestIds.add(frame.id);
          if (requestIds.size > 200) requestIds.delete(requestIds.values().next().value);
        }
        if (!routes.has(frame?.type) && !requestIds.has(frame?.id) && !["run.access_level.changed", "run.start"].includes(event?.type)) continue;
        const body = frame?.data?.data || frame?.data || {};
        const data = event || body;
        record({ at: trace.recordedAt, sequence: trace.sequence, layer: trace.layer, direction: trace.direction,
          surfaceId: trace.surfaceId, webContentsId: trace.webContentsId,
          frame: frame?.frame, type: frame?.type, requestId: frame?.id, code: frame?.code,
          requestedAgentKey: frame?.payload?.agentKey, requestedAccessLevel: frame?.payload?.accessLevel,
          requestedRunId: frame?.payload?.runId,
          event: event?.type, seq: event?.seq, runId: data.runId, chatId: data.chatId,
          accepted: data.accepted, status: data.status, accessLevel: data.accessLevel,
          version: data.version ?? data.accessLevelVersion, display: data.display,
          agentKey: body.key,
          connectorIds: Array.isArray(body.connectors) ? body.connectors.map(item => typeof item === "string" ? item : item?.id) : undefined });
      }
    } catch (error) { record({ stage: "capture-error", name: error?.name, code: error?.code }); }
    finally { pending = false; }
  }
  const timer = setInterval(sample, 1000);
  window.__composerBrokerDiagnostic = {
    sample, export: () => ({ startedAt, records: records.slice() }),
    stop: () => { stopped = true; clearInterval(timer); },
  };
  void sample();
  console.info("Broker capture active. Export with copy(JSON.stringify(window.__composerBrokerDiagnostic.export(), null, 2)).");
})();
