// Run after build:main:types: electron qa/webapp-execute-electron-smoke.cjs [--hold-ms 310000]
// Uses Chromium pages/default net.fetch and the real Broker over a local WS v2 fixture.
const { app, BrowserWindow, net } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { AgentPlatformAssistantBridge } = require('../dist-electron/main/modules/agent-platform/bridge');
const { startDesktopActionBridge, stopDesktopActionBridge } = require('../dist-electron/main/modules/desktop-actions/action-http-server');
const { writeDesktopActionBridgeSettingsConfig } = require('../dist-electron/main/modules/desktop-actions/settings');
const { issueWebappActionToken, revokeWebappActionToken } = require('../dist-electron/main/modules/webs/webapps/action-tokens');
const { startWebappGateway } = require('../dist-electron/main/modules/webs/webapps/gateway');
const { request: ordinaryPlatformRequest } = require('../dist-electron/main/modules/desktop-actions/webapp-platform-client');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-electron-'));
for (const name of ['userData', 'sessionData']) { const dir = path.join(tmp, name); fs.mkdirSync(dir); app.setPath(name, dir); }
app.commandLine.appendSwitch('disable-gpu');
const holdIndex = process.argv.indexOf('--hold-ms');
const holdMs = holdIndex >= 0 ? Number(process.argv[holdIndex + 1]) : 0;
if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > 480000) throw Error('Invalid hold interval');
const windows = []; const gateways = []; const tokens = [];
let platformServer, wsServer, actionServer, assistantBridge;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 5000) {
  const started = Date.now();
  while (!await predicate()) { if (Date.now() - started > timeout) throw Error('Timed out: ' + label); await pause(10); }
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  const executions = new Map(); const interrupts = []; const sockets = new Set(); let closed = 0;
  let token = 'h.' + Buffer.from(JSON.stringify({ sub: 'desktop-smoke', device_id: 'smoke-device' })).toString('base64url') + '.initial';
  platformServer = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ code: 0, data: { items: [] } })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/api/interrupt') {
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      const target = executions.get(body.runId);
      assert.ok(target); assert.equal(body.chatId, target.chatId); assert.equal(body.agentKey, 'executor');
      interrupts.push({ runId: body.runId, at: Date.now() });
      res.end(JSON.stringify({ code: 0, data: { accepted: true, runId: body.runId, status: 'interrupted' } })); return;
    }
    assert.equal(req.url, '/api/execute');
    const id = executions.size + 1; const runId = 'run-' + id; const chatId = 'chat-' + id;
    executions.set(runId, { chatId, body, res });
    res.once('close', () => { if (!res.writableFinished) closed++; });
    const frame = JSON.stringify({ frame: 'push', type: 'run.started', data: {
      runId, chatId, requestId: body.requestId, agentKey: body.agentKey, startedAt: Date.now()
    } });
    for (const socket of sockets) socket.send(frame);
  });
  const platformPort = await listen(platformServer); const baseUrl = `http://127.0.0.1:${platformPort}`;
  wsServer = new WebSocketServer({ server: platformServer });
  wsServer.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ frame: 'push', type: 'connected', data: { protocolVersion: 2, sessionId: 'smoke-session', serverTime: Date.now(),
      liveness: { heartbeatIntervalMs: 30000, silenceTimeoutMs: 100000 } } }));
    let sequence = 0;
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ frame: 'push', type: 'heartbeat', data: {
        sessionId: 'smoke-session', sequence: ++sequence, timestamp: Date.now()
      } }));
    }, 30000); socket.on('close', () => clearInterval(heartbeat));
  });
  const localApp = { getPath: name => path.join(tmp, name) };
  const service = async () => ({ status: 'running', healthMeta: { webUrl: baseUrl, port: platformPort } });
  const issueToken = async () => ({ ok: true, token });
  assistantBridge = new AgentPlatformAssistantBridge({ app: localApp, onEvent() {}, getServiceState: service, issueAccessToken: issueToken,
    getDesktopDeviceId: () => 'smoke-device', createWebSocket: url => new WebSocket(url), ports: {
      toDesktopPetAgentOptions: () => [], resolveAssistantAttachmentPath: () => '/unused', resolveAssistantChatFile: () => '/unused',
      readNavigationAgents: async () => [], readCopilotAgents: async () => []
    } });
  const preflight = new AbortController(); const release = assistantBridge.observeExecuteRun('ready', 'executor', () => {}, preflight.signal);
  await waitFor(() => sockets.size === 1, 'Primary connected'); await pause(100); release();
  const probe = http.createServer(); const actionPort = await listen(probe); await new Promise(resolve => probe.close(resolve));
  writeDesktopActionBridgeSettingsConfig(localApp, { schemaVersion: 1, port: actionPort });
  const items = []; const runtimes = new Map();
  const options = { app: localApp, assistantBridge, issueAgentAccessToken: issueToken,
    getAssistantSettings: () => ({ desktopHelperAgentKey: 'executor' }), services: { getResponsiveServiceState: service },
    webs: { webappManager: { list: () => items, readUserConfig: () => ({}) }, webappRuntime: { getStatus: (_app, id) => runtimes.get(id) } } };
  actionServer = startDesktopActionBridge(options); await once(actionServer, 'listening');
  for (let i = 0; i < 5; i++) {
    const item = { schemaVersion: 2, id: 'webapp-' + (i + 1).toString(16).padStart(16, '0'), key: 'smoke-' + i,
      label: 'Execute smoke', version: '1.0.0', target: 'any', frontend: { root: 'frontend', index: 'index.html' }, desktopBridge: { version: 2 } };
    const root = path.join(tmp, item.id); fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(root, 'webapp.json'), JSON.stringify(item));
    fs.writeFileSync(path.join(root, 'frontend', 'index.html'), '<!doctype html><title>Execute transport verification</title>');
    items.push(item);
    const pageToken = issueWebappActionToken(item, 'localPageGateway'); tokens.push(pageToken);
    const gateway = await startWebappGateway({ app: localApp, item, webappDir: root, backendUrl: '', pageActionToken: pageToken,
      integrationPorts: { getConfiguredDesktopActionBridgePort: () => actionPort } }); gateways.push(gateway);
    runtimes.set(item.id, { status: 'running', startedAt: i + 1, webUrl: gateway.webUrl });
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    windows.push(window); await window.loadURL(gateway.webUrl);
    await window.webContents.executeJavaScript(`window.results=[]; window.controllers=[];
      window.start = async count => {
        const {assistant} = await import('/__desktop/bridge.js');
        for(let n=0;n<count;n++) {
          const controller=new AbortController(); const index=window.controllers.length; window.controllers.push(controller);
          assistant.execute({message:'Smoke task',input:{app:${i},index},outputSchema:{type:'object'}},{signal:controller.signal})
            .then(value=>window.results[index]={value},error=>window.results[index]={code:error.code});
        }
      }; true;`);
  }
  for (const window of windows.slice(0, 4)) await window.webContents.executeJavaScript('window.start(2)');
  await waitFor(() => executions.size === 8, 'all eight execute requests reached Platform');
  const ordinaryStart = Date.now();
  await ordinaryPlatformRequest(baseUrl, token, '/api/connectors', 'GET');
  const normalLatencyMs = Date.now() - ordinaryStart;
  assert.ok(normalLatencyMs < 2000);
  const actionHealth = await net.fetch(`http://127.0.0.1:${actionPort}/health`, { signal: AbortSignal.timeout(2000) }); assert.equal(actionHealth.status, 200); await actionHealth.body.cancel();
  const ninthStart = Date.now(); await windows[4].webContents.executeJavaScript('window.start(1)');
  await waitFor(async () => (await windows[4].webContents.executeJavaScript('window.results[0]?.code')) === 'app_capacity_exceeded', 'ninth request rejected without queuing', 2000);
  const rejectionLatencyMs = Date.now() - ninthStart; assert.equal(executions.size, 8);
  console.log('Eight requests reached Platform; normal request and ninth-request rejection passed.');
  const heldAt = Date.now();
  while (Date.now() - heldAt < holdMs) { await pause(Math.min(30000, holdMs - (Date.now() - heldAt))); console.log('Execute hold elapsed ms:', Date.now() - heldAt); }
  assert.equal(closed, 0, 'execute sockets closed before cancellation');
  assert.equal(interrupts.length, 0, 'an execution was interrupted before cancellation');
  for (const window of windows.slice(0, 4)) {
    assert.equal(await window.webContents.executeJavaScript('window.results.filter(Boolean).length'), 0, 'page request ended during the hold');
  }
  token = token.replace('.initial', '.refreshed');
  const cancelAt = Date.now(); await windows[0].webContents.executeJavaScript('window.controllers[0].abort()');
  await waitFor(() => interrupts.length >= 1, 'HTTP interrupt during saturation', 2000);
  const expectedRun = [...executions].find(([,entry]) => entry.body.input.app === 0 && entry.body.input.index === 0)?.[0];
  assert.equal(interrupts[0].runId, expectedRun);
  const interruptLatencyMs = interrupts[0].at - cancelAt;
  assert.ok(interruptLatencyMs >= 0 && interruptLatencyMs < 2000);
  await waitFor(() => closed >= 1, 'upstream execute connection closed');
  for (const window of windows.slice(0, 4)) await window.webContents.executeJavaScript('window.controllers.forEach(controller=>controller.abort())');
  await waitFor(() => closed === 8, 'all execute sockets closed');
  await waitFor(() => interrupts.length === 8, 'all correlated Runs interrupted');
  const result = { passed: true, electron: process.versions.electron, platform: process.platform, reachedPlatform: executions.size,
    normalLatencyMs, rejectionLatencyMs, interruptLatencyMs, closed, interrupts: interrupts.length, holdMs };
  fs.mkdirSync(path.join(__dirname, '../build/qa'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../build/qa/webapp-execute-electron.json'), JSON.stringify(result, null, 2));
  console.log('WEBAPP_EXECUTE_ELECTRON_RESULT', JSON.stringify(result));
}).then(async () => { await cleanup(); app.quit(); }).catch(async error => { console.error(error); await cleanup(); app.exit(1); });
async function cleanup() {
  stopDesktopActionBridge(); windows.forEach(window => { if (!window.isDestroyed()) window.destroy(); });
  for (const gateway of gateways) await gateway.close(); tokens.forEach(revokeWebappActionToken);
  assistantBridge?.dispose(); for (const socket of wsServer?.clients ?? []) socket.terminate(); wsServer?.close();
  actionServer?.closeAllConnections(); platformServer?.closeAllConnections(); platformServer?.close();
  if (process.platform === 'win32') {
    // Chromium retains profile lock handles until exit; leave this OS-temp fixture for OS cleanup.
  } else if (process.platform === 'darwin') {
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
