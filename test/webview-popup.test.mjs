import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getWebviewBlobPopupHostname,
  isBlobSchemeUrl,
  normalizeWebviewBlobPopupForSource,
  normalizeWebviewBlobPopupUrl,
} = require("../dist-electron/shared/webview-popup.js");
const {
  resolveWebviewOpenDisposition,
  resolveRegisteredWebviewPopupTarget,
} = require("../dist-electron/main/modules/web-surfaces/open-tab.js");

test("popup policy keeps canonical WebApps single-page in both presentations", () => {
  for (const presentationScope of ["main-workspace", "workpanel"]) {
    assert.equal(resolveRegisteredWebviewPopupTarget({ surfaceType: "webapp", presentationScope }), null);
  }
  assert.equal(resolveRegisteredWebviewPopupTarget({ surfaceType: "chat-work-panel" }), "work-panel");
  assert.equal(resolveRegisteredWebviewPopupTarget({ surfaceType: "website", active: false }), "desktop-browser");
  assert.equal(resolveRegisteredWebviewPopupTarget(null), null);
});

test("Blob popup URLs require a non-opaque HTTP(S) creator origin", () => {
  const valid = "blob:https://example.test/1c5f9ca2-49ab-472c-b705-62f95df674d4";
  assert.equal(normalizeWebviewBlobPopupUrl(valid), valid);
  assert.equal(getWebviewBlobPopupHostname(valid), "example.test");
  assert.equal(isBlobSchemeUrl(valid), true);
  assert.equal(resolveWebviewOpenDisposition(valid), "blob");

  for (const invalid of [
    "blob:null/opaque",
    "blob:file:///tmp/document.pdf/id",
    "blob:https://user:password@example.test/document",
    "blob:javascript:alert(1)",
    "blob:garbage",
    `blob:https://example.test/${"x".repeat(8_192)}`,
    "blob:https://example.test/line\nbreak",
    "blob:https://example.test/trailing-newline\n",
  ]) {
    assert.equal(normalizeWebviewBlobPopupUrl(invalid), "", invalid);
    assert.notEqual(resolveWebviewOpenDisposition(invalid), "blob", invalid);
  }
});

test("Blob popup URLs must match their trusted opener origin", () => {
  const valid = "blob:https://example.test/1c5f9ca2-49ab-472c-b705-62f95df674d4";
  assert.equal(
    normalizeWebviewBlobPopupForSource(valid, "https://example.test/page"),
    valid,
  );
  assert.equal(
    normalizeWebviewBlobPopupForSource(
      valid,
      "https://outer.test/page",
      "https://example.test/frame",
    ),
    valid,
  );
  assert.equal(
    normalizeWebviewBlobPopupForSource(valid, "https://other.test/page"),
    "",
  );
  assert.equal(
    normalizeWebviewBlobPopupForSource(
      valid,
      "https://example.test/page",
      "https://other.test/frame",
    ),
    "",
  );
});

test("Blob descendants retain their HTTP(S) creator origin", () => {
  const sourceBlobUrl = "blob:https://example.test/1c5f9ca2-49ab-472c-b705-62f95df674d4";
  const descendantBlobUrl = "blob:https://example.test/6cfe1b9f-c021-45f3-b21e-33190f2eea72";
  assert.equal(
    normalizeWebviewBlobPopupForSource(descendantBlobUrl, sourceBlobUrl),
    descendantBlobUrl,
  );
  assert.equal(
    normalizeWebviewBlobPopupForSource(descendantBlobUrl, sourceBlobUrl, sourceBlobUrl),
    descendantBlobUrl,
  );
  assert.equal(
    normalizeWebviewBlobPopupForSource(
      "blob:https://other.test/6cfe1b9f-c021-45f3-b21e-33190f2eea72",
      sourceBlobUrl,
    ),
    "",
  );
});
