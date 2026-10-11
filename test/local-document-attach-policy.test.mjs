import test from "node:test";
import assert from "node:assert/strict";
import { prepareWebviewAttachPreferences } from "../dist-electron/main/modules/shell/webview-attach-policy.js";
import { CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } from "../dist-electron/shared/chat-work-panel.js";

function input(platform) {
  const url = `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://opaque-document/report.html`;
  const partition = "local-document-opaque-document";
  return {
    params: { src: url, partition },
    webPreferences: {
      nodeIntegration: true, nodeIntegrationInSubFrames: true, nodeIntegrationInWorker: true,
      contextIsolation: false, sandbox: false, webSecurity: false,
      webviewTag: true, allowRunningInsecureContent: true,
    },
    servicePreloadPath: platform === "win32" ? "C:\\app\\preload\\service-webview.js" : "/app/preload/service-webview.js",
    servicePreloadUrl: "file:///app/preload/service-webview.js",
    isSafeServiceUrl: () => true,
    isLocalDocumentPreview: (candidate, candidatePartition) => candidate === url && candidatePartition === partition,
  };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform} registered local document guest has only a fixed network guard and no Node or nested guests`, () => {
    const request = input(platform);
    assert.equal(prepareWebviewAttachPreferences(request).ok, true);
    assert.deepEqual(request.webPreferences, {
      preload: request.servicePreloadPath.replace(/service-webview\.js$/u, "local-document-network.js"),
      nodeIntegration: false, nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, allowRunningInsecureContent: false,
    });
  });

  test(`${platform} local document mount rejects forged URL, partition, preload and missing registry authorization`, () => {
    for (const mutate of [
      request => { request.params.src = "https://example.com"; },
      request => { request.params.partition = "local-document-another-file"; },
      request => { request.params.preload = request.servicePreloadUrl; },
      request => { request.webPreferences.preload = request.servicePreloadPath; },
      request => { delete request.isLocalDocumentPreview; },
    ]) {
      const request = input(platform);
      mutate(request);
      assert.equal(prepareWebviewAttachPreferences(request).ok, false);
    }
  });
}
