import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { patchBrowserUseUpstream, browserUseUpstream } from "../scripts/browser-use-patch.mjs";

// Uses an explicit Chrome-for-Testing binary and a new profile. Never attaches to the user's Chrome.
// Example: BROWSER_USE_TEST_CHROME_FOR_TESTING='/path/to/CfT' node qa/browser-use-observation-benchmark.mjs
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const chrome = option("chrome", process.env.BROWSER_USE_TEST_CHROME_FOR_TESTING);
const extension = path.resolve(option("extension", process.env.BROWSER_USE_TEST_EXTENSION ?? path.join(root, "build/browser-use-fixture/extension")));
const output = path.resolve(option("output", path.join(root, "build/qa/browser-use/observation-benchmark.json")));
const sampleCount = Number(option("samples", "5"));
const warmupCount = Number(option("warmups", "1"));
const counts = [0, 32, 128, 256];
const metricNames = ["snapshotMs", "stateMs", "viewportMs", "metadataMs", "projectionMs", "totalMs",
  "referenceCount", "fieldCount", "fieldReadCount", "fieldResolvedCount", "completed"];
const observeParams = { depth: 20, maxTextLength: 30000, maxElements: 500, viewportOnly: false };
const buttonName = "Apply benchmark action";
const extensionOrigin = `chrome-extension://${browserUseUpstream.extension.id}`;

if (process.argv.includes("--help")) {
  console.log("Usage: node qa/browser-use-observation-benchmark.mjs --chrome=/path/to/Chrome-for-Testing [--extension=/path/to/official-extension] [--samples=5] [--warmups=1] [--output=/path/to/result.json]");
  console.log("Chrome can also come from BROWSER_USE_TEST_CHROME_FOR_TESTING. Samples: 5–100; discarded warmups: 1–10. Uses a new private headless profile and the official extension relay; excludes Main IPC, model, navigation and connection time.");
  process.exit(0);
}

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function page(count, actions) {
  const button = actions ? `<button aria-label="${buttonName}" onclick="document.querySelector('[role=status]').textContent='Completed '+(++window.clicks)">Apply</button><p role="status">Ready</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Owned observation benchmark</title>
<style>body{font:14px system-ui;margin:16px}.fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}label{display:flex;gap:4px}input{width:90px}</style></head>
<body><h1>Observation benchmark</h1>${button}<div class="fields">${Array.from({ length: count }, (_, i) => `<label>Field ${i + 1}<input aria-label="Field ${i + 1}" value="value-${i + 1}"></label>`).join("")}</div>
<script>window.clicks=0</script></body></html>`;
}

async function ownedEvaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(Object.assign(new Error("owned_target_unavailable"), { code: "owned_target_unavailable" })), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("owned_target_timeout"), { code: "owned_target_timeout" })), 5000);
      socket.addEventListener("message", event => {
        const response = JSON.parse(String(event.data));
        if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.error || response.result?.exceptionDetails) reject(Object.assign(new Error("owned_target_failed"), { code: "owned_target_failed" }));
        else resolve(response.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
  } finally {
    socket.close();
  }
}

function quantile(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)].toFixed(3));
}

function summarize(samples) {
  return Object.fromEntries([...metricNames, "requestMs"].map(key => [key, {
    p50: quantile(samples.map(sample => sample[key]), .5),
    p95: quantile(samples.map(sample => sample[key]), .95),
  }]));
}

async function terminateOwnedBrowser(child) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return;
  if (process.platform === "win32") {
    // Only this fixture-owned browser and its children, never a process-name based taskkill.
    await new Promise(resolve => {
      const task = childProcess.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      task.once("exit", resolve); task.once("error", resolve);
    });
  } else if (process.platform === "darwin" || process.platform === "linux") {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

let stage = "preflight";
let directory, server, browserProcess, engine;
let authorization;
const originalSpawn = childProcess.spawn;
try {
  check(chrome && fs.statSync(chrome, { throwIfNoEntry: false })?.isFile(), "chrome_for_testing_required");
  check(Number.isInteger(sampleCount) && sampleCount >= 5 && sampleCount <= 100, "samples_must_be_5_to_100");
  check(Number.isInteger(warmupCount) && warmupCount >= 1 && warmupCount <= 10, "warmups_must_be_1_to_10");
  const extensionManifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
  check(extensionManifest.version === browserUseUpstream.extension.sourceVersion, "extension_version_mismatch");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-observation-benchmark-"));
  const core = path.dirname(require.resolve("playwright-core/package.json"));
  fs.cpSync(core, path.join(directory, "node_modules/playwright-core"), { recursive: true });
  const packageDir = patchBrowserUseUpstream(directory);
  const api = require(path.join(packageDir, "lib/coreBundle.js")).__desktopBrowserUse;
  const host = path.join(directory, "host.cjs");
  const engineSource = path.join(root, "src/main/modules/browser-use/chrome-worker-engine.ts");
  const sourceDigests = Object.fromEntries([
    ["engine", engineSource],
    ["projection", path.join(root, "src/main/modules/browser-use/chrome-observation.ts")],
    ["adapter", path.join(root, "scripts/browser-use-upstream-adapter.cjs")],
  ].map(([name, file]) => [name, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  require("esbuild").buildSync({
    stdin: { contents: `export { ChromeWorkerEngine } from ${JSON.stringify(engineSource)};`, resolveDir: root },
    bundle: true, platform: "node", format: "cjs", packages: "external", outfile: host, logLevel: "silent",
  });
  const { ChromeWorkerEngine } = require(host);
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const count = Number(url.searchParams.get("fields"));
    if (request.method !== "GET" || url.pathname !== "/fixture" || ![...counts, 255].includes(count)) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(page(count, url.searchParams.get("actions") === "1"));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(directory, "owned-profile"); fs.mkdirSync(profile);
  stage = "owned_browser";
  browserProcess = originalSpawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-mock-keychain",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"], { stdio: "ignore" });
  let browserLaunchFailed = false;
  browserProcess.once("error", () => { browserLaunchFailed = true; });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !browserLaunchFailed && !fs.existsSync(portFile); i++) await delay(25);
  check(!browserLaunchFailed, "owned_browser_launch_failed");
  check(fs.existsSync(portFile), "owned_browser_start_timeout");
  const endpoint = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").split("\n")[0]}`;
  const ownedVersion = await (await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(10000) })).json();
  const chromeVersion = /^(?:HeadlessChrome|Chrome)\/(\d+(?:\.\d+){3})$/u.exec(ownedVersion.Browser)?.[1];
  check(!!chromeVersion, "owned_browser_version_unavailable");
  const target = await (await fetch(`${endpoint}/json/new?${encodeURIComponent(extensionOrigin + "/status.html")}`, { method: "PUT", signal: AbortSignal.timeout(10000) })).json();
  for (let i = 0; i < 200 && !authorization; i++) {
    authorization = await ownedEvaluate(target, "(() => { try { return localStorage.getItem('auth-token'); } catch { return null; } })()");
    if (!authorization) await delay(25);
  }
  check(typeof authorization === "string" && /^[A-Za-z0-9_-]{16,256}$/u.test(authorization), "owned_extension_credential_unavailable");
  let launchFailed = false;
  childProcess.spawn = (executable, args, options) => {
    const connect = args.find(value => String(value).startsWith(extensionOrigin + "/connect.html?"));
    if (!connect) return originalSpawn(executable, args, options);
    // Redirect only the official connection page into this private test profile. Never log its URL.
    void fetch(`${endpoint}/json/new?${encodeURIComponent(connect)}`, { method: "PUT", signal: AbortSignal.timeout(10000) }).catch(() => { launchFailed = true; });
    return { unref() {} };
  };
  let measurements = [];
  engine = new ChromeWorkerEngine(options => api.create({ ...options, extensionBrowser: { executablePath: chrome, userDataDir: profile } }), {
    onObservationMetrics(value) {
      const sample = Object.fromEntries(metricNames.map(name => [name, value[name]]));
      check(Object.values(sample).every(value => typeof value === "number" && Number.isFinite(value) && value >= 0), "invalid_metrics");
      measurements.push(sample);
    },
  });
  let requestId = 0;
  const request = (method, params, pageId) => engine.request({ id: `benchmark-${++requestId}`, method, params, pageId });
  stage = "official_extension_connection";
  await request("connect", { extensionToken: authorization, clientName: "Owned observation benchmark" });
  authorization = undefined; childProcess.spawn = originalSpawn;
  check(!launchFailed, "owned_extension_page_failed");
  check((await request("list")).length === 0, "unexpected_initial_business_page");
  const cases = [];
  async function measured(operation) {
    measurements = [];
    const started = performance.now();
    const result = await operation();
    const requestMs = performance.now() - started;
    check(measurements.length === 1 && measurements[0].completed === 1, "observation_did_not_complete");
    return { result, sample: { ...measurements[0], requestMs } };
  }
  for (const count of counts) {
    stage = `observe_${count}`;
    const opened = await request("open", { url: `${origin}/fixture?fields=${count}` });
    await request("activate", undefined, opened.pageId);
    const samples = [];
    for (let i = 0; i < warmupCount + sampleCount; i++) {
      const { result, sample } = await measured(() => request("observe", observeParams, opened.pageId));
      check(sample.fieldReadCount === count && sample.fieldResolvedCount === count, "control_count_not_exercised");
      check(!metricNames.some(key => Object.hasOwn(result, key)), "metrics_leaked_to_tool_result");
      if (i >= warmupCount) samples.push(sample);
    }
    cases.push({ operation: "observe", controlCount: count, inputCount: count, summary: summarize(samples), samples });
    await request("close", undefined, opened.pageId);
  }
  stage = "action_with_observation";
  const actionPage = await request("open", { url: `${origin}/fixture?fields=255&actions=1` });
  await request("activate", undefined, actionPage.pageId);
  let observation = await request("observe", observeParams, actionPage.pageId);
  const actionSamples = [];
  for (let i = 0; i < warmupCount + sampleCount; i++) {
    const button = observation.elements.find(element => element.role === "button" && element.name === buttonName);
    check(!!button, "action_button_unavailable");
    const { result, sample } = await measured(() => request("click", { observationId: observation.observationId, ref: button.ref, timeoutMs: 10000 }, actionPage.pageId));
    check(result.action?.outcome === "complete" && result.observation, "action_did_not_complete");
    check(sample.fieldReadCount === 256 && sample.fieldResolvedCount === 256, "action_control_count_not_exercised");
    observation = result.observation;
    if (i >= warmupCount) actionSamples.push(sample);
  }
  cases.push({ operation: "click_with_observation", controlCount: 256, inputCount: 255, summary: summarize(actionSamples), samples: actionSamples });
  const report = {
    schemaVersion: 1, transport: "official-extension-relay", platform: process.platform,
    recordedAtUTC: new Date().toISOString(), arch: process.arch, nodeVersion: process.version,
    chromeVersion, sourceDigests,
    coreVersion: browserUseUpstream.core, extensionVersion: extensionManifest.version,
    samplesPerCase: sampleCount, discardedWarmupsPerCase: warmupCount,
    quantileMethod: "nearest-rank", observationOptions: observeParams,
    scope: "Production engine and adapter over the official relay in an owned headless CfT profile; no Main IPC or model latency; navigation/connection excluded",
    fieldReadCountMeaning: "Attempted per-control metadata evaluations, not a complete count of CDP network messages",
    cases,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ transport: report.transport, coreVersion: report.coreVersion, samplesPerCase: sampleCount,
    cases: cases.map(({ operation, controlCount, summary }) => ({ operation, controlCount, summary })) }, null, 2));
} catch (error) {
  // Upstream messages can contain a connection URL or credential. Emit only a fixed stage and safe code.
  const code = typeof error?.code === "string" && /^[a-zA-Z0-9_]{1,80}$/u.test(error.code) ? error.code : "benchmark_failed";
  console.error(JSON.stringify({ status: "failed", stage, code }));
  process.exitCode = 1;
} finally {
  authorization = undefined; childProcess.spawn = originalSpawn;
  await engine?.disconnect().catch(() => {});
  await terminateOwnedBrowser(browserProcess);
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 10 : 0, retryDelay: 100 });
}
